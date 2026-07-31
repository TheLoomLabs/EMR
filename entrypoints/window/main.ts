import { DownloadsArchivePort } from '@/utils/archive';
import type { BackfillPlan, BackfillPort } from '@/utils/backfill';
import { planBackfill } from '@/utils/backfill';
import { composeBundle, planBundle, type BundleMonth, type BundlePlan, type BundlePortalPort } from '@/utils/bundle';
import { bundleFilename } from '@/utils/bundle';
import { systemClock } from '@/utils/clock';
import { systemDelay } from '@/utils/delay';
import { DownloadsEmlWriterPort } from '@/utils/eml-writer';
import type {
  ExportDocumentMessage,
  ExportDocumentResponse,
  ListDocumentsMessage,
  ListDocumentsResponse,
} from '@/utils/messages';
import { summarizeRow } from '@/utils/portal';
import { PORTAL_ORIGIN, selectPortalTab } from '@/utils/portal-tab';
import { formatBackfillOffer, formatBundleOffer, formatProgress, summarizeRun } from '@/utils/report';
import { planWindowRect } from '@/utils/window-geometry';
import { run, type RunPortalPort, type RunReport } from '@/utils/run';
import {
  cacheEracun,
  getCachedEracun,
  getSettings,
  getWindowGeometry,
  hasFiledAny,
  isFiled,
  markFiled,
  pruneEracunCache,
  setWindowGeometry,
} from '@/utils/store';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <h1>EMR</h1>
  <div id="no-portal" hidden>
    <p>No Portal tab is open.</p>
    <button id="open-portal">Open Portal</button>
  </div>
  <div id="app-content">
    <button id="list">Prikaži dokumente</button>
    <button id="preuzmi">Preuzmi</button>
    <button id="retry" hidden>Ponovi neuspjele</button>
    <div id="backfill-offer" hidden>
      <p id="backfill-offer-text"></p>
      <button id="backfill-start">Započni</button>
      <button id="backfill-decline">Ne sada</button>
    </div>
    <p id="status"></p>
    <div id="report"></div>
    <ul id="rows"></ul>
    <hr />
    <label>
      Mjesec za slanje
      <input type="month" id="bundle-month" />
    </label>
    <button id="posalji">Pošalji</button>
    <div id="bundle-offer" hidden>
      <p id="bundle-offer-text"></p>
      <button id="bundle-compose">Sastavi</button>
      <button id="bundle-cancel">Odustani</button>
    </div>
    <p id="bundle-status"></p>
  </div>
`;

const noPortalPanel = document.querySelector<HTMLDivElement>('#no-portal')!;
const appContent = document.querySelector<HTMLDivElement>('#app-content')!;
const openPortalButton = document.querySelector<HTMLButtonElement>('#open-portal')!;

const button = document.querySelector<HTMLButtonElement>('#list')!;
const preuzmiButton = document.querySelector<HTMLButtonElement>('#preuzmi')!;
const retryButton = document.querySelector<HTMLButtonElement>('#retry')!;
const backfillOffer = document.querySelector<HTMLDivElement>('#backfill-offer')!;
const backfillOfferText = document.querySelector<HTMLParagraphElement>('#backfill-offer-text')!;
const backfillStartButton = document.querySelector<HTMLButtonElement>('#backfill-start')!;
const backfillDeclineButton = document.querySelector<HTMLButtonElement>('#backfill-decline')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const reportEl = document.querySelector<HTMLDivElement>('#report')!;
const rowsList = document.querySelector<HTMLUListElement>('#rows')!;

const bundleMonthInput = document.querySelector<HTMLInputElement>('#bundle-month')!;
const posaljiButton = document.querySelector<HTMLButtonElement>('#posalji')!;
const bundleOffer = document.querySelector<HTMLDivElement>('#bundle-offer')!;
const bundleOfferText = document.querySelector<HTMLParagraphElement>('#bundle-offer-text')!;
const bundleComposeButton = document.querySelector<HTMLButtonElement>('#bundle-compose')!;
const bundleCancelButton = document.querySelector<HTMLButtonElement>('#bundle-cancel')!;
const bundleStatus = document.querySelector<HTMLParagraphElement>('#bundle-status')!;

/** "No Portal tab is open" (ADR-0010, issue #21) — a condition the window evaluates and
 * renders, with an action that opens the Portal, rather than an `Error` string thrown inside a
 * click handler. Its message is English even though the rest of this window is not (it is new
 * text); everything else here stays Croatian, as before. */
class NoPortalTabError extends Error {
  constructor() {
    super('No Portal tab is open.');
    this.name = 'NoPortalTabError';
  }
}

/** Finds the Portal tab wherever it sits (ADR-0010) — matched by origin across every browser
 * window, active or not, since `tabs.query({ active: true, currentWindow: true })` would return
 * this window's own tab instead. `browser.tabs.query` is the thin shell; `selectPortalTab`
 * (utils/portal-tab.ts) is the pure, tested selection. */
async function findPortalTabId(): Promise<number | undefined> {
  const tabs = await browser.tabs.query({ url: `${PORTAL_ORIGIN}/*` });
  return selectPortalTab(tabs)?.id;
}

/** Sends `message` to the Portal tab and unwraps its `{ok, ...} | {ok:false, error}` envelope
 * (ADR-0005 — only that content script can reach the Portal's origin and its live apptoken),
 * throwing on no tab found, no response, or an `ok:false` one. Re-finds the tab on every call
 * rather than caching a tab id, so the Portal tab closing mid-Run (issue #21's acceptance) is
 * reported as a failure the next time it is needed, never a hang. */
async function sendToPortal<Response extends { ok: true } | { ok: false; error: string }>(
  message: unknown,
): Promise<Extract<Response, { ok: true }>> {
  const tabId = await findPortalTabId();
  if (tabId === undefined) {
    throw new NoPortalTabError();
  }

  const response = (await browser.tabs.sendMessage(tabId, message)) as Response | undefined;
  if (!response) {
    throw new Error('nema odgovora — otvorite Ulazni dokumenti u Portalu');
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response as Extract<Response, { ok: true }>;
}

/** True for the duration of a Preuzmi (issue #10's Run) — while one is in flight, the Portal
 * tab closing must surface as a Run failure in the report (issue #21's other acceptance), not
 * as the gate below yanking the report out from under the person reading it. Re-checked once
 * the Run ends, so a still-missing Portal tab is reflected the moment it is safe to. */
let runInProgress = false;

/** Gates the whole window on whether a Portal tab exists (issue #21's acceptance: "with no
 * Portal tab open, the window renders that state and offers to open the Portal"), evaluated on
 * load and kept live as tabs open, close or navigate — no polling needed for that. */
async function refreshPortalAvailability(): Promise<void> {
  if (runInProgress) return;
  const tabId = await findPortalTabId();
  noPortalPanel.hidden = tabId !== undefined;
  appContent.hidden = tabId === undefined;
}

browser.tabs.onCreated.addListener(() => void refreshPortalAvailability());
browser.tabs.onRemoved.addListener(() => void refreshPortalAvailability());
browser.tabs.onUpdated.addListener(() => void refreshPortalAvailability());
void refreshPortalAvailability();

openPortalButton.addEventListener('click', () => {
  void browser.tabs.create({ url: `${PORTAL_ORIGIN}/` });
});

button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Učitavanje…';
  rowsList.innerHTML = '';

  try {
    const message: ListDocumentsMessage = { type: 'emr:list-documents' };
    const response = await sendToPortal<ListDocumentsResponse>(message);

    status.textContent = `Ukupno: ${response.recordsTotal}`;
    for (const row of response.rows) {
      const item = document.createElement('li');
      item.textContent = summarizeRow(row);
      rowsList.appendChild(item);
    }
  } catch (error) {
    status.textContent = `Greška: ${(error as Error).message}`;
  } finally {
    button.disabled = false;
  }
});

/** Relays the `portal` port's two operations to the Portal's own content script (ADR-0005) —
 * this window itself has no access to the Portal's origin or its live apptoken. */
const relayPortalPort: RunPortalPort = {
  async listDocuments() {
    const message: ListDocumentsMessage = { type: 'emr:list-documents' };
    const response = await sendToPortal<ListDocumentsResponse>(message);
    return { recordsTotal: response.recordsTotal, rows: response.rows };
  },
  async exportDocument(id) {
    const message: ExportDocumentMessage = { type: 'emr:export-document', id };
    const response = await sendToPortal<ExportDocumentResponse>(message);
    return response.bytes;
  },
};

/** The same relay, but carrying `filterParams` through — the first-run backfill's bounded window
 * (issue #11, utils/backfill.ts), never used by a normal Run's unbounded walk (ADR-0008). */
const relayBackfillPort: BackfillPort = {
  async listDocuments(filterParams) {
    const message: ListDocumentsMessage = { type: 'emr:list-documents', filterParams };
    const response = await sendToPortal<ListDocumentsResponse>(message);
    return { recordsTotal: response.recordsTotal, rows: response.rows };
  },
};

/** A report section, appending nothing when there is nothing to say — an empty "Godišnji
 * prijelazi" heading on every ordinary Run would just be noise. Built with `createElement` and
 * `textContent`, like `#list`'s own row rendering above, so a failure's reason (utils/run.ts's
 * RunError messages, embedded verbatim by utils/report.ts) is never interpreted as markup. */
function renderSection(parent: HTMLElement, heading: string, lines: readonly string[]): void {
  if (lines.length === 0) return;

  const h2 = document.createElement('h2');
  h2.textContent = heading;
  parent.appendChild(h2);

  const list = document.createElement('ul');
  for (const line of lines) {
    const item = document.createElement('li');
    item.textContent = line;
    list.appendChild(item);
  }
  parent.appendChild(list);
}

function renderReport(report: RunReport): void {
  const summary = summarizeRun(report);
  reportEl.innerHTML = '';

  const headline = document.createElement('p');
  headline.textContent = summary.headline;
  reportEl.appendChild(headline);

  renderSection(reportEl, 'Neuspjelo', summary.failures);
  renderSection(reportEl, 'Godišnji prijelazi', summary.yearStraddles);
  renderSection(reportEl, 'Nepoznata vrsta dokumenta (NEPOZNATO)', summary.nepoznato);
  renderSection(reportEl, 'Šifra vrste dokumenta nije prepoznata', summary.drift);

  retryButton.hidden = report.failed.length === 0;
}

// Kept only so "Ponovi neuspjele" knows which Document ids to retry — Runs are safe to repeat
// at any time (ADR-0004), so nothing here needs to survive the window closing.
let lastReport: RunReport | null = null;

/** Runs a Preuzmi, live-updating `status` as each Document is fetched (issue #10) and rendering
 * the Croatian summary once it ends. `documentIds`, when given, restricts the walk to just those
 * ids — how the retry-failures button re-runs only what previously failed. */
async function preuzmi(documentIds?: readonly number[]): Promise<void> {
  preuzmiButton.disabled = true;
  retryButton.disabled = true;
  status.textContent = 'Preuzimanje…';
  runInProgress = true;

  try {
    const report = await run(
      {
        portal: relayPortalPort,
        archive: new DownloadsArchivePort(),
        store: { getSettings, isFiled, markFiled, cacheEracun, pruneEracunCache },
        clock: systemClock,
        delay: systemDelay,
      },
      {
        documentIds,
        onProgress: (progress) => {
          status.textContent = formatProgress(progress);
        },
      },
    );

    lastReport = report;
    renderReport(report);
  } catch (error) {
    status.textContent = `Greška: ${(error as Error).message}`;
  } finally {
    preuzmiButton.disabled = false;
    retryButton.disabled = false;
    runInProgress = false;
    void refreshPortalAvailability();
  }
}

let pendingBackfillPlan: BackfillPlan | null = null;

function hideBackfillOffer(): void {
  backfillOffer.hidden = true;
  pendingBackfillPlan = null;
}

/** On first use (issue #11: no Document has ever been Filed), shows a count and a rough time
 * estimate before any Export is fetched, and lets the user start or decline rather than
 * launching straight into a Run that could be dozens of Documents deep. A declined offer leaves
 * the Filed set empty, so the next Preuzmi click offers backfill again — no separate persisted
 * "declined" state is needed (ADR-0004's promise: losing state costs bandwidth, never
 * correctness, extended to this decision too). */
preuzmiButton.addEventListener('click', async () => {
  preuzmiButton.disabled = true;
  try {
    if (!(await hasFiledAny())) {
      status.textContent = 'Provjera opsega…';
      const plan = await planBackfill(relayBackfillPort, systemClock);
      pendingBackfillPlan = plan;
      backfillOfferText.textContent = formatBackfillOffer(plan);
      backfillOffer.hidden = false;
      status.textContent = '';
      return;
    }
  } catch (error) {
    status.textContent = `Greška: ${(error as Error).message}`;
    return;
  } finally {
    preuzmiButton.disabled = false;
  }

  void preuzmi();
});

backfillStartButton.addEventListener('click', () => {
  const plan = pendingBackfillPlan;
  if (!plan) return;
  hideBackfillOffer();
  void preuzmi(plan.documentIds);
});

backfillDeclineButton.addEventListener('click', () => {
  hideBackfillOffer();
});

retryButton.addEventListener('click', () => {
  if (!lastReport || lastReport.failed.length === 0) return;
  void preuzmi(lastReport.failed.map((failure) => failure.documentId));
});

/** `relayBackfillPort`'s shape — `listDocuments(filterParams)` — is exactly what `planBundle`
 * needs too (utils/bundle.ts's `BundlePortalPort`), so the same relay serves both. */
const relayBundlePort: BundlePortalPort = relayBackfillPort;

function parseBundleMonth(value: string): BundleMonth | undefined {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  return { year: Number(match[1]), month: Number(match[2]) };
}

let pendingBundlePlan: BundlePlan | null = null;

function hideBundleOffer(): void {
  bundleOffer.hidden = true;
  pendingBundlePlan = null;
}

/** Pošalji (CONTEXT.md "Bundle"; ADR-0003): plans a month's Bundle and shows its total size
 * before anything is composed (issue #12's acceptance), mirroring the backfill offer's
 * plan-then-confirm shape above. */
posaljiButton.addEventListener('click', async () => {
  const month = parseBundleMonth(bundleMonthInput.value);
  if (!month) {
    bundleStatus.textContent = 'Odaberite mjesec.';
    return;
  }

  posaljiButton.disabled = true;
  bundleStatus.textContent = 'Provjera opsega…';
  try {
    // Checked here, not just left for composeBundle to embed an empty To: — settings.accountantEmail
    // is what the acceptance criterion means by "the recipient address ... come[s] from settings",
    // and a blank one is a setup gap the user can fix in Postavke, not something to compose past.
    const settings = await getSettings();
    if (!settings.accountantEmail) {
      bundleStatus.textContent = 'Postavite e-mail adresu knjigovođe u Postavkama prije slanja.';
      return;
    }

    const plan = await planBundle(relayBundlePort, { getCachedEracun }, month);
    pendingBundlePlan = plan;
    bundleOfferText.textContent = formatBundleOffer(plan);
    bundleOffer.hidden = false;
    bundleStatus.textContent = '';
  } catch (error) {
    bundleStatus.textContent = `Greška: ${(error as Error).message}`;
  } finally {
    posaljiButton.disabled = false;
  }
});

bundleComposeButton.addEventListener('click', async () => {
  const plan = pendingBundlePlan;
  if (!plan) return;

  bundleComposeButton.disabled = true;
  bundleStatus.textContent = 'Sastavljanje…';
  try {
    const settings = await getSettings();
    const eml = composeBundle(plan, settings);
    await new DownloadsEmlWriterPort().writeAndOpen(bundleFilename(settings.subjectTemplate, plan.month), eml);
    bundleStatus.textContent = 'Poruka je sastavljena i otvorena.';
    hideBundleOffer();
  } catch (error) {
    bundleStatus.textContent = `Greška: ${(error as Error).message}`;
  } finally {
    bundleComposeButton.disabled = false;
  }
});

bundleCancelButton.addEventListener('click', () => {
  hideBundleOffer();
});

/** Window geometry (ADR-0010, issue #21): `windows.create` (entrypoints/background.ts) cannot
 * know the screen until this page itself loads, so a first open positions the window
 * approximately and this corrects it exactly, via `window.screen` (unavailable to the
 * background service worker) and `browser.windows.getCurrent`/`update` — the thin shell around
 * `planWindowRect`'s pure decision (utils/window-geometry.ts). A remembered rectangle is
 * restored verbatim; there is nothing left to correct in that case. */
async function applyPlannedGeometry(): Promise<void> {
  const remembered = await getWindowGeometry();
  const rect = planWindowRect({ width: window.screen.availWidth, height: window.screen.availHeight }, remembered ?? undefined);
  const current = await browser.windows.getCurrent();
  if (current.id === undefined) return;
  await browser.windows.update(current.id, rect);
}

/** Persists the window's current position and size, read back through `windows.getCurrent`
 * rather than the DOM's `outerWidth`/`outerHeight` so it agrees exactly with what
 * `windows.update` expects on the next open. Called on blur (issue #21's own motivating
 * scenario: clicking away mid-Run) and before unload, plus on an interval as a plain move
 * without a resize fires neither of the DOM's own `resize` event. */
async function persistCurrentGeometry(): Promise<void> {
  const current = await browser.windows.getCurrent();
  if (current.left === undefined || current.top === undefined || current.width === undefined || current.height === undefined) {
    return;
  }
  await setWindowGeometry({ left: current.left, top: current.top, width: current.width, height: current.height });
}

window.addEventListener('blur', () => void persistCurrentGeometry());
window.addEventListener('beforeunload', () => void persistCurrentGeometry());
setInterval(() => void persistCurrentGeometry(), 2000);

void applyPlannedGeometry();
