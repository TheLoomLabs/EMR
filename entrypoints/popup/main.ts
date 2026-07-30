import type { ListDocumentsMessage, ListDocumentsResponse } from '@/utils/messages';
import { summarizeRow } from '@/utils/portal';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <h1>EMR</h1>
  <button id="list">Prikaži dokumente</button>
  <p id="status"></p>
  <ul id="rows"></ul>
`;

const button = document.querySelector<HTMLButtonElement>('#list')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const rowsList = document.querySelector<HTMLUListElement>('#rows')!;

button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Učitavanje…';
  rowsList.innerHTML = '';

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error('nema aktivne kartice');
    }

    const message: ListDocumentsMessage = { type: 'emr:list-documents' };
    const response = (await browser.tabs.sendMessage(tab.id, message)) as ListDocumentsResponse | undefined;

    if (!response) {
      throw new Error('nema odgovora — otvorite Ulazni dokumenti u Portalu');
    }
    if (!response.ok) {
      throw new Error(response.error);
    }

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
