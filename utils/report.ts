// Croatian-language text for the Run report and live progress (issue #10). Pure — no DOM — so
// its content is asserted by test rather than by reading the popup (one of the issue's own
// acceptance criteria). entrypoints/popup/main.ts is the only caller.
//
// A failure's reason (RunError, utils/run.ts) is embedded verbatim rather than re-wrapped —
// run.ts's own messages are already Croatian; an error surfacing from the Portal fetch or the
// browser's own download API is not ours to translate, and naming the exact field or path is
// what lets the user act on it. Everything this module writes itself is Croatian, matching the
// "Greška: …" convention already in the popup.

import type { BackfillPlan } from './backfill';
import type { DriftedCode, FailedDocument, RunProgress, RunReport } from './run';

function formatTotals(filed: number, skipped: number, failed: number): string {
  return `Zapisano: ${filed}, preskočeno: ${skipped}, neuspjelo: ${failed}.`;
}

/** The first-run backfill offer (issue #11's acceptance: "a count and a time estimate are shown
 * before any Export is fetched"). "Pronađeno dokumenata" rather than "Pronađeno je N dokumenata"
 * sidesteps Croatian noun declension (1 dokument, 2–4 dokumenta, 5+ dokumenata) the same way
 * `formatTotals` already does for "Zapisano"/"preskočeno"/"neuspjelo". No estimate line for zero
 * Documents — there is nothing to wait for. */
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

/** The live progress line (acceptance: "which Document is being fetched now, and a running
 * count"). No Document is being fetched between one finishing and the next starting, or while a
 * Document is only being skip-checked — `currentDocumentId` is `null` then, and only the
 * running totals show. */
export function formatProgress(progress: RunProgress): string {
  const totals = formatTotals(progress.filed, progress.skipped, progress.failed);
  if (progress.currentDocumentId === null) return totals;
  return `Dohvaćanje dokumenta ${progress.currentDocumentId}… ${totals}`;
}

export interface RunSummary {
  headline: string;
  failures: string[];
  yearStraddles: string[];
  nepoznato: string[];
  drift: string[];
}

function formatFailure(failure: FailedDocument): string {
  return `Dokument ${failure.documentId}: ${failure.error}`;
}

function formatYearStraddle(documentId: number): string {
  return (
    `Dokument ${documentId}: datum izdavanja i datum zaprimanja nisu u istoj godini ` +
    `(godišnji prijelaz) — provjerite ručno u Portalu.`
  );
}

function formatNepoznato(documentId: number): string {
  return `Dokument ${documentId}: nepoznata vrsta dokumenta (NEPOZNATO) — zapisan, ali provjerite ga ručno u Portalu.`;
}

function formatDrift(drift: DriftedCode): string {
  return `Dokument ${drift.documentId}: šifra vrste dokumenta ${drift.code} nije prepoznata (nije na popisu poznatih vrsta).`;
}

/** The end-of-Run summary (acceptance: "a summary that tells the user whether they need to act
 * on anything"). Each list is empty, never omitted, when the Run has nothing to report there. */
export function summarizeRun(report: RunReport): RunSummary {
  return {
    headline: formatTotals(report.filed.length, report.skipped.length, report.failed.length),
    failures: report.failed.map(formatFailure),
    yearStraddles: report.yearStraddles.map(formatYearStraddle),
    nepoznato: report.nepoznato.map(formatNepoznato),
    drift: report.drift.map(formatDrift),
  };
}
