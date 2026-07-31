// Opens EMR's own window in place of the browser-action popup (ADR-0010, issue #21) — a
// singleton: pressing the toolbar icon while it is already open focuses it rather than opening
// a second. `default_popup` is gone from the manifest (wxt.config.ts), so `action.onClicked`
// fires on every press, popup or not.

import { getWindowGeometry } from '@/utils/store';

const WINDOW_PAGE = '/window.html';

/** The EMR window is found by its own page's URL, not by a remembered window id — a service
 * worker can be killed and restarted between one click and the next (MV3), so nothing kept only
 * in memory here can be trusted to survive. `browser.tabs.query` for our own extension page is
 * the thin shell; there is nothing to unit-test once the id it finds is a tab id, not a
 * decision. */
async function findEmrWindowId(): Promise<number | undefined> {
  const tabs = await browser.tabs.query({ url: browser.runtime.getURL(WINDOW_PAGE) });
  return tabs[0]?.windowId;
}

async function openOrFocusEmrWindow(): Promise<void> {
  const existingId = await findEmrWindowId();
  if (existingId !== undefined) {
    await browser.windows.update(existingId, { focused: true });
    return;
  }

  const remembered = await getWindowGeometry();
  await browser.windows.create({
    url: WINDOW_PAGE,
    type: 'popup',
    ...(remembered ?? {}),
  });
}

/** Serialises `openOrFocusEmrWindow` calls (issue #21's acceptance: "never creates a second") —
 * without this, two rapid clicks can both run `findEmrWindowId` before either's `windows.create`
 * resolves, so both see no window and both create one. Chaining onto `pending` makes the second
 * call's check happen only after the first's create-or-focus has fully settled. */
let pending: Promise<void> = Promise.resolve();

function enqueueOpenOrFocus(): void {
  pending = pending.then(openOrFocusEmrWindow, openOrFocusEmrWindow);
}

export default defineBackground(() => {
  browser.action.onClicked.addListener(() => {
    enqueueOpenOrFocus();
  });
});
