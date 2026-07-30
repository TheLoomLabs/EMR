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
import { formatBackfillOffer, formatBundleOffer, formatProgress, summarizeRun } from '@/utils/report';
import { run, type RunPortalPort, type RunReport } from '@/utils/run';
import { cacheEracun, getCachedEracun, getSettings, hasFiledAny, isFiled, markFiled, pruneEracunCache } from '@/utils/store';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <h1>EMR</h1>
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
`;

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

/** Sends `message` to the active tab's content script and unwraps its `{ok, ...} | {ok:false,
 * error}` envelope (ADR-0005 — only that content script can reach the Portal's origin and its
 * live apptoken), throwing on either no response or an `ok:false` one. */
async function sendToPortal<Response extends { ok: true } | { ok: false; error: string }>(
  message: unknown,
): Promise<Extract<Response, { ok: true }>> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('nema aktivne kartice');
  }

  const response = (await browser.tabs.sendMessage(tab.id, message)) as Response | undefined;
  if (!response) {
    throw new Error('nema odgovora — otvorite Ulazni dokumenti u Portalu');
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response as Extract<Response, { ok: true }>;
}

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
 * the popup itself has no access to the Portal's origin or its live apptoken. */
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
// at any time (ADR-0004), so nothing here needs to survive the popup closing.
let lastReport: RunReport | null = null;

/** Runs a Preuzmi, live-updating `status` as each Document is fetched (issue #10) and rendering
 * the Croatian summary once it ends. `documentIds`, when given, restricts the walk to just those
 * ids — how the retry-failures button re-runs only what previously failed. */
async function preuzmi(documentIds?: readonly number[]): Promise<void> {
  preuzmiButton.disabled = true;
  retryButton.disabled = true;
  status.textContent = 'Preuzimanje…';

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
