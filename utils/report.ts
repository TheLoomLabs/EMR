// Progress and the run report (issue #24, superseding issue #10's formatted-sentence version).
// This module returns structured view models, not prose — the renderer (entrypoints/window/main.ts)
// decides how to lay a notice out; this module decides only what counts as a notice and how
// severe it is. Pure — no DOM — so its content is asserted by test rather than by reading the
// window (one of the issue's own acceptance criteria).
//
// A failure's reason (RunError, utils/run.ts) is embedded verbatim rather than re-wrapped —
// run.ts's own messages are English now too (issue #24); an error surfacing from the Portal
// fetch or the browser's own download API is not ours to translate, and naming the exact field
// or path is what lets the user act on it.
//
// formatBackfillOffer and formatBundleOffer (issues #11, #12) are untouched by this issue and
// stay Croatian formatted sentences — only the progress/report seam this issue owns moves to
// structured, English view models.

import type { BackfillPlan } from './backfill';
import { formatBundleMonth, type BundlePlan } from './bundle';
import type { RunProgress, RunReport } from './run';

/** The first-run backfill offer (issue #11's acceptance: "a count and a time estimate are shown
 * before any Export is fetched"). "Pronađeno dokumenata" rather than "Pronađeno je N dokumenata"
 * sidesteps Croatian noun declension (1 dokument, 2–4 dokumenta, 5+ dokumenata). No estimate line
 * for zero Documents — there is nothing to wait for. */
export function formatBackfillOffer(plan: BackfillPlan): string {
  const count = `Pronađeno dokumenata: ${plan.recordsTotal}.`;
  if (plan.recordsTotal === 0) return count;

  const ONE_MINUTE_MS = 60_000;
  const duration =
    plan.estimatedMillis < ONE_MINUTE_MS
      ? 'manje od minute'
      : `približno ${Math.round(plan.estimatedMillis / ONE_MINUTE_MS)} min`;
  return `${count} Procijenjeno trajanje: ${duration}.`;
}

/** The Run's progress bar denominator answered as a percentage (issue #24's acceptance: "a
 * progress bar reflects Documents processed against the Run's total") — filed, skipped and
 * failed all count as processed; a Document currently in flight does not, until it resolves one
 * way or the other. Guards `total === 0` (a Run over zero Documents never calls `onProgress` at
 * all, but a caller computing this before the first snapshot must not divide by zero). */
export function progressPercent(progress: RunProgress): number {
  if (progress.total === 0) return 0;
  const processed = progress.filed + progress.skipped + progress.failed;
  return Math.round((processed / progress.total) * 100);
}

function formatSize(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  if (bytes < KB) return `${bytes} B`;
  const value = bytes < MB ? bytes / KB : bytes / MB;
  const unit = bytes < MB ? 'KB' : 'MB';
  return `${value.toFixed(1).replace('.', ',')} ${unit}`;
}

/** The Bundle offer shown before anything is composed (issue #12's acceptance: "sees the
 * resulting Bundle's total size before it is composed"). No size line for zero Documents,
 * mirroring `formatBackfillOffer`'s "nothing to wait for" rule above. */
export function formatBundleOffer(plan: BundlePlan): string {
  const count = `Dokumenata za ${formatBundleMonth(plan.month)}: ${plan.documents.length}.`;
  if (plan.documents.length === 0) return count;
  return `${count} Ukupna veličina: ${formatSize(plan.totalSizeBytes)}.`;
}

/** One entry in the run report (issue #24), severity-graded instead of sorted into four
 * undifferentiated bullet lists. `failed` is red — not filed, act on this. Every other kind is
 * `attention` — amber, filed successfully, but worth a look in the Portal; mapping Year
 * straddles, NEPOZNATO and code drift onto "attention" happens here, not in the renderer, so the
 * renderer can never accidentally render one of them as a failure. */
export type ReportNotice =
  | { kind: 'failed'; severity: 'failed'; documentId: number; broj: string; issuerName: string; reason: string }
  | {
      kind: 'yearStraddle';
      severity: 'attention';
      documentId: number;
      broj: string;
      issuerName: string;
      filedYear: number;
    }
  | { kind: 'nepoznato'; severity: 'attention'; documentId: number; broj: string; issuerName: string }
  | { kind: 'drift'; severity: 'attention'; documentId: number; broj: string; issuerName: string; code: number };

/** The two grades a notice can carry — shared here so a renderer grouping notices by severity
 * (entrypoints/window/main.ts) never re-spells this union and risks drifting from it. */
export type ReportNoticeSeverity = ReportNotice['severity'];

export interface RunSummary {
  /** Whether the report has anything to say before any detail is read — the report's own
   * opening question (issue #24's acceptance: "the report opens with whether anything needs
   * attention, before any detail"). True whenever there is at least one notice, red or amber. */
  needsAttention: boolean;
  filed: number;
  skipped: number;
  failed: number;
  notices: readonly ReportNotice[];
}

/** The end-of-Run summary (acceptance: "a summary that tells the user whether they need to act
 * on anything"). `report.failed` becomes `severity: 'failed'`; Year straddles, NEPOZNATO and
 * drift become `severity: 'attention'` — filed Documents that are never mistaken for failures. */
export function summarizeRun(report: RunReport): RunSummary {
  const notices: ReportNotice[] = [
    ...report.failed.map(
      (f): ReportNotice => ({
        kind: 'failed',
        severity: 'failed',
        documentId: f.documentId,
        broj: f.broj,
        issuerName: f.issuerName,
        reason: f.error,
      }),
    ),
    ...report.yearStraddles.map(
      (s): ReportNotice => ({
        kind: 'yearStraddle',
        severity: 'attention',
        documentId: s.documentId,
        broj: s.broj,
        issuerName: s.issuerName,
        filedYear: s.filedYear,
      }),
    ),
    ...report.nepoznato.map(
      (n): ReportNotice => ({
        kind: 'nepoznato',
        severity: 'attention',
        documentId: n.documentId,
        broj: n.broj,
        issuerName: n.issuerName,
      }),
    ),
    ...report.drift.map(
      (d): ReportNotice => ({
        kind: 'drift',
        severity: 'attention',
        documentId: d.documentId,
        broj: d.broj,
        issuerName: d.issuerName,
        code: d.code,
      }),
    ),
  ];

  return {
    needsAttention: notices.length > 0,
    filed: report.filed.length,
    skipped: report.skipped.length,
    failed: report.failed.length,
    notices,
  };
}
