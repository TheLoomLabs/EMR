import { describe, expect, it } from 'vitest';
import type { Clock } from './clock';
import { EXPORT_DELAY_MS } from './run';
import { backfillWindow, planBackfill, type BackfillPort } from './backfill';
import type { DocumentRow, FilterParams } from './portal';

function row(id: number, datumIzdavanja: number): DocumentRow {
  return {
    id,
    brojDokumenta: `${id}/1/1`,
    dobavljac: { oib: '11111111111', naziv: 'Izdavatelj d.o.o.' },
    datumIzdavanja,
    vrstaDokumenta: { code: 380 },
  } as DocumentRow;
}

class FakeClock implements Clock {
  constructor(private readonly value: number) {}
  now(): number {
    return this.value;
  }
}

/** A fake of the already-paged, already-validated `listDocuments` call — the shape the popup's
 * message relay exposes (content.ts does the actual paging, per ADR-0005). Records the
 * filterParams it was asked with, so a test can assert exactly what window was requested. */
class FakeBackfillPort implements BackfillPort {
  requests: FilterParams[] = [];

  constructor(
    private readonly recordsTotal: number,
    private readonly rows: DocumentRow[],
  ) {}

  async listDocuments(filterParams: FilterParams) {
    this.requests.push(filterParams);
    return { recordsTotal: this.recordsTotal, rows: this.rows };
  }
}

// 2026-07-30 00:00 Zagreb (CEST, UTC+2) = 2026-07-29T22:00:00.000Z.
const TODAY = Date.parse('2026-07-29T22:00:00.000Z');

describe('backfillWindow', () => {
  it('runs from when eRačun receipt began through today, in Zagreb terms', () => {
    expect(backfillWindow(TODAY)).toEqual({
      from: { year: 2026, month: 1, day: 1 },
      to: { year: 2026, month: 7, day: 30 },
    });
  });
});

describe('planBackfill', () => {
  it('queries a window widened a day at each end, but never before eRačun receipt began', async () => {
    const port = new FakeBackfillPort(0, []);
    const clock = new FakeClock(TODAY);

    await planBackfill(port, clock);

    expect(port.requests).toHaveLength(1);
    const [request] = port.requests;
    // Without the clamp this would be 31 Dec 2025 midnight Zagreb.
    expect(request.datumIzdavanja?.pocetak).toBe('2025-12-31T23:00:00.000Z'); // 1 Jan 2026 Zagreb midnight
    expect(request.datumIzdavanja?.kraj).toBe('2026-07-30T22:00:00.000Z'); // 31 Jul 2026 Zagreb midnight, one day after today
  });

  it('reports the count straight from recordsTotal', async () => {
    const port = new FakeBackfillPort(7, []);

    const plan = await planBackfill(port, new FakeClock(TODAY));

    expect(plan.recordsTotal).toBe(7);
  });

  it('estimates roughly recordsTotal Documents worth of the Export throttle', async () => {
    const port = new FakeBackfillPort(5, []);

    const plan = await planBackfill(port, new FakeClock(TODAY));

    expect(plan.estimatedMillis).toBe(5 * EXPORT_DELAY_MS);
  });

  it('narrows the widened result back to the exact Zagreb window, excluding a boundary row from the extra day', async () => {
    const withinWindow = row(1, Date.parse('2026-01-01T00:00:00.000Z')); // 1 Jan 2026 01:00 CET — within
    const dayBeforeReceiptBegan = row(2, Date.parse('2025-12-30T23:00:00.000Z')); // 31 Dec 2025 Zagreb midnight — outside
    const port = new FakeBackfillPort(2, [withinWindow, dayBeforeReceiptBegan]);

    const plan = await planBackfill(port, new FakeClock(TODAY));

    expect(plan.documentIds).toEqual([1]);
  });

  it('returns no Document ids when nothing is in the window, even though recordsTotal is nonzero (widened rows outside it)', async () => {
    const outsideRow = row(1, Date.parse('2025-12-30T23:00:00.000Z')); // 31 Dec 2025 Zagreb midnight
    const port = new FakeBackfillPort(1, [outsideRow]);

    const plan = await planBackfill(port, new FakeClock(TODAY));

    expect(plan.documentIds).toEqual([]);
    expect(plan.recordsTotal).toBe(1);
  });
});
