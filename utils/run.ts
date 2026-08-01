// A full Run (issue #9), built on the seam's ports (issue #1's Implementation Decisions →
// The seam) plus `delay` (utils/delay.ts), added for this issue's throttling requirement.
// Walks every Document the `portal` port returns, skips what is already Filed, and fetches
// the rest one at a time with a pause between Exports — never in parallel (HANDOFF,
// "Throttling"). A failure stops only its own Document: caught, recorded, and the walk
// continues, which is what makes a Run resumable — close the tab mid-Run and the next one
// picks up where it stopped, retrying only what never got Filed.
//
// Supersedes the issue #8 tracer bullet, which filed one Document and stopped.
//
// Issue #32 (ADR-0013): a Document the Filed set reports as unfiled gets one more chance to be
// skipped, cheaply — proven already present in the Archive via the browser's own download
// record (utils/download-record.ts) rather than a Portal request.

import type { ArchivePort } from './archive';
import { archivePath } from './archive';
import type { Clock } from './clock';
import type { Delay } from './delay';
import { knownDocumentTypeCodes, markedTypeForCode } from './document-types';
import type { DownloadRecord, DownloadRecordPort } from './download-record';
import { unpackExport } from './export';
import {
  archiveDirectory,
  documentStem,
  eracunFilename,
  planFiling,
  prilogFilename,
  resolvePartyName,
  visualisationFilename,
  zagrebDate,
  type PartyNameCandidate,
} from './filing';
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
  downloadRecord: DownloadRecordPort;
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

/** A Document named the way the report and live progress (issue #24) show it — by its `broj`
 * and Issuer, never by a bare internal id. `issuerName` is the resolved Archive folder name
 * (ADR-0008) for a filed entry, or the row's own `dobavljac.naziv` for a Document still in
 * flight or one that never reached filing. */
export interface NamedDocument {
  documentId: number;
  broj: string;
  issuerName: string;
}

export interface FailedDocument extends NamedDocument {
  error: string;
}

/** A filed Document whose Datum izdavanja and Datum zaprimanja fall in different Zagreb years
 * (CONTEXT.md, "Year straddle") — surfaced, never filed differently. `filedYear` is the year
 * segment of its Archive directory, so the report can state which year it landed under. */
export interface YearStraddleDocument extends NamedDocument {
  filedYear: number;
}

/** A filed Document typed NEPOZNATO — filed, but the extension could not classify it. */
export type NepoznatoDocument = NamedDocument;

/** A filed Document whose `vrstaDokumenta.code` is not in the shipped table (utils/document-types.ts)
 * at all — not even as a known Marked type. Reported so drift in the Portal's code list is
 * visible rather than silently absorbed into NEPOZNATO (issue #10's acceptance criteria). */
export interface DriftedCode extends NamedDocument {
  code: number;
}

export interface RunReport {
  filed: FiledDocument[];
  skipped: readonly number[];
  failed: FailedDocument[];
  yearStraddles: readonly YearStraddleDocument[];
  nepoznato: readonly NepoznatoDocument[];
  drift: readonly DriftedCode[];
}

function requireNumberField(row: DocumentRow, field: string): number {
  const value = row[field];
  if (typeof value !== 'number') {
    throw new RunError(`Document ${row.id} is missing numeric field ${field}`);
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
      throw new RunError(`Document ${row.id} has ${field}.oib ${oib} but no ${field}.naziv`);
    }
    candidates.push({ id: row.id, naziv: value.naziv });
  }
  if (candidates.length === 0) {
    throw new RunError(`no Document has ${field}.oib ${oib} — the Archive folder name cannot be determined`);
  }
  return candidates;
}

/** The Issuer name a Document is reported under before or without ever reaching a canonical
 * filing decision — the in-flight Document a progress snapshot names, or one whose validation
 * failed before `fileDocument` could resolve anything. Prefers the ADR-0008 resolved name (the
 * same one a filed Document's Archive folder would carry) when the full row list can supply it,
 * falling back to this row's own, possibly drifted, `naziv` when it cannot — display only; a
 * Document actually being filed always resolves canonically inside `fileDocument` and fails
 * loudly if it cannot (ADR-0008's own rule, unrelaxed). */
function bestEffortIssuerName(row: DocumentRow, rows: readonly DocumentRow[]): string {
  try {
    return resolvePartyName(candidatesFor(rows, 'dobavljac', row.dobavljac.oib));
  } catch {
    return row.dobavljac.naziv;
  }
}

interface PartyNames {
  recipientName: string;
  issuerName: string;
}

/** The Recipient's and Issuer's Archive-folder names for a Document (ADR-0008): each resolved
 * from the *lowest-id* Document sharing that party's OIB across the full row list, never the
 * target row's own, possibly drifted, `naziv`. Shared by `fileDocument` and `isAlreadyArchived`
 * so both derive a Document's Archive location the same way. */
function resolvePartyNames(target: DocumentRow, rows: readonly DocumentRow[]): PartyNames {
  const dobavljac = requireSubject(target, 'dobavljac');
  const kupac = requireSubject(target, 'kupac');
  return {
    recipientName: resolvePartyName(candidatesFor(rows, 'kupac', kupac.oib)),
    issuerName: resolvePartyName(candidatesFor(rows, 'dobavljac', dobavljac.oib)),
  };
}

/** ADR-0013's proof, checked only for a Document the Filed set has already said is unfiled —
 * the cheap answer first. Computes the exact Archive path the same way `fileDocument` would,
 * from the Portal listing and Settings alone (ADR-0008's name resolution needs no local state),
 * and asks `downloadRecord` whether every one of that Document's files is already there,
 * complete and still existing.
 *
 * Any field this can't resolve — a missing `kupac` or `brojPriloga`, an OIB with no usable
 * `naziv` — yields `false` rather than throwing: this check only ever costs an unnecessary
 * fetch, never a wrongly skipped Document, and a row that genuinely can't be validated still
 * fails loudly inside `fileDocument`, exactly as before this check existed. */
function isAlreadyArchived(
  target: DocumentRow,
  rows: readonly DocumentRow[],
  settings: Settings,
  downloadRecord: DownloadRecord,
): boolean {
  try {
    const brojPriloga = requireNumberField(target, 'brojPriloga');
    const { recipientName, issuerName } = resolvePartyNames(target, rows);
    const directory = archiveDirectory({
      archiveRoot: settings.archiveRoot,
      recipientName,
      issuerName,
      datumIzdavanja: target.datumIzdavanja,
    });
    const stem = documentStem(target);

    if (!downloadRecord.has(directory, eracunFilename(stem))) return false;
    if (!downloadRecord.has(directory, visualisationFilename(stem))) return false;
    return downloadRecord.countWithPrefix(directory, `${stem}_`) === brojPriloga;
  } catch {
    return false;
  }
}

/** `fileDocument`'s result, carrying the reporting signals (issue #10) alongside the
 * `FiledDocument` the Run report exposes — kept out of `FiledDocument` itself so its shape,
 * already asserted with `toEqual` in tests, does not have to grow. */
interface FileOutcome {
  filed: FiledDocument;
  broj: string;
  issuerName: string;
  yearStraddle: boolean;
  filedYear: number;
  code: number;
  knownCode: boolean;
  nepoznato: boolean;
}

/** Files one Document: fetches its Export, unpacks it, caches the eRačun bytes, and writes the
 * eRačun, the visualisation and every Prilog into the Archive at their deterministic paths
 * (ADR-0004). Marks the Document Filed only once every one of its files is written — an archive
 * write that throws partway through leaves it unmarked, so the next Run retries it whole. Throws
 * on any failure; the caller decides how a failure affects the rest of the Run. */
async function fileDocument(target: DocumentRow, rows: readonly DocumentRow[], ports: RunPorts): Promise<FileOutcome> {
  const datumZaprimanja = requireNumberField(target, 'datumZaprimanja');
  const brojPriloga = requireNumberField(target, 'brojPriloga');
  const { recipientName, issuerName } = resolvePartyNames(target, rows);

  const settings = await ports.store.getSettings();

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

  const code = target.vrstaDokumenta.code;
  return {
    filed: { documentId: target.id, directory: plan.directory, filenames },
    broj: target.brojDokumenta,
    issuerName,
    yearStraddle: plan.yearStraddle,
    filedYear: zagrebDate(target.datumIzdavanja).year,
    code,
    knownCode: knownDocumentTypeCodes().includes(code),
    nepoznato: markedTypeForCode(code) === 'NEPOZNATO',
  };
}

/** Wraps an `exportDocument` function so a pause lands between one Export finishing and the next
 * one starting — never before the first one, and never for a Document skipped or failed before an
 * Export was ever requested for it. Ties the throttle strictly to the network operation the
 * Portal actually feels, not to how many Documents a caller happens to walk past.
 *
 * Exported so Bundle planning's Send-time recovery fetch (issue #31, ADR-0012) can throttle its
 * own Export calls through this same mechanism and constant, rather than growing a second one —
 * both are hitting the same government portal. */
export function throttleExports(
  exportDocument: (id: number) => Promise<ArrayBuffer>,
  delay: Delay,
): (id: number) => Promise<ArrayBuffer> {
  let exportedAny = false;
  return async (id: number) => {
    if (exportedAny) {
      await delay.wait(EXPORT_DELAY_MS);
    }
    exportedAny = true;
    return exportDocument(id);
  };
}

function throttled(portal: RunPortalPort, delay: Delay): RunPortalPort {
  return {
    listDocuments: () => portal.listDocuments(),
    exportDocument: throttleExports((id) => portal.exportDocument(id), delay),
  };
}

/** A live snapshot of a Run in progress (issues #10, #24): which Document's Export is being
 * fetched right now — `null` between Documents, including while a skip-check is happening,
 * named by its `broj` and Issuer rather than its bare id, so a progress bar has both a
 * denominator (`total`) and words for its label. Plus a running total of each outcome so far. */
export interface RunProgress {
  total: number;
  current: NamedDocument | null;
  filed: number;
  skipped: number;
  failed: number;
}

export interface RunOptions {
  /** Restricts the walk to just these Document ids — how the retry-failures action (issue #10)
   * re-runs only what previously failed. `listDocuments()` is still called in full and every
   * row still feeds party-name resolution (ADR-0008); this only filters which rows are
   * skip-checked, filed or failed. */
  documentIds?: readonly number[];
  /** Called after every Document is skipped, filed or failed, and again right before a
   * Document's Export fetch starts — so a caller can show which Document is being fetched now,
   * not just the running totals. */
  onProgress?: (progress: RunProgress) => void;
}

/** A Run (CONTEXT.md): lists the Portal's full filtered window, skips every Document already
 * Filed, and files the rest one at a time. Walks the entire list regardless of order — rows
 * are not relied on to arrive sorted (HANDOFF, "Result order is not a contract"), so a Filed
 * Document appearing before an unfiled one never stops the walk early. One Document's failure
 * is caught and recorded; it never abandons the rest. */
export async function run(ports: RunPorts, options: RunOptions = {}): Promise<RunReport> {
  const { rows } = await ports.portal.listDocuments();
  await ports.store.pruneEracunCache(ports.clock.now());
  // Queried once per Run and indexed here (ADR-0013) — never re-queried inside the loop below.
  const downloadRecord = await ports.downloadRecord.load();
  const settings = await ports.store.getSettings();

  const portal = throttled(ports.portal, ports.delay);
  const runPorts: RunPorts = { ...ports, portal };

  const filed: FiledDocument[] = [];
  const skipped: number[] = [];
  const failed: FailedDocument[] = [];
  const yearStraddles: YearStraddleDocument[] = [];
  const nepoznato: NepoznatoDocument[] = [];
  const drift: DriftedCode[] = [];

  // Filtered up front, rather than skipped row-by-row inside the loop, so `total` (issue #24's
  // progress-bar denominator) reflects exactly the Documents this Run walks — the full list for
  // an ordinary Run, or just the retried ids for a retry-failures Run.
  const documentIdFilter = options.documentIds ? new Set(options.documentIds) : undefined;
  const targetRows = documentIdFilter ? rows.filter((row) => documentIdFilter.has(row.id)) : rows;

  const progress: RunProgress = { total: targetRows.length, current: null, filed: 0, skipped: 0, failed: 0 };
  const emitProgress = () => options.onProgress?.({ ...progress });

  for (const row of targetRows) {
    if (await ports.store.isFiled(row.id)) {
      skipped.push(row.id);
      progress.skipped += 1;
      emitProgress();
      continue;
    }

    // Checked only once the Filed set has already said this Document is unfiled — the cheap
    // answer first (ADR-0013). A Document provably already in the Archive is marked Filed here,
    // without a Portal request ever being made for it, and joins the same `skipped` list as one
    // skipped for being already Filed.
    if (isAlreadyArchived(row, rows, settings, downloadRecord)) {
      await ports.store.markFiled(row.id, ports.clock.now());
      skipped.push(row.id);
      progress.skipped += 1;
      emitProgress();
      continue;
    }

    progress.current = { documentId: row.id, broj: row.brojDokumenta, issuerName: bestEffortIssuerName(row, rows) };
    emitProgress();

    try {
      const outcome = await fileDocument(row, rows, runPorts);
      filed.push(outcome.filed);
      const named = { documentId: outcome.filed.documentId, broj: outcome.broj, issuerName: outcome.issuerName };
      if (outcome.yearStraddle) yearStraddles.push({ ...named, filedYear: outcome.filedYear });
      if (outcome.nepoznato) nepoznato.push(named);
      if (!outcome.knownCode) drift.push({ ...named, code: outcome.code });
      progress.filed += 1;
    } catch (error) {
      failed.push({
        documentId: row.id,
        broj: row.brojDokumenta,
        issuerName: bestEffortIssuerName(row, rows),
        error: (error as Error).message,
      });
      progress.failed += 1;
    }

    progress.current = null;
    emitProgress();
  }

  return { filed, skipped, failed, yearStraddles, nepoznato, drift };
}
