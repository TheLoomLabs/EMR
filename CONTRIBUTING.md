# Contributing to EMR

Thanks for considering contributing.

## Reporting a bug

- Search [existing issues](https://github.com/TheLoomLabs/EMR/issues) first — someone may have
  already reported it.
- Open a new one: https://github.com/TheLoomLabs/EMR/issues/new
- Include:
  - Browser (Chrome or Firefox) and version, and your OS.
  - What you did, what you expected to happen, and what happened instead.
  - Any error text EMR itself showed you, verbatim — its status and report areas are designed
    to be readable and specific, so quoting them exactly is usually enough to act on.

**Do not paste anything from a live Portal session.** An OIB, a Document/invoice number, a
business name, or a raw network capture (`.har` file) can easily end up in an error message or
a screenshot. Scrub these before attaching a screenshot, or describe the shape of the problem
instead of the literal data — "Document N in month M failed with error X" rather than the real
Document.

## Proposing a feature or change

Open an issue describing the *problem* before proposing a specific solution — it's easier to
discuss trade-offs before code exists than after. If it's a change to how EMR talks to the
Portal, say what Portal behaviour you're working around; a lot of this project's design follows
constraints of the government portal it drives (rate limits, session/token handling, the shape
of its export ZIPs) that aren't obvious from outside the code.

## Development setup

```
npm install
npm run dev            # Chrome, with hot reload
npm run dev:firefox    # Firefox, with hot reload
```

## Before opening a pull request

- `npm run compile` and `npm test` both pass.
- New pure logic (path computation, parsing, formatting, planning) lives in `utils/*.ts` and
  ships with a matching `utils/*.test.ts` — this project is test-first for that layer. The DOM
  wiring in `entrypoints/window/main.ts` is not unit-tested by convention; keep it thin rather
  than introducing test infrastructure for it.
- On-screen text is English. A few words are deliberately kept untranslated because the person
  reading them is cross-referencing the Portal tab open beside EMR: **eRačun**, **OIB**,
  **Prilog**, and the Document type suffixes (`ODOBRENJE`, `PREDUJAM`, `PREDRACUN`,
  `NEPOZNATO`). Everything else on screen should be English.
- Nothing EMR writes to disk changes without a deliberate reason. Archive folder names,
  filename suffixes, and the composed email's default subject are load-bearing — someone
  already using EMR would have their past Documents re-filed under new names if these drift,
  which defeats the point of a deterministic Archive.
- EMR is read-only against the Portal, and never reads back a file it has already written.
  Keep new behaviour consistent with that: recompute from the Portal's current list rather
  than trusting local state as a source of truth.

## Style

Keep pull requests small and focused, and reference the issue they close (`Closes #N`) where
one exists. Doc comments in this codebase explain *why* a non-obvious choice was made, not
*what* the code does — match that where you add one; delete a comment that only restates the
line below it.

## License

By contributing, you agree that your contribution is licensed under this project's
[AGPL-3.0-or-later license](LICENSE).
