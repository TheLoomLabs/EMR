// The first-run backfill (issue #11): before any Export is fetched, show the user how many
// Documents exist and roughly how long filing them will take, then let them start or decline.
//
// Queries a window bounded to when eRačun receipt began (HANDOFF, "Domain facts") — permanently
// the whole of a Recipient's history — widened a day at each end and narrowed back to the exact
// window client-side (docs/portal-api.md, "kraj works"), rather than an unbounded query. The
// resulting Document ids feed run()'s own `documentIds` option (issue #10, utils/run.ts);
// resuming an interrupted backfill, throttling and per-Document atomicity are already run()'s
// (ADR-0004) and need no separate machinery here (HANDOFF, "Interrupting it costs nothing").

import type { Clock } from './clock';
import { zagrebDate, type ZagrebDate } from './filing';
import {
  widenedFilterParams,
  withinZagrebWindow,
  type FilterParams,
  type ListDocumentsResult,
  type ZagrebWindow,
} from './portal';
import { EXPORT_DELAY_MS } from './run';

/** Receipt of eRačuni began 1 January 2026 (HANDOFF, "Domain facts"): no Recipient can have any
 * history before this date, so the backfill window is anchored here rather than walked back
 * indefinitely. A backfill-only fact, not general Portal API mechanics, so it lives here rather
 * than in utils/portal.ts. */
export const ERACUN_RECEIPT_START: ZagrebDate = { year: 2026, month: 1, day: 1 };

/** The `portal` port as planBackfill sees it: one already-paged, already-validated listing
 * (utils/portal.ts's `listDocuments`, run inside the Portal's own page per ADR-0005) against a
 * given `filterParams`. The real implementation is the popup's message relay; a fake serves
 * canned data for tests. */
export interface BackfillPort {
  listDocuments(filterParams: FilterParams): Promise<ListDocumentsResult>;
}

export interface BackfillPlan {
  /** The exact-window Document ids to hand to `run()`'s `documentIds` option. */
  documentIds: number[];
  /** Straight from the widened query's `recordsTotal` (docs/portal-api.md: "the number to show
   * in the first-run backfill estimate") — a close, cheap-to-obtain over-estimate rather than
   * the exact-window count, since only Documents on the extra widened day could ever differ. */
  recordsTotal: number;
  /** A rough estimate: the dominant, guaranteed-fixed cost of a Run is the throttle between
   * Exports (EXPORT_DELAY_MS, utils/run.ts), not the fetch itself — good enough for deciding
   * "start now or tonight" (HANDOFF, "First run"). */
  estimatedMillis: number;
}

/** The window a first-run backfill covers: from when eRačun receipt began through today, in
 * Zagreb wall-clock terms. Permanently the whole of a Recipient's history (HANDOFF, "Backfill is
 * bounded by reality: receipt of eRačuni only began 1 January 2026"). */
export function backfillWindow(now: number): ZagrebWindow {
  return { from: ERACUN_RECEIPT_START, to: zagrebDate(now) };
}

/** Plans a first-run backfill: queries the bounded, widened window — never earlier than eRačun
 * receipt began (acceptance: "nothing is requested for periods before eRačun receipt began") —
 * narrows the result back to the exact window client-side, and reports how many Documents that
 * is and roughly how long filing them will take, all before any Export is fetched. */
export async function planBackfill(port: BackfillPort, clock: Clock): Promise<BackfillPlan> {
  const window = backfillWindow(clock.now());
  const filterParams = widenedFilterParams(window, ERACUN_RECEIPT_START);
  const { recordsTotal, rows } = await port.listDocuments(filterParams);

  const documentIds = rows.filter((row) => withinZagrebWindow(row.datumIzdavanja, window)).map((row) => row.id);

  return { documentIds, recordsTotal, estimatedMillis: recordsTotal * EXPORT_DELAY_MS };
}
