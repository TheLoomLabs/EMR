// The Bundle (issue #12; CONTEXT.md "Bundle"; ADR-0003): one calendar month of one Recipient,
// composed into a `.eml`. Never derived from send history — a re-send is possible and harmless
// (CONTEXT.md) — so this always recomputes from the Portal's current list plus the local eRačun
// cache (utils/store.ts). The cache is a fast path, not the only surviving copy (ADR-0012): a
// Document the cache has no entry for has its Export fetched from the Portal instead, right here
// during planning, rather than refusing.
//
// Two steps, mirroring utils/backfill.ts's plan/act split: `planBundle` queries the Portal for
// roughly the month (docs/portal-api.md, "kraj works"), narrows to the exact Zagreb month
// (trap 8), fills in any cache misses from the Portal (ADR-0012), and reports the attachment set
// and its total size *before* anything is composed — the acceptance criterion that exists because
// a 44-Document month runs to ~7 MB (HANDOFF), and only honest once every byte is already in
// hand. `composeBundle` then turns that plan into `.eml` bytes via utils/eml.ts, which is pure
// and tested on its own.

import { ERACUN_RECEIPT_START } from './backfill';
import type { Clock } from './clock';
import type { Delay } from './delay';
import { unpackExport } from './export';
import { documentStem, eracunFilename, sanitizeSegment, zagrebDate } from './filing';
import { assembleEml } from './eml';
import { widenedFilterParams, withinZagrebWindow, type DocumentRow, type FilterParams, type ListDocumentsResult, type ZagrebWindow } from './portal';
import { throttleExports, type NamedDocument } from './run';
import type { Settings } from './store';

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

export interface BundleMonth {
  year: number;
  month: number; // 1-12
}

/** The `portal` port as planBundle sees it: one already-paged, already-validated listing
 * (utils/portal.ts's `listDocuments`), exactly like utils/backfill.ts's `BackfillPort`, plus a
 * single Document's Export — needed for the ADR-0012 recovery fetch when the cache has no entry.
 * The real implementation is the popup's message relay to the Portal's content script (ADR-0005),
 * the same relay `run()` already uses for `exportDocument`. */
export interface BundlePortalPort {
  listDocuments(filterParams: FilterParams): Promise<ListDocumentsResult>;
  exportDocument(id: number): Promise<ArrayBuffer>;
}

/** The `store` port as planBundle sees it: the eRačun cache, keyed by Document id (utils/store.ts)
 * — a fast path, not the only surviving copy (ADR-0012). `cacheEracun` writes back a Document
 * recovered from the Portal, so a second Send of the same month finds it warm. */
export interface BundleStore {
  getCachedEracun(id: number): Promise<Uint8Array | undefined>;
  cacheEracun(id: number, bytes: Uint8Array, cachedAt: number): Promise<void>;
}

export interface BundlePorts {
  portal: BundlePortalPort;
  store: BundleStore;
  clock: Clock;
  delay: Delay;
}

/** A live snapshot of planning's ADR-0012 recovery fetch: which Document's Export is being
 * fetched right now (`null` between fetches, named the same way `run()`'s own progress does —
 * `NamedDocument`, utils/run.ts — by `broj` and Issuer, never a bare id), a running count of how
 * many of `total` are done, and `total` itself — the number of Documents in the month the cache
 * had no entry for. Never called at all for a month whose cache is fully warm, since nothing is
 * fetched (acceptance: the warm case must not regress). */
export interface BundlePlanProgress {
  total: number;
  current: NamedDocument | null;
  fetched: number;
}

export interface BundlePlanOptions {
  onProgress?: (progress: BundlePlanProgress) => void;
}

export interface BundleDocument {
  documentId: number;
  filename: string;
  bytes: Uint8Array;
}

export interface BundlePlan {
  month: BundleMonth;
  documents: BundleDocument[];
  totalSizeBytes: number;
}

function daysInZagrebMonth(month: BundleMonth): number {
  // UTC arithmetic is fine here — this counts a calendar month's length, not a Zagreb instant.
  return new Date(Date.UTC(month.year, month.month, 0)).getUTCDate();
}

/** The exact Zagreb window a Bundle's month covers — the 1st through the last calendar day,
 * inclusive at both ends. `widenedFilterParams`/`withinZagrebWindow` (utils/portal.ts) do the
 * query-wide-then-narrow dance around the Portal's unresolved bound inclusivity (trap 8,
 * docs/portal-api.md). */
export function bundleWindow(month: BundleMonth): ZagrebWindow {
  return {
    from: { year: month.year, month: month.month, day: 1 },
    to: { year: month.year, month: month.month, day: daysInZagrebMonth(month) },
  };
}

/** English calendar month names (ADR-0011), index 0 = January — shared by `bundleMonthLabel`
 * and the month picker's own grid cells (entrypoints/window/main.ts), so the trigger's label and
 * the grid's cells can never name a month differently. */
export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** A Bundle month's label as the month picker shows it — "July 2026" — English regardless of
 * the rest of the window's Croatian text (ADR-0011: month names are English). */
export function bundleMonthLabel(month: BundleMonth): string {
  return `${MONTH_NAMES[month.month - 1]} ${month.year}`;
}

/** Whether `month` can possibly hold a Document: not before eRačun receipt began
 * (`ERACUN_RECEIPT_START`, utils/backfill.ts — the same floor the first-run backfill anchors to,
 * so the two can never disagree about when history begins) and not after the current month. Both
 * bounds are read in Europe/Zagreb, never UTC (trap 8) — a UTC read puts the ceiling on the wrong
 * month right at a month boundary. The current month itself is reachable. */
export function isReachableBundleMonth(month: BundleMonth, nowEpochMillis: number): boolean {
  const floor = ERACUN_RECEIPT_START;
  if (month.year < floor.year || (month.year === floor.year && month.month < floor.month)) {
    return false;
  }
  const today = zagrebDate(nowEpochMillis);
  return month.year < today.year || (month.year === today.year && month.month <= today.month);
}

/** The range of years the month picker's year stepper can reach: from the year eRačun receipt
 * began through the current Zagreb year — the stepper's arrows disable outside it. Read in
 * Europe/Zagreb, never UTC, same as `isReachableBundleMonth`. */
export function reachableYearRange(nowEpochMillis: number): { min: number; max: number } {
  return { min: ERACUN_RECEIPT_START.year, max: zagrebDate(nowEpochMillis).year };
}

/** Disambiguates two Documents whose stems collide — possible because a stem is date +
 * `brojDokumenta` only (utils/filing.ts), with no Issuer in it. The Archive never hits this
 * (Issuer folders keep them apart, ADR-0008), but a Bundle's attachments are flat, and two
 * different Issuers can genuinely share an invoice number on the same day. Appends the
 * colliding Issuer's OIB rather than the Document's Portal `id` — ADR-0007 is explicit that the
 * `id` "must never appear in ... a filename, where it would leak an internal identifier into
 * [what] the Accountant reads". The OIB disambiguates just as reliably: `(OIB, brojDokumenta,
 * year)` was the identity key before ADR-0007 and "was never wrong", so two Documents sharing
 * both a stem and an Issuer OIB cannot occur. */
function dedupeFilename(filename: string, issuerOib: string, used: Set<string>): string {
  if (!used.has(filename)) {
    used.add(filename);
    return filename;
  }
  const dot = filename.lastIndexOf('.');
  const deduped = dot === -1 ? `${filename}_${issuerOib}` : `${filename.slice(0, dot)}_${issuerOib}${filename.slice(dot)}`;
  used.add(deduped);
  return deduped;
}

/** Fetches and unpacks one Document's Export, keeping only its eRačun bytes — the visualisation
 * and any Prilozi a Send-time Export also carries are discarded (ADR-0012: `Filed` means every
 * one of a Document's files is in the Archive, and a Send-time fetch writes to the Archive at
 * all). Throws `BundleError`, naming the Document, for anything that goes wrong: a missing
 * `brojPriloga`, a Portal fetch failure, or an Export that fails validation — planning must never
 * let one of these through as a silently short invoice. */
async function recoverEracun(row: DocumentRow, exportDocument: (id: number) => Promise<ArrayBuffer>): Promise<Uint8Array> {
  try {
    if (typeof row.brojPriloga !== 'number') {
      throw new Error('missing numeric field brojPriloga');
    }
    const exportBytes = await exportDocument(row.id);
    return unpackExport(exportBytes, row.brojPriloga).eracun;
  } catch (error) {
    throw new BundleError(`Document ${row.id} (${row.brojDokumenta}) could not be supplied by the Portal: ${(error as Error).message}`);
  }
}

/** Plans a Bundle: queries the Portal's bounded, widened window for `month`, narrows back to the
 * exact Zagreb month client-side, and reads each Document's eRačun XML bytes. The cache
 * (`ports.store`) is checked first for every Document; a miss fetches that Document's Export from
 * the Portal instead of refusing (ADR-0012 — the cache is a fast path, not the only surviving
 * copy of a Filed Document's bytes). Recovered bytes are written back to the cache before
 * `planBundle` returns, so a second Send of the same month finds it warm. Every recovery fetch is
 * throttled through the same mechanism and constant `run()` uses (utils/run.ts's
 * `throttleExports`) — this is a government portal, and Send must never look like it is hammering
 * it any more than Download does. `options.onProgress`, when given, is called as each recovery
 * fetch starts and finishes, so a slow, cold Send does not look frozen; it is never called at all
 * when the cache is fully warm, since nothing is fetched. */
export async function planBundle(ports: BundlePorts, month: BundleMonth, options: BundlePlanOptions = {}): Promise<BundlePlan> {
  const window = bundleWindow(month);
  const filterParams = widenedFilterParams(window);
  const { rows } = await ports.portal.listDocuments(filterParams);
  const withinMonth = rows.filter((row) => withinZagrebWindow(row.datumIzdavanja, window));

  const eracunBytes = new Map<number, Uint8Array>();
  const missing: DocumentRow[] = [];
  for (const row of withinMonth) {
    const bytes = await ports.store.getCachedEracun(row.id);
    if (bytes === undefined) {
      missing.push(row);
    } else {
      eracunBytes.set(row.id, bytes);
    }
  }

  const throttledExportDocument = throttleExports((id) => ports.portal.exportDocument(id), ports.delay);
  const progress: BundlePlanProgress = { total: missing.length, current: null, fetched: 0 };
  const emitProgress = () => options.onProgress?.({ ...progress });

  for (const row of missing) {
    progress.current = { documentId: row.id, broj: row.brojDokumenta, issuerName: row.dobavljac.naziv };
    emitProgress();

    const bytes = await recoverEracun(row, throttledExportDocument);
    await ports.store.cacheEracun(row.id, bytes, ports.clock.now());
    eracunBytes.set(row.id, bytes);

    progress.fetched += 1;
    progress.current = null;
    emitProgress();
  }

  const documents: BundleDocument[] = [];
  const usedFilenames = new Set<string>();

  for (const row of withinMonth) {
    const bytes = eracunBytes.get(row.id)!;
    const stem = documentStem({ brojDokumenta: row.brojDokumenta, datumIzdavanja: row.datumIzdavanja, vrstaDokumenta: row.vrstaDokumenta });
    const filename = dedupeFilename(eracunFilename(stem), row.dobavljac.oib, usedFilenames);
    documents.push({ documentId: row.id, filename, bytes });
  }

  const totalSizeBytes = documents.reduce((sum, doc) => sum + doc.bytes.length, 0);
  return { month, documents, totalSizeBytes };
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/** A Bundle's month, `MM/YYYY` — the reading order a Croatian accountant expects. Shared by the
 * subject, the body and (utils/report.ts's) `formatBundleOffer`, so the three never drift into
 * disagreeing formats for the same month. */
export function formatBundleMonth(month: BundleMonth): string {
  return `${pad2(month.month)}/${month.year}`;
}

/** The Bundle's subject: the settings template plus the month. Never derived from send history
 * (CONTEXT.md) — the same month composed twice produces the same subject. */
export function bundleSubject(subjectTemplate: string, month: BundleMonth): string {
  return `${subjectTemplate} ${formatBundleMonth(month)}`;
}

function bundleBody(plan: BundlePlan): string {
  if (plan.documents.length === 0) {
    return `U prilogu nema dokumenata za ${formatBundleMonth(plan.month)}.`;
  }
  return `U prilogu se nalazi ${plan.documents.length} eRačuna za ${formatBundleMonth(plan.month)}.`;
}

/** Turns a `BundlePlan` into `.eml` bytes: every Accountant address and the subject come from
 * `settings` (issue #12's acceptance, extended by issue #30), the attachments come straight from
 * the plan, byte-for-byte (never re-serialised — ADR-0003, trap 9). Pure given the plan; all the
 * impure work (the Portal query, the cache reads) already happened in `planBundle`.
 *
 * Every address is joined into the one `To:` header as an equal addressee of the same message —
 * there is no `Cc` or `Bcc`, because the Accountant is one party reachable in several places
 * (CONTEXT.md), not several parties. A single address joins to exactly the header it produced
 * before this list existed. */
export function composeBundle(plan: BundlePlan, settings: Pick<Settings, 'accountantEmails' | 'subjectTemplate'>): Uint8Array {
  return assembleEml({
    to: settings.accountantEmails.join(', '),
    subject: bundleSubject(settings.subjectTemplate, plan.month),
    body: bundleBody(plan),
    attachments: plan.documents.map((doc) => ({ filename: doc.filename, bytes: doc.bytes })),
  });
}

/** The `.eml` file's own name on disk: the subject template plus the month, sanitised — the
 * download directory has no per-Recipient nesting the way the Archive does (ADR-0001), so this
 * alone is what tells two months' Bundles apart in a Downloads folder. */
export function bundleFilename(subjectTemplate: string, month: BundleMonth): string {
  return `${sanitizeSegment(subjectTemplate)} ${pad2(month.month)}-${month.year}.eml`;
}
