import { describe, expect, it } from 'vitest';
import type { BackfillPlan } from './backfill';
import type { BundlePlan } from './bundle';
import { formatBackfillOffer, formatBundleOffer, progressPercent, summarizeRun } from './report';
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

describe('progressPercent', () => {
  it('is the share of the Run total that has been processed — filed, skipped and failed all count', () => {
    const progress: RunProgress = { total: 44, current: null, filed: 10, skipped: 15, failed: 3 };
    expect(progressPercent(progress)).toBe(Math.round((28 / 44) * 100));
  });

  it('does not count a Document currently in flight as processed yet', () => {
    const progress: RunProgress = {
      total: 10,
      current: { documentId: 1, broj: '1/1/1', issuerName: 'Izdavatelj d.o.o.' },
      filed: 2,
      skipped: 0,
      failed: 0,
    };
    expect(progressPercent(progress)).toBe(20);
  });

  it('is 0 for a Run of zero Documents, rather than dividing by zero', () => {
    expect(progressPercent({ total: 0, current: null, filed: 0, skipped: 0, failed: 0 })).toBe(0);
  });

  it('is 100 once every Document has been processed', () => {
    expect(progressPercent({ total: 5, current: null, filed: 3, skipped: 2, failed: 0 })).toBe(100);
  });
});

describe('formatBackfillOffer', () => {
  function plan(overrides: Partial<BackfillPlan> = {}): BackfillPlan {
    return { documentIds: [], recordsTotal: 0, estimatedMillis: 0, ...overrides };
  }

  it('shows the count straight from recordsTotal, before any Export is fetched', () => {
    expect(formatBackfillOffer(plan({ recordsTotal: 44 }))).toContain('First run — 44 Documents found.');
  });

  it('uses the singular for exactly one Document', () => {
    expect(formatBackfillOffer(plan({ recordsTotal: 1, estimatedMillis: 1_000 }))).toContain('First run — 1 Document found.');
  });

  it('shows a whole-minute estimate, rounded, for a Run large enough to matter', () => {
    expect(formatBackfillOffer(plan({ recordsTotal: 90, estimatedMillis: 90_000 }))).toContain('Estimated time: about 2 min.');
  });

  it('says "less than a minute" rather than "0 min" for a short estimate', () => {
    expect(formatBackfillOffer(plan({ recordsTotal: 3, estimatedMillis: 3_000 }))).toContain('Estimated time: less than a minute.');
  });

  it('reports zero Documents plainly, without an estimate line', () => {
    expect(formatBackfillOffer(plan({ recordsTotal: 0, estimatedMillis: 0 }))).toBe('First run — 0 Documents found.');
  });
});

describe('formatBundleOffer', () => {
  function plan(overrides: Partial<BundlePlan> = {}): BundlePlan {
    return { month: { year: 2026, month: 7 }, documents: [], totalSizeBytes: 0, ...overrides };
  }

  it('says plainly that a month has no Documents, rather than offering an empty Bundle', () => {
    expect(formatBundleOffer(plan())).toBe('No Documents for 07/2026.');
  });

  it('shows the count and total size in MB for a month-sized Bundle', () => {
    const documents = Array.from({ length: 44 }, (_, i) => ({ documentId: i, filename: `${i}.xml`, bytes: new Uint8Array(0) }));
    expect(formatBundleOffer(plan({ documents, totalSizeBytes: 7 * 1024 * 1024 }))).toBe('07/2026 — 44 Documents, 7.0 MB.');
  });

  it('shows the total size in KB for a small Bundle, and the singular for one Document', () => {
    const documents = [{ documentId: 1, filename: '1.xml', bytes: new Uint8Array(0) }];
    expect(formatBundleOffer(plan({ documents, totalSizeBytes: 2048 }))).toBe('07/2026 — 1 Document, 2.0 KB.');
  });

  it('pads a single-digit month to two digits', () => {
    expect(formatBundleOffer(plan({ month: { year: 2026, month: 3 } }))).toBe('No Documents for 03/2026.');
  });
});

describe('summarizeRun', () => {
  it('needs no attention and carries no notices for a Run that filed, skipped and failed nothing', () => {
    expect(summarizeRun(emptyReport())).toEqual({
      needsAttention: false,
      filed: 0,
      skipped: 0,
      failed: 0,
      notices: [],
    });
  });

  it('counts filed, skipped and failed Documents as plain counters', () => {
    const report = emptyReport({
      filed: [
        { documentId: 1, directory: [], filenames: [] },
        { documentId: 2, directory: [], filenames: [] },
      ],
      skipped: [3],
      failed: [{ documentId: 4, broj: '4/1/1', issuerName: 'Izdavatelj d.o.o.', error: 'boom' }],
    });

    const summary = summarizeRun(report);
    expect(summary.filed).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.needsAttention).toBe(true);
  });

  it("names a failure's Document by broj and Issuer, never a bare id, and carries its reason verbatim", () => {
    const report = emptyReport({
      failed: [
        {
          documentId: 7,
          broj: '7/1/1',
          issuerName: 'Izdavatelj d.o.o.',
          error: 'Document 7 is missing numeric field datumZaprimanja',
        },
      ],
    });

    expect(summarizeRun(report).notices).toEqual([
      {
        kind: 'failed',
        severity: 'failed',
        documentId: 7,
        broj: '7/1/1',
        issuerName: 'Izdavatelj d.o.o.',
        reason: 'Document 7 is missing numeric field datumZaprimanja',
      },
    ]);
  });

  it('maps a Year straddle onto severity "attention", never "failed", and states the year it was filed under', () => {
    const report = emptyReport({
      yearStraddles: [{ documentId: 9, broj: '9/1/1', issuerName: 'Izdavatelj d.o.o.', filedYear: 2025 }],
    });

    const [notice] = summarizeRun(report).notices;
    expect(notice).toEqual({
      kind: 'yearStraddle',
      severity: 'attention',
      documentId: 9,
      broj: '9/1/1',
      issuerName: 'Izdavatelj d.o.o.',
      filedYear: 2025,
    });
  });

  it('maps a NEPOZNATO Document onto severity "attention", never "failed"', () => {
    const report = emptyReport({
      nepoznato: [{ documentId: 11, broj: '11/1/1', issuerName: 'Izdavatelj d.o.o.' }],
    });

    expect(summarizeRun(report).notices).toEqual([
      {
        kind: 'nepoznato',
        severity: 'attention',
        documentId: 11,
        broj: '11/1/1',
        issuerName: 'Izdavatelj d.o.o.',
      },
    ]);
  });

  it('maps a drifted vrstaDokumenta.code onto severity "attention", never "failed", carrying the code', () => {
    const report = emptyReport({
      drift: [{ documentId: 13, broj: '13/1/1', issuerName: 'Izdavatelj d.o.o.', code: 9999 }],
    });

    expect(summarizeRun(report).notices).toEqual([
      {
        kind: 'drift',
        severity: 'attention',
        documentId: 13,
        broj: '13/1/1',
        issuerName: 'Izdavatelj d.o.o.',
        code: 9999,
      },
    ]);
  });

  it('never reports needsAttention for a Run that filed cleanly with no straddle, NEPOZNATO or drift', () => {
    const report = emptyReport({ filed: [{ documentId: 1, directory: [], filenames: [] }] });
    expect(summarizeRun(report).needsAttention).toBe(false);
  });
});
