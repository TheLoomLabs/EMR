import { DownloadsArchivePort } from '@/utils/archive';
import { systemClock } from '@/utils/clock';
import type {
  ExportDocumentMessage,
  ExportDocumentResponse,
  ListDocumentsMessage,
  ListDocumentsResponse,
} from '@/utils/messages';
import { summarizeRow } from '@/utils/portal';
import { runOne, type RunPortalPort } from '@/utils/run';
import { getSettings, isFiled, markFiled } from '@/utils/store';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <h1>EMR</h1>
  <button id="list">Prikaži dokumente</button>
  <button id="preuzmi">Preuzmi</button>
  <p id="status"></p>
  <ul id="rows"></ul>
`;

const button = document.querySelector<HTMLButtonElement>('#list')!;
const preuzmiButton = document.querySelector<HTMLButtonElement>('#preuzmi')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const rowsList = document.querySelector<HTMLUListElement>('#rows')!;

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

preuzmiButton.addEventListener('click', async () => {
  preuzmiButton.disabled = true;
  status.textContent = 'Preuzimanje…';

  try {
    const result = await runOne({
      portal: relayPortalPort,
      archive: new DownloadsArchivePort(),
      store: { getSettings, isFiled, markFiled },
      clock: systemClock,
    });

    status.textContent = result.filed
      ? `Zapisan dokument ${result.documentId}.`
      : 'Nema novih dokumenata za preuzimanje.';
  } catch (error) {
    status.textContent = `Greška: ${(error as Error).message}`;
  } finally {
    preuzmiButton.disabled = false;
  }
});
