// A full Run (issue #9), built on the seam's ports (issue #1's Implementation Decisions →
// The seam) plus `delay` (utils/delay.ts), added for this issue's throttling requirement.
// Walks every Document the `portal` port returns, skips what is already Filed, and fetches
// the rest one at a time with a pause between Exports — never in parallel (HANDOFF,
// "Throttling"). A failure stops only its own Document: caught, recorded, and the walk
// continues, which is what makes a Run resumable — close the tab mid-Run and the next one
// picks up where it stopped, retrying only what never got Filed.
//
// Supersedes the issue #8 tracer bullet, which filed one Document and stopped.

import type { ArchivePort } from './archive';
import { archivePath } from './archive';
import type { Clock } from './clock';
import type { Delay } from './delay';
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

/** The `store` port as the Run sees it: Settings, the Filed set, and the eRačun XML cache. The
 * real implementation is utils/store.ts's module-level functions, composed into this shape at
 * the call site. */
export interface RunStore {
  getSettings(): Promise<Settings>;
  isFiled(id: number): Promise<boolean>;
  markFiled(id: number, filedAt: number): Promise<void>;
  cacheEracun(id: number, bytes: Uint8Array, cachedAt: number): Promise<void>;
  pruneEracunCache(now: number): Promise<void>;
}

export interface RunPorts {
  portal: RunPortalPort;
  archive: ArchivePort;
  store: RunStore;
  clock: Clock;
  delay: Delay;
}

/** The pause between one Export finishing and the next one starting. Small, per HANDOFF — this
 * is a government portal and the extension is headed for public distribution, so it must never
 * look like it is hammering the service. */
export const EXPORT_DELAY_MS = 1000;

export interface FiledDocument {
  documentId: number;
  directory: readonly string[];
  filenames: readonly string[];
}

export interface FailedDocument {
  documentId: number;
  error: string;
}

export interface RunReport {
  filed: FiledDocument[];
  skipped: readonly number[];
  failed: FailedDocument[];
}

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

/** Files one Document: fetches its Export, unpacks it, caches the eRačun bytes, and writes the
 * eRačun, the visualisation and every Prilog into the Archive at their deterministic paths
 * (ADR-0004). Marks the Document Filed only once every one of its files is written — an archive
 * write that throws partway through leaves it unmarked, so the next Run retries it whole. Throws
 * on any failure; the caller decides how a failure affects the rest of the Run. */
async function fileDocument(target: DocumentRow, rows: readonly DocumentRow[], ports: RunPorts): Promise<FiledDocument> {
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

  // Cached at download time, not after a successful Archive write: this is the only surviving
  // copy of these bytes once written (trap 1), so it must not depend on the write succeeding.
  await ports.store.cacheEracun(target.id, unpacked.eracun, ports.clock.now());

  const filenames = [plan.eracun, plan.visualisation];
  await ports.archive.write(archivePath(plan.directory, plan.eracun), unpacked.eracun);
  await ports.archive.write(archivePath(plan.directory, plan.visualisation), unpacked.visualisation);

  for (const prilog of unpacked.prilozi) {
    const filename = prilogFilename(plan.stem, prilog.name);
    await ports.archive.write(archivePath(plan.directory, filename), prilog.bytes);
    filenames.push(filename);
  }

  await ports.store.markFiled(target.id, ports.clock.now());

  return { documentId: target.id, directory: plan.directory, filenames };
}

/** Wraps `portal.exportDocument` so a pause lands between one Export finishing and the next one
 * starting — never before the first one, and never for a Document skipped or failed before an
 * Export was ever requested for it. Ties the throttle strictly to the network operation the
 * Portal actually feels, not to how many Documents the Run happens to walk past. */
function throttled(portal: RunPortalPort, delay: Delay): RunPortalPort {
  let exportedAny = false;
  return {
    listDocuments: () => portal.listDocuments(),
    async exportDocument(id) {
      if (exportedAny) {
        await delay.wait(EXPORT_DELAY_MS);
      }
      exportedAny = true;
      return portal.exportDocument(id);
    },
  };
}

/** A Run (CONTEXT.md): lists the Portal's full filtered window, skips every Document already
 * Filed, and files the rest one at a time. Walks the entire list regardless of order — rows
 * are not relied on to arrive sorted (HANDOFF, "Result order is not a contract"), so a Filed
 * Document appearing before an unfiled one never stops the walk early. One Document's failure
 * is caught and recorded; it never abandons the rest. */
export async function run(ports: RunPorts): Promise<RunReport> {
  const { rows } = await ports.portal.listDocuments();
  await ports.store.pruneEracunCache(ports.clock.now());

  const portal = throttled(ports.portal, ports.delay);
  const runPorts: RunPorts = { ...ports, portal };

  const filed: FiledDocument[] = [];
  const skipped: number[] = [];
  const failed: FailedDocument[] = [];

  for (const row of rows) {
    if (await ports.store.isFiled(row.id)) {
      skipped.push(row.id);
      continue;
    }

    try {
      filed.push(await fileDocument(row, rows, runPorts));
    } catch (error) {
      failed.push({ documentId: row.id, error: (error as Error).message });
    }
  }

  return { filed, skipped, failed };
}
