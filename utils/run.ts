// The tracer bullet (issue #8): a Run as an ordinary function over the seam's four ports —
// portal, archive, store and clock (issue #1's Implementation Decisions → The seam). Files the
// first Document that is not yet Filed and stops; no paging beyond what `portal.listDocuments`
// already does, no throttling loop, no report — those are later issues.

import type { ArchivePort } from './archive';
import { archivePath } from './archive';
import type { Clock } from './clock';
import { unpackExport } from './export';
import { planFiling, prilogFilename, resolvePartyName, type PartyNameCandidate } from './filing';
import type { DocumentRow } from './portal';
import type { Settings } from './store';

/** Raised when a Document the Run has already selected turns out to be missing a field filing
 * needs. `portal.listDocuments`'s own parsing (utils/portal.ts) checks only the five fields
 * every Run needs; the rest — `datumZaprimanja`, `brojPriloga`, `kupac` — are checked here,
 * loudly, rather than defaulted (the project-wide bias: fail loudly, never fill in a guess). */
export class RunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunError';
  }
}

/** The `portal` port as the Run sees it: list every Document once (paging is `listDocuments`'s
 * concern, not the Run's) and fetch one Document's Export. The real implementation relays both
 * calls to the content script (ADR-0005); a fake serves canned data for tests. */
export interface RunPortalPort {
  listDocuments(): Promise<{ recordsTotal: number; rows: DocumentRow[] }>;
  exportDocument(id: number): Promise<ArrayBuffer>;
}

/** The `store` port as the Run sees it: Settings plus the Filed set. The real implementation is
 * utils/store.ts's module-level functions, composed into this shape at the call site. */
export interface RunStore {
  getSettings(): Promise<Settings>;
  isFiled(id: number): Promise<boolean>;
  markFiled(id: number, filedAt: number): Promise<void>;
}

export interface RunPorts {
  portal: RunPortalPort;
  archive: ArchivePort;
  store: RunStore;
  clock: Clock;
}

export type RunOneResult =
  | { filed: false }
  | { filed: true; documentId: number; directory: readonly string[]; filenames: readonly string[] };

function requireNumberField(row: DocumentRow, field: string): number {
  const value = row[field];
  if (typeof value !== 'number') {
    throw new RunError(`Document ${row.id} is missing a numeric ${field}`);
  }
  return value;
}

interface Subject {
  oib: string;
  naziv: string;
}

function requireSubject(row: DocumentRow, field: 'dobavljac' | 'kupac'): Subject {
  const value = row[field] as Record<string, unknown> | undefined;
  if (typeof value?.oib !== 'string' || typeof value.naziv !== 'string') {
    throw new RunError(`Document ${row.id} is missing ${field}.oib or ${field}.naziv`);
  }
  return { oib: value.oib, naziv: value.naziv };
}

/** Every row's `naziv` for the given party OIB, across the whole list — the candidates
 * `resolvePartyName` (ADR-0008) picks the lowest-`id` one from. Requires the full history, not
 * a window, which is exactly what `portal.listDocuments` already provides (no date filter).
 *
 * A row that does not carry this OIB is skipped rather than validated — a malformed row
 * unrelated to today's target must not abort the whole Run ("a failure to stop only its own
 * Document", issue #1). Only a row that *does* match the OIB and lacks a usable `naziv` fails
 * loudly, because then the folder name genuinely cannot be resolved. */
function candidatesFor(rows: readonly DocumentRow[], field: 'dobavljac' | 'kupac', oib: string): PartyNameCandidate[] {
  const candidates: PartyNameCandidate[] = [];
  for (const row of rows) {
    const value = row[field] as Record<string, unknown> | undefined;
    if (typeof value?.oib !== 'string' || value.oib !== oib) continue;
    if (typeof value.naziv !== 'string') {
      throw new RunError(`Document ${row.id} carries ${field}.oib ${oib} but no ${field}.naziv`);
    }
    candidates.push({ id: row.id, naziv: value.naziv });
  }
  if (candidates.length === 0) {
    throw new RunError(`no Document carries ${field}.oib ${oib} — cannot resolve its Archive folder name`);
  }
  return candidates;
}

/** Files the first Document not yet Filed: fetches its Export, unpacks it, and writes the
 * eRačun, the visualisation and every Prilog into the Archive at their deterministic paths
 * (ADR-0004). Marks the Document Filed only once every one of its files is written — an archive
 * write that throws partway through leaves it unmarked, so the next Run retries it whole. */
export async function runOne(ports: RunPorts): Promise<RunOneResult> {
  const { rows } = await ports.portal.listDocuments();

  let target: DocumentRow | undefined;
  for (const row of rows) {
    if (!(await ports.store.isFiled(row.id))) {
      target = row;
      break;
    }
  }
  if (target === undefined) {
    return { filed: false };
  }

  const datumZaprimanja = requireNumberField(target, 'datumZaprimanja');
  const brojPriloga = requireNumberField(target, 'brojPriloga');
  const dobavljac = requireSubject(target, 'dobavljac');
  const kupac = requireSubject(target, 'kupac');

  const settings = await ports.store.getSettings();
  const recipientName = resolvePartyName(candidatesFor(rows, 'kupac', kupac.oib));
  const issuerName = resolvePartyName(candidatesFor(rows, 'dobavljac', dobavljac.oib));

  const plan = planFiling(
    {
      brojDokumenta: target.brojDokumenta,
      datumIzdavanja: target.datumIzdavanja,
      vrstaDokumenta: target.vrstaDokumenta,
      datumZaprimanja,
    },
    { archiveRoot: settings.archiveRoot, recipientName, issuerName },
  );

  const exportBytes = await ports.portal.exportDocument(target.id);
  const unpacked = unpackExport(exportBytes, brojPriloga);

  const filenames = [plan.eracun, plan.visualisation];
  await ports.archive.write(archivePath(plan.directory, plan.eracun), unpacked.eracun);
  await ports.archive.write(archivePath(plan.directory, plan.visualisation), unpacked.visualisation);

  for (const prilog of unpacked.prilozi) {
    const filename = prilogFilename(plan.stem, prilog.name);
    await ports.archive.write(archivePath(plan.directory, filename), prilog.bytes);
    filenames.push(filename);
  }

  await ports.store.markFiled(target.id, ports.clock.now());

  return { filed: true, documentId: target.id, directory: plan.directory, filenames };
}
