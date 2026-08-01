import { DownloadsArchivePort } from '@/utils/archive';
import type { BackfillPlan, BackfillPort } from '@/utils/backfill';
import { planBackfill } from '@/utils/backfill';
import { composeBundle, planBundle, type BundleMonth, type BundlePlan, type BundlePortalPort } from '@/utils/bundle';
import { bundleFilename, bundleMonthLabel, bundleSubject, isReachableBundleMonth, MONTH_NAMES, reachableYearRange } from '@/utils/bundle';
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
import { groupByIssuer, type IssuerGroup } from '@/utils/portal';
import { PORTAL_ORIGIN, selectPortalTab } from '@/utils/portal-tab';
import {
  formatBackfillOffer,
  formatBundleOffer,
  progressPercent,
  summarizeRun,
  type ReportNotice,
  type ReportNoticeSeverity,
} from '@/utils/report';
import { planWindowRect } from '@/utils/window-geometry';
import { run, type RunPortalPort, type RunProgress, type RunReport } from '@/utils/run';
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
          <div class="offer" id="backfill-offer" hidden>
            <div class="txt"><strong id="backfill-offer-text"></strong></div>
            <div class="actions">
              <button id="backfill-decline" class="btn btn-ghost">Not now</button>
              <button id="backfill-start" class="btn btn-primary">Start</button>
            </div>
          </div>

          <div class="card" id="run-card">
            <div class="card-body">
              <div class="result" id="run-result">
                <div class="glyph" id="run-glyph">↓</div>
                <div>
                  <div class="headline" id="run-headline">Ready</div>
                  <div class="sub" id="run-sub">Press Run download to fetch new Documents from the Portal.</div>
                </div>
                <div class="actions">
                  <button id="retry" class="btn btn-secondary" hidden>Retry failed</button>
                  <button id="preuzmi" class="btn btn-primary btn-lg">Run download</button>
                </div>
              </div>

              <div class="progress" id="run-progress" hidden>
                <div class="track"><div class="fill" id="progress-fill" style="width: 0%"></div></div>
                <div class="legend">
                  <span class="now" id="progress-now"></span>
                  <span id="progress-issuer"></span>
                  <span class="tally" id="progress-tally"></span>
                </div>
              </div>

              <div class="stats" id="run-stats" hidden>
                <div class="stat ok"><div class="v" id="stat-filed">0</div><div class="k">Filed</div></div>
                <div class="stat"><div class="v" id="stat-skipped">0</div><div class="k">Skipped</div></div>
                <div class="stat bad"><div class="v" id="stat-failed">0</div><div class="k">Failed</div></div>
              </div>
            </div>
          </div>

          <p id="status"></p>
          <div id="notices"></div>

          <div class="card" id="documents-card">
            <div class="card-head">
              <h2>Documents</h2>
              <span class="count" id="documents-count"></span>
            </div>
            <div class="groups" id="groups"></div>
          </div>
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
                <label for="bundle-month-trigger">Month</label>
                <div class="month-picker" id="month-picker">
                  <button
                    type="button"
                    id="bundle-month-trigger"
                    class="month-trigger"
                    aria-haspopup="true"
                    aria-expanded="false"
                  >
                    <span id="bundle-month-trigger-text">Choose a month</span>
                    <span class="chev" aria-hidden="true">▾</span>
                  </button>
                  <div class="month-panel" id="month-panel" hidden>
                    <div class="month-panel-year">
                      <button type="button" id="month-year-prev" class="month-year-step" aria-label="Previous year">‹</button>
                      <span class="month-year-label" id="month-year-label"></span>
                      <button type="button" id="month-year-next" class="month-year-step" aria-label="Next year">›</button>
                    </div>
                    <div class="month-grid" id="month-grid"></div>
                  </div>
                </div>
                <div class="hint">A Bundle is always exactly one month of one Recipient.</div>
              </div>
              <div class="actions">
                <button id="posalji" class="btn btn-primary">Prepare message</button>
              </div>
            </div>
          </div>

          <div class="notice warn" id="accountant-missing" hidden>
            <span class="ico">⚠</span>
            <div>
              <h3>Accountant email isn't set</h3>
              <p>Add the Accountant's email address in Settings before sending a Bundle.</p>
              <div class="actions">
                <button id="go-to-settings" type="button" class="btn btn-secondary">Go to Settings</button>
              </div>
            </div>
          </div>

          <div class="offer" id="bundle-offer" hidden>
            <div class="txt"><strong id="bundle-offer-text"></strong></div>
            <div class="actions">
              <button id="bundle-cancel" class="btn btn-ghost">Cancel</button>
              <button id="bundle-compose" class="btn btn-primary">Compose</button>
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

const preuzmiButton = document.querySelector<HTMLButtonElement>('#preuzmi')!;
const retryButton = document.querySelector<HTMLButtonElement>('#retry')!;
const backfillOffer = document.querySelector<HTMLDivElement>('#backfill-offer')!;
const backfillOfferText = document.querySelector<HTMLElement>('#backfill-offer-text')!;
const backfillStartButton = document.querySelector<HTMLButtonElement>('#backfill-start')!;
const backfillDeclineButton = document.querySelector<HTMLButtonElement>('#backfill-decline')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const documentsCountEl = document.querySelector<HTMLSpanElement>('#documents-count')!;
const groupsEl = document.querySelector<HTMLDivElement>('#groups')!;

const runResultEl = document.querySelector<HTMLDivElement>('#run-result')!;
const runGlyphEl = document.querySelector<HTMLDivElement>('#run-glyph')!;
const runHeadlineEl = document.querySelector<HTMLDivElement>('#run-headline')!;
const runSubEl = document.querySelector<HTMLDivElement>('#run-sub')!;
const runProgressEl = document.querySelector<HTMLDivElement>('#run-progress')!;
const progressFillEl = document.querySelector<HTMLDivElement>('#progress-fill')!;
const progressNowEl = document.querySelector<HTMLSpanElement>('#progress-now')!;
const progressIssuerEl = document.querySelector<HTMLSpanElement>('#progress-issuer')!;
const progressTallyEl = document.querySelector<HTMLSpanElement>('#progress-tally')!;
const runStatsEl = document.querySelector<HTMLDivElement>('#run-stats')!;
const statFiledEl = document.querySelector<HTMLDivElement>('#stat-filed')!;
const statSkippedEl = document.querySelector<HTMLDivElement>('#stat-skipped')!;
const statFailedEl = document.querySelector<HTMLDivElement>('#stat-failed')!;
const noticesEl = document.querySelector<HTMLDivElement>('#notices')!;

const monthPickerEl = document.querySelector<HTMLDivElement>('#month-picker')!;
const monthTriggerButton = document.querySelector<HTMLButtonElement>('#bundle-month-trigger')!;
const monthTriggerTextEl = document.querySelector<HTMLSpanElement>('#bundle-month-trigger-text')!;
const monthPanelEl = document.querySelector<HTMLDivElement>('#month-panel')!;
const monthYearLabelEl = document.querySelector<HTMLSpanElement>('#month-year-label')!;
const monthYearPrevButton = document.querySelector<HTMLButtonElement>('#month-year-prev')!;
const monthYearNextButton = document.querySelector<HTMLButtonElement>('#month-year-next')!;
const monthGridEl = document.querySelector<HTMLDivElement>('#month-grid')!;
const posaljiButton = document.querySelector<HTMLButtonElement>('#posalji')!;
const accountantMissing = document.querySelector<HTMLDivElement>('#accountant-missing')!;
const goToSettingsButton = document.querySelector<HTMLButtonElement>('#go-to-settings')!;
const bundleOffer = document.querySelector<HTMLDivElement>('#bundle-offer')!;
const bundleOfferText = document.querySelector<HTMLElement>('#bundle-offer-text')!;
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
    throw new Error('No response — reload the Portal tab and try again.');
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response as Extract<Response, { ok: true }>;
}

/** True for the duration of a Run download (issue #10's Run) — while one is in flight, the Portal
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
let portalWasConnected = false;

async function refreshPortalAvailability(): Promise<void> {
  const tabId = await findPortalTabId();
  const connected = tabId !== undefined;
  updatePortalIndicator(connected);

  if (!runInProgress) {
    for (const gate of portalGatedSections) {
      gate.noPortal.hidden = connected;
      gate.content.hidden = !connected;
    }
  }

  // Loads Documents the moment the Portal becomes reachable (issue #23) — not on every
  // Portal-status refresh, which `tabs.onUpdated` fires far more often than the connection
  // itself actually changes.
  if (connected && !portalWasConnected) {
    void loadDocuments();
  }
  portalWasConnected = connected;
}

browser.tabs.onCreated.addListener(() => void refreshPortalAvailability());
browser.tabs.onRemoved.addListener(() => void refreshPortalAvailability());
browser.tabs.onUpdated.addListener(() => void refreshPortalAvailability());
void refreshPortalAvailability();

/** Builds the empty state for the Documents card (issue #23's acceptance: "Zero Documents
 * renders a designed empty state, not a blank panel") — the same `.empty` block Download's own
 * "Portal isn't open" card already uses, so an empty inbox reads as a designed screen rather
 * than as a bug. */
function renderEmptyDocuments(): void {
  const empty = document.createElement('div');
  empty.className = 'empty';

  const icon = document.createElement('div');
  icon.className = 'ico';
  icon.textContent = '○';
  empty.appendChild(icon);

  const heading = document.createElement('h3');
  heading.textContent = 'No Documents yet';
  empty.appendChild(heading);

  const paragraph = document.createElement('p');
  paragraph.textContent = 'Nothing has arrived from the Portal yet. Documents will appear here as soon as your Recipient receives one.';
  empty.appendChild(paragraph);

  groupsEl.appendChild(empty);
}

/** Renders Documents grouped by Issuer (issue #23), replacing the old flat, button-gated list.
 * `groupByIssuer` (utils/portal.ts) does the grouping; this only arranges the result — one
 * `<details>` per Issuer, open by default, so seeing the Documents needs no further click
 * either at the section level or at the group level. Only the Issuer name and `brojDokumenta`
 * are shown — the OIB is the grouping key, not a displayed field. Every dynamic string is
 * written with `textContent`, never `innerHTML`, so Portal data can never be interpreted as
 * markup. */
function renderDocumentGroups(groups: readonly IssuerGroup[], filedIds: ReadonlySet<number>): void {
  groupsEl.innerHTML = '';

  const totalDocuments = groups.reduce((sum, group) => sum + group.documents.length, 0);
  documentsCountEl.textContent = `${totalDocuments} in the Portal · ${groups.length} ${groups.length === 1 ? 'Issuer' : 'Issuers'}`;

  if (groups.length === 0) {
    renderEmptyDocuments();
    return;
  }

  for (const group of groups) {
    const details = document.createElement('details');
    details.className = 'group';
    details.open = true;

    const summary = document.createElement('summary');

    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = '▶';
    summary.appendChild(caret);

    const issuerName = document.createElement('span');
    issuerName.className = 'issuer';
    issuerName.textContent = group.name;
    summary.appendChild(issuerName);

    const count = document.createElement('span');
    count.className = 'n';
    count.textContent = String(group.documents.length);
    summary.appendChild(count);

    details.appendChild(summary);

    const docsList = document.createElement('ul');
    docsList.className = 'docs';
    for (const doc of group.documents) {
      const filed = filedIds.has(doc.id);
      const item = document.createElement('li');
      item.className = filed ? 'filed' : 'new';

      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = filed ? '✓' : '●';
      mark.title = filed ? 'Filed' : 'Not filed yet';
      item.appendChild(mark);

      item.appendChild(document.createTextNode(doc.brojDokumenta));
      docsList.appendChild(item);
    }
    details.appendChild(docsList);

    groupsEl.appendChild(details);
  }
}

/** Loads and renders the Documents card as soon as the Portal is reachable (issue #23's
 * acceptance: "opening Download lists Documents without a further click") — no button gates
 * this any more. Called on Download's first Portal connection and again after every Run download, so
 * newly arrived Documents and freshly Filed ones both show up without a manual refresh. */
async function loadDocuments(): Promise<void> {
  groupsEl.innerHTML = '';
  documentsCountEl.textContent = '';
  const loading = document.createElement('p');
  loading.textContent = 'Loading Documents…';
  groupsEl.appendChild(loading);

  try {
    const message: ListDocumentsMessage = { type: 'emr:list-documents' };
    const response = await sendToPortal<ListDocumentsResponse>(message);
    const groups = groupByIssuer(response.rows);
    const filedEntries = await Promise.all(response.rows.map(async (row) => [row.id, await isFiled(row.id)] as const));
    const filedIds = new Set(filedEntries.filter(([, filed]) => filed).map(([id]) => id));
    renderDocumentGroups(groups, filedIds);
  } catch (error) {
    groupsEl.innerHTML = '';
    documentsCountEl.textContent = '';
    const p = document.createElement('p');
    p.textContent = `Error: ${(error as Error).message}`;
    groupsEl.appendChild(p);
  }
}

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

/** Live progress (issue #24): a bar against the Run's total, the in-flight Document named by its
 * `broj` and Issuer — never a bare id — alongside running filed/skipped/failed totals. Between
 * Documents `progress.current` is `null`, including while a skip-check is happening, so only the
 * totals show; `progressPercent` (utils/report.ts) is the seam's own answer to "is this nearly
 * done?", never recomputed here. */
function renderProgress(progress: RunProgress): void {
  progressFillEl.style.width = `${progressPercent(progress)}%`;

  if (progress.current) {
    progressNowEl.textContent = `Fetching ${progress.current.broj}`;
    progressIssuerEl.textContent = `· ${progress.current.issuerName}`;
  } else {
    progressNowEl.textContent = '';
    progressIssuerEl.textContent = '';
  }

  const processed = progress.filed + progress.skipped + progress.failed;
  progressTallyEl.textContent = `${processed} / ${progress.total} · ${progress.filed} filed · ${progress.skipped} skipped · ${progress.failed} failed`;
}

/** One notice's display text, built from utils/report.ts's structured `ReportNotice` — the
 * prose lives here, in the renderer, not in the seam (issue #24). */
function noticeText(notice: ReportNotice): string {
  switch (notice.kind) {
    case 'failed':
      return `Document ${notice.broj} (${notice.issuerName}) — ${notice.reason}`;
    case 'yearStraddle':
      return `Year straddle — Document ${notice.broj} (${notice.issuerName}), filed under ${notice.filedYear}.`;
    case 'nepoznato':
      return `Unknown type (NEPOZNATO) — Document ${notice.broj} (${notice.issuerName}), filed but worth checking in the Portal.`;
    case 'drift':
      return `Unrecognised type code — Document ${notice.broj} (${notice.issuerName}) carries type code ${notice.code}, not on our list.`;
  }
}

/** One severity-graded notice block — red for `failed` ("not filed, act on this"), amber for
 * `attention` ("filed, but go and look in the Portal"). Appends nothing when there is nothing to
 * say, so an ordinary clean Run shows neither block. Built with `createElement` and
 * `textContent`, never `innerHTML`, so a failure's reason (utils/run.ts's RunError messages,
 * embedded verbatim by utils/report.ts) can never be interpreted as markup. */
function renderNoticeBlock(severity: ReportNoticeSeverity, heading: string, notices: readonly ReportNotice[]): void {
  if (notices.length === 0) return;

  const block = document.createElement('div');
  block.className = severity === 'failed' ? 'notice bad' : 'notice warn';

  const icon = document.createElement('span');
  icon.className = 'ico';
  icon.textContent = severity === 'failed' ? '✕' : '!';
  block.appendChild(icon);

  const body = document.createElement('div');
  const h3 = document.createElement('h3');
  h3.textContent = heading;
  body.appendChild(h3);

  const list = document.createElement('ul');
  for (const notice of notices) {
    const item = document.createElement('li');
    item.textContent = noticeText(notice);
    list.appendChild(item);
  }
  body.appendChild(list);
  block.appendChild(body);

  noticesEl.appendChild(block);
}

/** The end-of-Run report (issue #24): opens with whether anything needs attention, before any
 * detail; filed/skipped/failed as counters; failures red and named by Document and reason;
 * Year straddles, NEPOZNATO and code drift amber and never read as failures — the severity split
 * comes straight from `summarizeRun` (utils/report.ts), decided there, not here. */
function renderReport(report: RunReport): void {
  const summary = summarizeRun(report);
  // A single Document can carry more than one notice (e.g. NEPOZNATO and code drift together),
  // so the headline counts distinct Documents needing a look, not raw notices — otherwise one
  // Document could be reported as two.
  const documentsNeedingAttention = new Set(summary.notices.map((notice) => notice.documentId)).size;

  runResultEl.classList.toggle('has-warn', summary.needsAttention);
  runGlyphEl.textContent = summary.needsAttention ? '!' : '✓';
  runHeadlineEl.textContent = summary.needsAttention
    ? `Run finished — ${documentsNeedingAttention} ${documentsNeedingAttention === 1 ? 'Document needs' : 'Documents need'} a look`
    : 'Run finished — up to date';
  runSubEl.textContent = 'Everything that could be filed, was. Nothing was lost.';

  runProgressEl.hidden = true;
  runStatsEl.hidden = false;
  statFiledEl.textContent = String(summary.filed);
  statSkippedEl.textContent = String(summary.skipped);
  statFailedEl.textContent = String(summary.failed);

  noticesEl.innerHTML = '';
  renderNoticeBlock(
    'failed',
    'Failed — not filed',
    summary.notices.filter((notice) => notice.severity === 'failed'),
  );
  renderNoticeBlock(
    'attention',
    'Filed, but worth checking in the Portal',
    summary.notices.filter((notice) => notice.severity === 'attention'),
  );

  retryButton.hidden = report.failed.length === 0;
}

// Kept only so "Retry failed" knows which Document ids to retry — Runs are safe to repeat
// at any time (ADR-0004), so nothing here needs to survive the window closing.
let lastReport: RunReport | null = null;

/** Runs a Run download, live-updating the progress bar as each Document is fetched (issue #24) and
 * rendering the report once it ends. `documentIds`, when given, restricts the walk to just those
 * ids — how the retry-failures button re-runs only what previously failed. */
async function preuzmi(documentIds?: readonly number[]): Promise<void> {
  setButtonBusy(preuzmiButton, true);
  retryButton.disabled = true;
  status.textContent = '';
  runInProgress = true;

  runResultEl.classList.remove('has-warn');
  runGlyphEl.textContent = '↓';
  runHeadlineEl.textContent = 'Downloading…';
  runSubEl.textContent = 'Documents already filed are skipped without being fetched.';
  runStatsEl.hidden = true;
  noticesEl.innerHTML = '';
  runProgressEl.hidden = false;
  renderProgress({ total: 0, current: null, filed: 0, skipped: 0, failed: 0 });

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
        onProgress: renderProgress,
      },
    );

    lastReport = report;
    renderReport(report);
  } catch (error) {
    runProgressEl.hidden = true;
    runGlyphEl.textContent = '↓';
    runHeadlineEl.textContent = 'Ready';
    runSubEl.textContent = 'Press Run download to fetch new Documents from the Portal.';
    status.textContent = `Error: ${(error as Error).message}`;
  } finally {
    setButtonBusy(preuzmiButton, false);
    retryButton.disabled = false;
    runInProgress = false;
    void refreshPortalAvailability();
    void loadDocuments();
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
 * the Filed set empty, so the next Run download click offers backfill again — no separate
 * persisted "declined" state is needed (ADR-0004's promise: losing state costs bandwidth, never
 * correctness, extended to this decision too). */
preuzmiButton.addEventListener('click', async () => {
  preuzmiButton.disabled = true;
  try {
    if (!(await hasFiledAny())) {
      status.textContent = 'Checking…';
      const plan = await planBackfill(relayBackfillPort, systemClock);
      pendingBackfillPlan = plan;
      backfillOfferText.textContent = formatBackfillOffer(plan);
      backfillOffer.hidden = false;
      status.textContent = '';
      return;
    }
  } catch (error) {
    status.textContent = `Error: ${(error as Error).message}`;
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

/** The month picker (issue #29): a trigger button opening a panel with a year stepper and a
 * twelve-month grid, replacing `<input type="month">` — unimplemented on Firefox, where it
 * degrades to a plain text box (the ticket's own motivation). Nothing is preselected; the panel
 * opens on the chosen month's year, or the current Zagreb year when nothing is chosen yet
 * (acceptance). `selectedBundleMonth` is this window's only source of truth for Send's month —
 * there is no hidden input mirroring it, since nothing else needs to read it as a string. */
let selectedBundleMonth: BundleMonth | undefined;
let monthPanelYear = zagrebDate(systemClock.now()).year;

function updateMonthTrigger(): void {
  monthTriggerTextEl.textContent = selectedBundleMonth ? bundleMonthLabel(selectedBundleMonth) : 'Choose a month';
}

/** Redraws the year stepper and the twelve-month grid for `monthPanelYear` — called on open and
 * on every year-step, since which months are disabled depends on the year showing. Months after
 * the current Zagreb month render disabled rather than being omitted (acceptance: a grid missing
 * its last cells reads as a rendering fault, a grid with greyed cells reads as a rule). */
function renderMonthPanel(): void {
  const now = systemClock.now();
  const { min, max } = reachableYearRange(now);
  monthYearLabelEl.textContent = String(monthPanelYear);
  monthYearPrevButton.disabled = monthPanelYear <= min;
  monthYearNextButton.disabled = monthPanelYear >= max;

  monthGridEl.innerHTML = '';
  for (let month = 1; month <= 12; month++) {
    const candidate: BundleMonth = { year: monthPanelYear, month };
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'month-cell';
    cell.textContent = MONTH_NAMES[month - 1].slice(0, 3);
    cell.title = MONTH_NAMES[month - 1];
    cell.disabled = !isReachableBundleMonth(candidate, now);
    if (selectedBundleMonth && selectedBundleMonth.year === candidate.year && selectedBundleMonth.month === candidate.month) {
      cell.classList.add('selected');
      cell.setAttribute('aria-current', 'true');
    }
    cell.addEventListener('click', () => {
      selectedBundleMonth = candidate;
      updateMonthTrigger();
      closeMonthPanel();
    });
    monthGridEl.appendChild(cell);
  }
}

function handleMonthPanelOutsideClick(event: MouseEvent): void {
  if (event.target instanceof Node && monthPickerEl.contains(event.target)) return;
  closeMonthPanel();
}

function handleMonthPanelKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMonthPanel();
  }
}

function openMonthPanel(): void {
  monthPanelYear = selectedBundleMonth ? selectedBundleMonth.year : zagrebDate(systemClock.now()).year;
  renderMonthPanel();
  monthPanelEl.hidden = false;
  monthTriggerButton.setAttribute('aria-expanded', 'true');
  document.addEventListener('click', handleMonthPanelOutsideClick, true);
  document.addEventListener('keydown', handleMonthPanelKeydown, true);
}

function closeMonthPanel(): void {
  if (monthPanelEl.hidden) return;
  monthPanelEl.hidden = true;
  monthTriggerButton.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', handleMonthPanelOutsideClick, true);
  document.removeEventListener('keydown', handleMonthPanelKeydown, true);
  monthTriggerButton.focus();
}

monthTriggerButton.addEventListener('click', () => {
  if (monthPanelEl.hidden) {
    openMonthPanel();
  } else {
    closeMonthPanel();
  }
});

monthYearPrevButton.addEventListener('click', () => {
  monthPanelYear -= 1;
  renderMonthPanel();
});

monthYearNextButton.addEventListener('click', () => {
  monthPanelYear += 1;
  renderMonthPanel();
});

let pendingBundlePlan: BundlePlan | null = null;

function hideBundleOffer(): void {
  bundleOffer.hidden = true;
  pendingBundlePlan = null;
}

/** Send (CONTEXT.md "Bundle"; ADR-0003): plans a month's Bundle and shows its total size before
 * anything is composed (issue #12's acceptance), mirroring the backfill offer's plan-then-confirm
 * shape above. A missing Accountant address reads as a setup gap pointing at Settings, not an
 * error (issue #25) — `accountantMissing`, not `bundleStatus`, carries that message, with its own
 * action rather than leaving the person to find Settings on their own. A month with no Documents
 * says so in `bundleStatus` rather than opening an offer with nothing to Compose (issue #25). */
posaljiButton.addEventListener('click', async () => {
  const month = selectedBundleMonth;
  if (!month) {
    bundleStatus.textContent = 'Choose a month.';
    return;
  }

  setButtonBusy(posaljiButton, true);
  accountantMissing.hidden = true;
  hideBundleOffer();
  bundleStatus.textContent = 'Checking…';
  try {
    // Checked here, not just left for composeBundle to embed an empty To: — settings.accountantEmail
    // is what the acceptance criterion means by "the recipient address ... come[s] from settings",
    // and a blank one is a setup gap the user can fix in Settings, not something to compose past.
    const settings = await getSettings();
    if (!settings.accountantEmail) {
      bundleStatus.textContent = '';
      accountantMissing.hidden = false;
      return;
    }

    const plan = await planBundle(relayBundlePort, { getCachedEracun }, month);
    if (plan.documents.length === 0) {
      bundleStatus.textContent = formatBundleOffer(plan);
      return;
    }
    pendingBundlePlan = plan;
    bundleOfferText.textContent = formatBundleOffer(plan);
    bundleOffer.hidden = false;
    bundleStatus.textContent = '';
  } catch (error) {
    bundleStatus.textContent = `Error: ${(error as Error).message}`;
  } finally {
    setButtonBusy(posaljiButton, false);
  }
});

// The setup gap's own action: jumps straight to the field that needs filling in, rather than
// leaving the person to find Settings on their own (issue #25).
goToSettingsButton.addEventListener('click', () => {
  accountantMissing.hidden = true;
  switchSection('settings');
  accountantEmailInput.focus();
});

bundleComposeButton.addEventListener('click', async () => {
  const plan = pendingBundlePlan;
  if (!plan) return;

  setButtonBusy(bundleComposeButton, true);
  bundleStatus.textContent = 'Composing…';
  try {
    const settings = await getSettings();
    const eml = composeBundle(plan, settings);
    await new DownloadsEmlWriterPort().writeAndOpen(bundleFilename(settings.subjectTemplate, plan.month), eml);
    bundleStatus.textContent = 'Message composed and opened.';
    hideBundleOffer();
  } catch (error) {
    bundleStatus.textContent = `Error: ${(error as Error).message}`;
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
