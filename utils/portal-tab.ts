// Selecting the Portal tab out of the browser's open tabs (ADR-0010, issue #21) — a pure
// function over whatever `browser.tabs.query` returns. From EMR's own detached window,
// `tabs.query({ active: true, currentWindow: true })` (the old relay, ADR-0005) returns EMR's
// own tab, never the Portal's, so the Portal is instead found by matching its origin, in
// whichever browser window it sits in and whether or not it is the active tab there.

export const PORTAL_ORIGIN = 'https://mikroeracun.porezna-uprava.hr';

/** Only the fields `browser.tabs.Tab` carries that the selection needs — kept narrow so this
 * module can be tested against hand-written objects, not the real `browser.tabs` API. */
export interface CandidateTab {
  id?: number;
  url?: string;
  active?: boolean;
}

function isPortalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).origin === PORTAL_ORIGIN;
  } catch {
    return false;
  }
}

/** Picks the Portal tab, or `undefined` if none is open. Several open Portal tabs favour
 * whichever is active, falling back to the first match in list order — deterministic either
 * way, so the choice never depends on iteration order alone. */
export function selectPortalTab(tabs: readonly CandidateTab[]): CandidateTab | undefined {
  const candidates = tabs.filter((tab) => isPortalUrl(tab.url));
  return candidates.find((tab) => tab.active) ?? candidates[0];
}
