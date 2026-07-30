import { describe, expect, it } from 'vitest';
import type { BackfillPlan } from './backfill';
import type { BundlePlan } from './bundle';
import { formatBackfillOffer, formatBundleOffer, formatProgress, summarizeRun } from './report';
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

describe('formatBackfillOffer', () => {
  function plan(overrides: Partial<BackfillPlan> = {}): BackfillPlan {
    return { documentIds: [], recordsTotal: 0, estimatedMillis: 0, ...overrides };
  }

  it('shows the count straight from recordsTotal, before any Export is fetched', () => {
    expect(formatBackfillOffer(plan({ recordsTotal: 44 }))).toContain('Pronađeno dokumenata: 44.');
  });

  it('shows a whole-minute estimate, rounded, for a Run large enough to matter', () => {
    expect(formatBackfillOffer(plan({ recordsTotal: 90, estimatedMillis: 90_000 }))).toContain(
      'Procijenjeno trajanje: približno 2 min.',
    );
  });

  it('says "less than a minute" rather than "0 min" for a short estimate', () => {
    expect(formatBackfillOffer(plan({ recordsTotal: 3, estimatedMillis: 3_000 }))).toContain(
      'Procijenjeno trajanje: manje od minute.',
    );
  });

  it('reports zero Documents plainly, without an estimate line', () => {
    expect(formatBackfillOffer(plan({ recordsTotal: 0, estimatedMillis: 0 }))).toBe('Pronađeno dokumenata: 0.');
  });
});

describe('formatBundleOffer', () => {
  function plan(overrides: Partial<BundlePlan> = {}): BundlePlan {
    return { month: { year: 2026, month: 7 }, documents: [], totalSizeBytes: 0, ...overrides };
  }

  it('reports zero Documents plainly, without a size line', () => {
    expect(formatBundleOffer(plan())).toBe('Dokumenata za 07/2026: 0.');
  });

  it('shows the count and total size in MB for a month-sized Bundle', () => {
    const documents = Array.from({ length: 44 }, (_, i) => ({ documentId: i, filename: `${i}.xml`, bytes: new Uint8Array(0) }));
    expect(formatBundleOffer(plan({ documents, totalSizeBytes: 7 * 1024 * 1024 }))).toBe(
      'Dokumenata za 07/2026: 44. Ukupna veličina: 7,0 MB.',
    );
  });

  it('shows the total size in KB for a small Bundle', () => {
    const documents = [{ documentId: 1, filename: '1.xml', bytes: new Uint8Array(0) }];
    expect(formatBundleOffer(plan({ documents, totalSizeBytes: 2048 }))).toBe(
      'Dokumenata za 07/2026: 1. Ukupna veličina: 2,0 KB.',
    );
  });

  it('pads a single-digit month to two digits', () => {
    expect(formatBundleOffer(plan({ month: { year: 2026, month: 3 } }))).toBe('Dokumenata za 03/2026: 0.');
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
