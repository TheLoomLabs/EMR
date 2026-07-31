import { DownloadsArchivePort } from '@/utils/archive';
import type { BackfillPlan, BackfillPort } from '@/utils/backfill';
import { planBackfill } from '@/utils/backfill';
import { composeBundle, planBundle, type BundleMonth, type BundlePlan, type BundlePortalPort } from '@/utils/bundle';
import { bundleFilename, bundleSubject } from '@/utils/bundle';
import { systemClock } from '@/utils/clock';
import { systemDelay } from '@/utils/delay';
import { DownloadsEmlWriterPort } from '@/utils/eml-writer';
import { archiveDirectory, zagrebDate } from '@/utils/filing';
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
  setSettings,
  setWindowGeometry,
} from '@/utils/store';

/** The window's shell (issue #22): a sidebar navigating Download, Send and Settings — the
 * extension's identity and a live Portal connection indicator above/below it — and a `<main>`
 * that shows exactly one `[data-page]` section at a time. Settings is folded in here rather than
 * living on a separate options page (ADR-0010's spirit extended: the extension lives in one
 * place). Download and Send keep their existing controls and ids, just wrapped in a heading and
 * a one-sentence description and re-skinned by style.css's token layer. */
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <span class="mark">eR</span>
        <span class="name">EMR</span>
      </div>

      <nav class="nav">
        <button data-nav="download" aria-current="page"><span class="ico">↓</span> Download</button>
        <button data-nav="send"><span class="ico">✉</span> Send</button>
        <button data-nav="settings"><span class="ico">⚙</span> Settings</button>
      </nav>

      <div class="spacer"></div>

      <div class="portal-status" id="portal-status">
        <span class="led"></span>
        <span id="portal-status-text">Portal connected</span>
      </div>
    </aside>

    <main class="main">
      <section data-page="download">
        <div class="page-head">
          <h1>Download</h1>
          <p>Fetch new Documents from the Portal and file them into the Archive.</p>
        </div>

        <div class="card no-portal" id="download-no-portal" hidden>
          <div class="card-body">
            <div class="empty">
              <div class="ico">⚠</div>
              <h3>The Portal isn't open</h3>
              <p>EMR reads your Documents from the MIKROeRAČUN page itself, so that tab has to be open and signed in.</p>
              <button id="open-portal" class="btn btn-primary">Open the Portal</button>
            </div>
          </div>
        </div>

        <div id="app-content">
          <div class="actions actions-lead">
            <button id="list" class="btn btn-secondary">Prikaži dokumente</button>
            <button id="preuzmi" class="btn btn-primary btn-lg">Preuzmi</button>
            <button id="retry" class="btn btn-secondary" hidden>Ponovi neuspjele</button>
          </div>
          <div class="offer" id="backfill-offer" hidden>
            <div class="txt"><span id="backfill-offer-text"></span></div>
            <div class="actions">
              <button id="backfill-decline" class="btn btn-ghost">Ne sada</button>
              <button id="backfill-start" class="btn btn-primary">Započni</button>
            </div>
          </div>
          <p id="status"></p>
          <div id="report"></div>
          <ul id="rows"></ul>
        </div>
      </section>

      <section data-page="send" hidden>
        <div class="page-head">
          <h1>Send</h1>
          <p>Compose one calendar month of filed Documents into a message for your Accountant.</p>
        </div>

        <div class="card no-portal" id="send-no-portal" hidden>
          <div class="card-body">
            <div class="empty">
              <div class="ico">⚠</div>
              <h3>The Portal isn't open</h3>
              <p>EMR reads your Documents from the MIKROeRAČUN page itself, so that tab has to be open and signed in.</p>
              <button id="open-portal-send" class="btn btn-primary">Open the Portal</button>
            </div>
          </div>
        </div>

        <div id="send-content">
          <div class="card">
            <div class="card-body">
              <div class="field">
                <label for="bundle-month">Mjesec za slanje</label>
                <input type="month" id="bundle-month" />
              </div>
              <div class="actions">
                <button id="posalji" class="btn btn-primary">Pošalji</button>
              </div>
            </div>
          </div>

          <div class="offer" id="bundle-offer" hidden>
            <div class="txt"><span id="bundle-offer-text"></span></div>
            <div class="actions">
              <button id="bundle-cancel" class="btn btn-ghost">Odustani</button>
              <button id="bundle-compose" class="btn btn-primary">Sastavi</button>
            </div>
          </div>
          <p id="bundle-status"></p>
        </div>
      </section>

      <section data-page="settings" hidden>
        <div class="page-head">
          <h1>Settings</h1>
          <p>Where filed Documents go, and who they're forwarded to.</p>
        </div>

        <form id="settings-form">
          <div class="card">
            <div class="card-head"><h2>Accountant</h2></div>
            <div class="card-body">
              <div class="field">
                <label for="accountantEmail">Email address</label>
                <input type="email" id="accountantEmail" name="accountantEmail" />
                <div class="hint">The address the composed message is addressed to.</div>
              </div>
              <div class="field">
                <label for="subjectTemplate">Subject template</label>
                <input type="text" id="subjectTemplate" name="subjectTemplate" />
                <div class="hint">The month is appended automatically.</div>
                <div class="path-preview" id="subject-preview"></div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h2>Archive</h2></div>
            <div class="card-body">
              <div class="field">
                <label for="archiveRoot">Root folder name</label>
                <input type="text" id="archiveRoot" name="archiveRoot" />
                <div class="hint">Created inside your browser's download directory.</div>
                <div class="path-preview" id="archive-preview"></div>
              </div>
              <div class="actions">
                <button type="submit" id="settings-save" class="btn btn-primary">Save</button>
              </div>
            </div>
          </div>

          <p id="settings-status" role="status"></p>
        </form>
      </section>
    </main>
  </div>
`;

/** A section gated on the Portal tab existing (ADR-0010, issue #21) — Download and Send both
 * need one, since planning either a Run or a Bundle requires the Portal's content script
 * (ADR-0005); Settings does not, which is why it has no such gate (issue #22). One shape shared
 * by both rather than duplicating the empty-state wiring per section. */
interface PortalGatedSection {
  noPortal: HTMLElement;
  content: HTMLElement;
  openPortalButton: HTMLButtonElement;
}

function portalGatedSection(noPortalSelector: string, contentSelector: string, openButtonSelector: string): PortalGatedSection {
  return {
    noPortal: document.querySelector<HTMLElement>(noPortalSelector)!,
    content: document.querySelector<HTMLElement>(contentSelector)!,
    openPortalButton: document.querySelector<HTMLButtonElement>(openButtonSelector)!,
  };
}

const portalGatedSections: readonly PortalGatedSection[] = [
  portalGatedSection('#download-no-portal', '#app-content', '#open-portal'),
  portalGatedSection('#send-no-portal', '#send-content', '#open-portal-send'),
];

for (const gate of portalGatedSections) {
  gate.openPortalButton.addEventListener('click', () => {
    void browser.tabs.create({ url: `${PORTAL_ORIGIN}/` });
  });
}

const button = document.querySelector<HTMLButtonElement>('#list')!;
const preuzmiButton = document.querySelector<HTMLButtonElement>('#preuzmi')!;
const retryButton = document.querySelector<HTMLButtonElement>('#retry')!;
const backfillOffer = document.querySelector<HTMLDivElement>('#backfill-offer')!;
const backfillOfferText = document.querySelector<HTMLSpanElement>('#backfill-offer-text')!;
const backfillStartButton = document.querySelector<HTMLButtonElement>('#backfill-start')!;
const backfillDeclineButton = document.querySelector<HTMLButtonElement>('#backfill-decline')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const reportEl = document.querySelector<HTMLDivElement>('#report')!;
const rowsList = document.querySelector<HTMLUListElement>('#rows')!;

const bundleMonthInput = document.querySelector<HTMLInputElement>('#bundle-month')!;
const posaljiButton = document.querySelector<HTMLButtonElement>('#posalji')!;
const bundleOffer = document.querySelector<HTMLDivElement>('#bundle-offer')!;
const bundleOfferText = document.querySelector<HTMLSpanElement>('#bundle-offer-text')!;
const bundleComposeButton = document.querySelector<HTMLButtonElement>('#bundle-compose')!;
const bundleCancelButton = document.querySelector<HTMLButtonElement>('#bundle-cancel')!;
const bundleStatus = document.querySelector<HTMLParagraphElement>('#bundle-status')!;

const portalStatusEl = document.querySelector<HTMLDivElement>('#portal-status')!;
const portalStatusText = document.querySelector<HTMLSpanElement>('#portal-status-text')!;

/** Toggles a button's busy state (issue #22's acceptance: "a busy button shows a spinner and
 * cannot be clicked again"). `disabled` alone already blocks activation; the spinner is what
 * tells the person it is doing so because work is in flight, not because it is unavailable. The
 * idle label is stashed on the element itself so it can be restored exactly, including across
 * nested busy/idle cycles on the same button. */
function setButtonBusy(btn: HTMLButtonElement, busy: boolean): void {
  if (busy) {
    if (btn.dataset.idleLabel === undefined) {
      btn.dataset.idleLabel = btn.textContent ?? '';
    }
    btn.disabled = true;
    btn.textContent = '';
    const spinner = document.createElement('span');
    spinner.className = 'spin';
    btn.appendChild(spinner);
    btn.appendChild(document.createTextNode(btn.dataset.idleLabel));
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.idleLabel ?? btn.textContent ?? '';
  }
}

/** Sidebar section switching (issue #22's acceptance: "the active section is visibly current").
 * A plain `<button>` per nav item is already keyboard-operable (Tab, then Enter/Space); the CSS
 * `:focus-visible` ring is what makes that visible rather than silent. */
function switchSection(page: string): void {
  for (const navButton of document.querySelectorAll<HTMLButtonElement>('[data-nav]')) {
    if (navButton.dataset.nav === page) {
      navButton.setAttribute('aria-current', 'page');
    } else {
      navButton.removeAttribute('aria-current');
    }
  }
  for (const section of document.querySelectorAll<HTMLElement>('[data-page]')) {
    section.hidden = section.dataset.page !== page;
  }
}

for (const navButton of document.querySelectorAll<HTMLButtonElement>('[data-nav]')) {
  navButton.addEventListener('click', () => switchSection(navButton.dataset.nav!));
}

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

/** Keeps the sidebar's Portal indicator live (issue #22's acceptance: "the sidebar shows Portal
 * connection state and updates when the Portal tab opens or closes") — always current, whichever
 * section is showing, since Settings and Send need the answer just as much as Download does. */
function updatePortalIndicator(connected: boolean): void {
  portalStatusEl.classList.toggle('off', !connected);
  portalStatusText.textContent = connected ? 'Portal connected' : 'Portal not open';
}

/** Gates Download's and Send's own controls on whether a Portal tab exists (issue #21's
 * acceptance: "with no Portal tab open, the window renders that state and offers to open the
 * Portal") — both, because planning a Run or a Bundle both need the Portal's content script
 * (ADR-0005). Settings alone is excluded from this gate, now that it is a section of its own
 * (issue #22: configuring EMR should not require the Portal to be open). */
async function refreshPortalAvailability(): Promise<void> {
  const tabId = await findPortalTabId();
  updatePortalIndicator(tabId !== undefined);

  if (runInProgress) return;
  for (const gate of portalGatedSections) {
    gate.noPortal.hidden = tabId !== undefined;
    gate.content.hidden = tabId === undefined;
  }
}

browser.tabs.onCreated.addListener(() => void refreshPortalAvailability());
browser.tabs.onRemoved.addListener(() => void refreshPortalAvailability());
browser.tabs.onUpdated.addListener(() => void refreshPortalAvailability());
void refreshPortalAvailability();

button.addEventListener('click', async () => {
  setButtonBusy(button, true);
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
    setButtonBusy(button, false);
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
  setButtonBusy(preuzmiButton, true);
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
    setButtonBusy(preuzmiButton, false);
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

  setButtonBusy(posaljiButton, true);
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
    setButtonBusy(posaljiButton, false);
  }
});

bundleComposeButton.addEventListener('click', async () => {
  const plan = pendingBundlePlan;
  if (!plan) return;

  setButtonBusy(bundleComposeButton, true);
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
    setButtonBusy(bundleComposeButton, false);
  }
});

bundleCancelButton.addEventListener('click', () => {
  hideBundleOffer();
});

/* ================= Settings (issue #22: folded in as the window's third section) ================= */

const settingsForm = document.querySelector<HTMLFormElement>('#settings-form')!;
const accountantEmailInput = document.querySelector<HTMLInputElement>('#accountantEmail')!;
const subjectTemplateInput = document.querySelector<HTMLInputElement>('#subjectTemplate')!;
const archiveRootInput = document.querySelector<HTMLInputElement>('#archiveRoot')!;
const settingsStatus = document.querySelector<HTMLParagraphElement>('#settings-status')!;
const settingsSaveButton = document.querySelector<HTMLButtonElement>('#settings-save')!;
const subjectPreviewEl = document.querySelector<HTMLDivElement>('#subject-preview')!;
const archivePreviewEl = document.querySelector<HTMLDivElement>('#archive-preview')!;

/** The subject template's live preview (issue #22's acceptance: "the subject template field
 * previews the subject a Bundle would carry, as it is typed") — the exact `bundleSubject`
 * (utils/bundle.ts) a real Send would use, applied to the current Zagreb month, so what is shown
 * here can never drift from what Send actually produces. */
function updateSubjectPreview(): void {
  const today = zagrebDate(systemClock.now());
  subjectPreviewEl.textContent = bundleSubject(subjectTemplateInput.value, { year: today.year, month: today.month });
}

/** The Archive root's live preview (issue #22's acceptance: "the Archive root field previews the
 * resulting path as it is typed") — the exact `archiveDirectory` (utils/filing.ts) a real Run
 * would use. Settings has no live Recipient or Issuer to show (it does not require the Portal to
 * be open), so those two segments use CONTEXT.md's own vocabulary as illustrative placeholders
 * rather than a fabricated OIB or company name; the trailing "…" stands in for the filename. */
function updateArchivePreview(): void {
  const today = systemClock.now();
  const directory = archiveDirectory({
    archiveRoot: archiveRootInput.value,
    recipientName: 'Recipient',
    issuerName: 'Issuer',
    datumIzdavanja: today,
  });
  archivePreviewEl.textContent = `${directory.join(' / ')} / …`;
}

async function loadSettings(): Promise<void> {
  const settings = await getSettings();
  accountantEmailInput.value = settings.accountantEmail;
  subjectTemplateInput.value = settings.subjectTemplate;
  archiveRootInput.value = settings.archiveRoot;
  updateSubjectPreview();
  updateArchivePreview();
}

subjectTemplateInput.addEventListener('input', updateSubjectPreview);
archiveRootInput.addEventListener('input', updateArchivePreview);

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setButtonBusy(settingsSaveButton, true);
  try {
    await setSettings({
      accountantEmail: accountantEmailInput.value,
      subjectTemplate: subjectTemplateInput.value,
      archiveRoot: archiveRootInput.value,
    });
    settingsStatus.textContent = 'Settings saved.';
  } finally {
    setButtonBusy(settingsSaveButton, false);
  }
});

void loadSettings();

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
