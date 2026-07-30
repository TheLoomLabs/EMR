document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <h1>Postavke</h1>
  <form id="settings-form">
    <label>
      E-mail adresa knjigovođe
      <input type="email" id="accountantEmail" name="accountantEmail" />
    </label>
    <label>
      Predložak naslova e-maila
      <input type="text" id="subjectTemplate" name="subjectTemplate" />
    </label>
    <label>
      Naziv korijenske mape arhive
      <input type="text" id="archiveRoot" name="archiveRoot" />
    </label>
    <button type="submit">Spremi</button>
    <p id="status" role="status"></p>
  </form>
`;

const form = document.querySelector<HTMLFormElement>('#settings-form')!;
const accountantEmailInput = document.querySelector<HTMLInputElement>('#accountantEmail')!;
const subjectTemplateInput = document.querySelector<HTMLInputElement>('#subjectTemplate')!;
const archiveRootInput = document.querySelector<HTMLInputElement>('#archiveRoot')!;
const statusMessage = document.querySelector<HTMLParagraphElement>('#status')!;

async function loadSettings() {
  const settings = await getSettings();
  accountantEmailInput.value = settings.accountantEmail;
  subjectTemplateInput.value = settings.subjectTemplate;
  archiveRootInput.value = settings.archiveRoot;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await setSettings({
    accountantEmail: accountantEmailInput.value,
    subjectTemplate: subjectTemplateInput.value,
    archiveRoot: archiveRootInput.value,
  });
  statusMessage.textContent = 'Postavke spremljene.';
});

loadSettings();
