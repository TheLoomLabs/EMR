import { describe, expect, it } from 'vitest';
import { formatProgress, summarizeRun } from './report';
import type { RunProgress, RunReport } from './run';

function emptyReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    filed: [],
    skipped: [],
    failed: [],
    yearStraddles: [],
    nepoznato: [],
    drift: [],
    ...overrides,
  };
}

describe('formatProgress', () => {
  it('names the Document being fetched, alongside the running totals', () => {
    const progress: RunProgress = { currentDocumentId: 42, filed: 2, skipped: 1, failed: 0 };
    expect(formatProgress(progress)).toBe('Dohvaćanje dokumenta 42… Zapisano: 2, preskočeno: 1, neuspjelo: 0.');
  });

  it('shows only the running totals when no Document is currently being fetched', () => {
    const progress: RunProgress = { currentDocumentId: null, filed: 2, skipped: 1, failed: 3 };
    expect(formatProgress(progress)).toBe('Zapisano: 2, preskočeno: 1, neuspjelo: 3.');
  });
});

describe('summarizeRun', () => {
  it('is entirely empty for a Run that filed, skipped and failed nothing', () => {
    expect(summarizeRun(emptyReport())).toEqual({
      headline: 'Zapisano: 0, preskočeno: 0, neuspjelo: 0.',
      failures: [],
      yearStraddles: [],
      nepoznato: [],
      drift: [],
    });
  });

  it('counts filed, skipped and failed Documents in the headline', () => {
    const report = emptyReport({
      filed: [
        { documentId: 1, directory: [], filenames: [] },
        { documentId: 2, directory: [], filenames: [] },
      ],
      skipped: [3],
      failed: [{ documentId: 4, error: 'boom' }],
    });

    expect(summarizeRun(report).headline).toBe('Zapisano: 2, preskočeno: 1, neuspjelo: 1.');
  });

  it("names each failure's Document and embeds its reason", () => {
    const report = emptyReport({
      failed: [{ documentId: 7, error: 'Dokumentu 7 nedostaje brojčano polje datumZaprimanja' }],
    });

    expect(summarizeRun(report).failures).toEqual([
      'Dokument 7: Dokumentu 7 nedostaje brojčano polje datumZaprimanja',
    ]);
  });

  it('lists every Year straddle by Document id, in Croatian', () => {
    const report = emptyReport({ yearStraddles: [9] });

    expect(summarizeRun(report).yearStraddles).toEqual([
      'Dokument 9: datum izdavanja i datum zaprimanja nisu u istoj godini (godišnji prijelaz) — provjerite ručno u Portalu.',
    ]);
  });

  it('lists every NEPOZNATO Document by id, noting it was still filed, in Croatian', () => {
    const report = emptyReport({ nepoznato: [11] });

    expect(summarizeRun(report).nepoznato).toEqual([
      'Dokument 11: nepoznata vrsta dokumenta (NEPOZNATO) — zapisan, ali provjerite ga ručno u Portalu.',
    ]);
  });

  it('lists every drifted vrstaDokumenta.code with its Document id, in Croatian', () => {
    const report = emptyReport({ drift: [{ documentId: 13, code: 9999 }] });

    expect(summarizeRun(report).drift).toEqual([
      'Dokument 13: šifra vrste dokumenta 9999 nije prepoznata (nije na popisu poznatih vrsta).',
    ]);
  });
});
