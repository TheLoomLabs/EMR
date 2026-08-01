# EMR

EMR is a browser extension for Chrome and Firefox that automates filing incoming eRačuni
(e-invoices) received through Croatia's Tax Administration **MIKROeRAČUN** portal, and
forwards a month's worth of them to an accountant.

## The problem it solves

A business using MIKROeRAČUN receives its incoming e-invoices ("eRačuni") through the Portal,
but nothing else happens automatically. Filing them means opening the Portal, exporting each
Document one at a time, unpacking the ZIP, working out which file inside is the actual
invoice, renaming it into something recognisable, and dropping it into the right folder — then
attaching a month's worth to an email for the accountant. It's slow, and worse, it's quietly
unreliable: the Portal has no "unfiled" indicator, so a missed Document is invisible until
someone notices it's missing.

## What EMR does

EMR opens its own window from the toolbar icon, with three sections:

- **Download** — lists the current Recipient's Documents, grouped by Issuer, and fetches every
  unseen one's Export into a local Archive folder tree
  (`Recipient / year / month / Issuer / …`). The first run offers a bounded backfill — a count
  and a time estimate — before fetching anything.
- **Send** — composes one calendar month of already-filed Documents into a `.eml` (the
  original eRačun XMLs, byte-for-byte) addressed to your accountant, and opens it in your
  default mail client. Nothing is sent until you press send there.
- **Settings** — one or more accountant email addresses (every Bundle goes to all of them), the
  subject template, and the Archive's root folder name.

A few things are true throughout:

- EMR never writes anything back to the Portal — it only reads.
- EMR never reads back a file it has already written; every action recomputes from the
  Portal's current list, so losing local state costs a re-fetch, never correctness.
- Archive folder names, filenames and the composed email's default subject are deterministic
  and intentionally left as the Portal and your accountant already expect (Croatian), even
  though the interface itself is in English.
- A handful of words stay untranslated on screen — **eRačun**, **OIB**, **Prilog**, and the
  Document type names (`ODOBRENJE`, `PREDUJAM`, `PREDRACUN`, `NEPOZNATO`) — so what you read
  here still matches the Portal tab open beside it.

## Installing

EMR isn't published to the Chrome Web Store or addons.mozilla.org yet — install it from
source:

```
git clone https://github.com/TheLoomLabs/EMR.git
cd EMR
npm install
npm run build             # .output/chrome-mv3, or: npm run build:firefox
```

Then load it unpacked:

- **Chrome**: `chrome://extensions` → enable Developer mode → *Load unpacked* →
  `.output/chrome-mv3`.
- **Firefox**: `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → any file
  inside `.output/firefox-mv3`.

EMR needs a MIKROeRAČUN Portal tab open and signed in — it reads Documents from the Portal
page itself rather than talking to the Portal's API independently.

## Developing

Requires Node.js. `make help` lists every target below as a Make wrapper, if you prefer that.

```
npm install
npm run dev            # Chrome, with hot reload
npm run dev:firefox    # Firefox, with hot reload
```

### Building

```
npm run build           # .output/chrome-mv3
npm run build:firefox   # .output/firefox-mv3
```

### Testing

```
npm test        # vitest — the pure logic in utils/*.ts
npm run compile # tsc --noEmit
```

This project keeps a deliberate split: the logic worth asserting — path computation, filename
derivation, document-type marking, the Run/Backfill/Bundle planning, report formatting, window
geometry — lives in `utils/*.ts`, pure and unit-tested one-to-one with a `utils/*.test.ts`. The
DOM wiring in `entrypoints/window/main.ts` is intentionally left untested directly; it's kept
thin enough that reading it is sufficient, rather than adding a DOM test harness to a project
this size.

## Project layout

```
entrypoints/
  background.ts         service worker — opens or focuses the window on toolbar click
  content.ts             content script — relays Portal requests from the page itself
  apptoken.content.ts    reads the Portal's own session token out of the page
  window/                 the extension's UI (Download / Send / Settings) — vanilla TS + DOM
utils/
  *.ts / *.test.ts       pure logic: filing rules, the Portal client, Run/Backfill/Bundle
                          planning, report formatting, window geometry — each tested in isolation
public/icon/             toolbar icon, 16–128px
```

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for how to
report an issue, propose a change, and what a pull request is expected to satisfy before
review.

## License

EMR is licensed under the **GNU Affero General Public License v3.0 or later**
(`AGPL-3.0-or-later`) — see [LICENSE](LICENSE) for the full text. In short: it's copyleft, and
stronger than the plain GPL — if you distribute a modified version, including one only offered
as a network service, you must make that version's source available under the same license.
