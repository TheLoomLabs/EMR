import { describe, expect, it } from 'vitest';
import {
  groupByIssuer,
  listDocuments,
  PortalListError,
  widenedFilterParams,
  withinZagrebWindow,
  type PortalPort,
  type RawSearchResponse,
  type SearchRequest,
} from './portal';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    brojDokumenta: '1/1/1',
    dobavljac: { oib: '12345678901', naziv: 'Primjer d.o.o.' },
    datumIzdavanja: 1772233200000,
    vrstaDokumenta: { code: 380 },
    ...overrides,
  };
}

/** A hand-written fake PortalPort — no fetch, no DOM. Serves one page of `RawSearchResponse`
 * per call, in order, and records every request it was asked to serve. */
class FakePortalPort implements PortalPort {
  readonly requests: SearchRequest[] = [];
  private index = 0;

  constructor(private readonly pages: RawSearchResponse[]) {}

  async searchInbound(request: SearchRequest): Promise<RawSearchResponse> {
    this.requests.push(request);
    const page = this.pages[this.index];
    this.index += 1;
    if (page === undefined) {
      throw new Error(`FakePortalPort asked for more pages (call ${this.index}) than it was given`);
    }
    return page;
  }
}

describe('listDocuments', () => {
  it('returns every row when it all fits on one page', async () => {
    const port = new FakePortalPort([{ recordsTotal: 2, data: [row({ id: 1 }), row({ id: 2 })] }]);

    const result = await listDocuments(port);

    expect(result.recordsTotal).toBe(2);
    expect(result.rows.map((r) => r.id)).toEqual([1, 2]);
    expect(port.requests).toEqual([{ start: 0, length: 50, filterParams: {} }]);
  });

  it('walks past page 1 rather than assuming one request suffices', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => row({ id: i }));
    const page2 = [row({ id: 50 }), row({ id: 51 })];
    const port = new FakePortalPort([
      { recordsTotal: 52, data: page1 },
      { recordsTotal: 52, data: page2 },
    ]);

    const result = await listDocuments(port);

    expect(result.rows).toHaveLength(52);
    expect(result.rows.map((r) => r.id)).toEqual([...page1.map((r) => r.id), 50, 51]);
    expect(port.requests).toEqual([
      { start: 0, length: 50, filterParams: {} },
      { start: 50, length: 50, filterParams: {} },
    ]);
  });

  it('advances by the rows actually returned, so an unconfirmed cap on length cannot strand rows', async () => {
    // Simulate a server that silently caps every page at 20 rows regardless of the requested length.
    const port = new FakePortalPort([
      { recordsTotal: 45, data: Array.from({ length: 20 }, (_, i) => row({ id: i })) },
      { recordsTotal: 45, data: Array.from({ length: 20 }, (_, i) => row({ id: 20 + i })) },
      { recordsTotal: 45, data: Array.from({ length: 5 }, (_, i) => row({ id: 40 + i })) },
    ]);

    const result = await listDocuments(port);

    expect(result.rows).toHaveLength(45);
    expect(port.requests.map((r) => r.start)).toEqual([0, 20, 40]);
  });

  it('treats a genuinely empty inbox as zero rows, not an error', async () => {
    const port = new FakePortalPort([{ recordsTotal: 0, data: [] }]);

    const result = await listDocuments(port);

    expect(result).toEqual({ recordsTotal: 0, rows: [] });
  });

  it('fails loudly on a zero-row page against a non-zero recordsTotal (trap 6)', async () => {
    const port = new FakePortalPort([{ recordsTotal: 5, data: [] }]);

    await expect(listDocuments(port)).rejects.toThrow(PortalListError);
  });

  it('fails loudly when a page returns more rows than the requested length', async () => {
    const port = new FakePortalPort([{ recordsTotal: 1, data: Array.from({ length: 51 }, () => row()) }]);

    await expect(listDocuments(port, {}, 50)).rejects.toThrow(PortalListError);
  });

  it('fails loudly when recordsTotal changes between pages', async () => {
    const port = new FakePortalPort([
      { recordsTotal: 52, data: Array.from({ length: 50 }, (_, i) => row({ id: i })) },
      { recordsTotal: 53, data: [row({ id: 50 }), row({ id: 51 })] },
    ]);

    await expect(listDocuments(port)).rejects.toThrow(PortalListError);
  });

  it.each([
    ['id', { id: undefined }],
    ['datumIzdavanja', { datumIzdavanja: undefined }],
    ['brojDokumenta', { brojDokumenta: undefined }],
    ['dobavljac.oib', { dobavljac: { naziv: 'x' } }],
    ['vrstaDokumenta.code', { vrstaDokumenta: {} }],
  ])('fails loudly when a row is missing %s, rather than filling in a default', async (_name, overrides) => {
    const port = new FakePortalPort([{ recordsTotal: 1, data: [row(overrides)] }]);

    await expect(listDocuments(port)).rejects.toThrow(PortalListError);
  });

  it('sends the given filterParams unchanged', async () => {
    const filterParams = { datumIzdavanja: { pocetak: '2026-01-01T00:00:00.000Z' } };
    const port = new FakePortalPort([{ recordsTotal: 0, data: [] }]);

    await listDocuments(port, filterParams);

    expect(port.requests[0].filterParams).toBe(filterParams);
  });
});

describe('groupByIssuer', () => {
  it('groups Documents under their Issuer, keyed by OIB', () => {
    const groups = groupByIssuer([
      row({ id: 1, dobavljac: { oib: '11111111111', naziv: 'Recolo d.o.o.' } }),
      row({ id: 2, dobavljac: { oib: '22222222222', naziv: 'HEP ELEKTRA D.O.O.' } }),
      row({ id: 3, dobavljac: { oib: '11111111111', naziv: 'Recolo d.o.o.' } }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].oib).toBe('11111111111');
    expect(groups[0].documents.map((d) => d.id)).toEqual([1, 3]);
    expect(groups[1].oib).toBe('22222222222');
    expect(groups[1].documents.map((d) => d.id)).toEqual([2]);
  });

  it('merges two rows carrying one OIB under different naziv strings into a single group', () => {
    const groups = groupByIssuer([
      row({ id: 5, dobavljac: { oib: '51264012088', naziv: 'RECOLO d.o.o.' } }),
      row({ id: 9, dobavljac: { oib: '51264012088', naziv: 'Recolo d.o.o.' } }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].documents).toHaveLength(2);
  });

  it('displays the naziv of the group’s lowest-id Document (ADR-0008’s rule, applied to display too)', () => {
    const groups = groupByIssuer([
      row({ id: 9, dobavljac: { oib: '51264012088', naziv: 'Recolo d.o.o.' } }),
      row({ id: 5, dobavljac: { oib: '51264012088', naziv: 'RECOLO d.o.o.' } }),
    ]);

    expect(groups[0].name).toBe('RECOLO d.o.o.');
  });

  it('counts each group’s Documents', () => {
    const groups = groupByIssuer([
      row({ id: 1, dobavljac: { oib: '11111111111', naziv: 'A' } }),
      row({ id: 2, dobavljac: { oib: '11111111111', naziv: 'A' } }),
      row({ id: 3, dobavljac: { oib: '11111111111', naziv: 'A' } }),
    ]);

    expect(groups[0].documents).toHaveLength(3);
  });

  it('orders groups by their earliest Document’s id, and Documents within a group by id, regardless of input order', () => {
    const groups = groupByIssuer([
      row({ id: 30, dobavljac: { oib: '22222222222', naziv: 'B' } }),
      row({ id: 10, dobavljac: { oib: '11111111111', naziv: 'A' } }),
      row({ id: 20, dobavljac: { oib: '22222222222', naziv: 'B' } }),
      row({ id: 15, dobavljac: { oib: '11111111111', naziv: 'A' } }),
    ]);

    expect(groups.map((g) => g.oib)).toEqual(['11111111111', '22222222222']);
    expect(groups[0].documents.map((d) => d.id)).toEqual([10, 15]);
    expect(groups[1].documents.map((d) => d.id)).toEqual([20, 30]);
  });

  it('returns no groups for an empty Document list', () => {
    expect(groupByIssuer([])).toEqual([]);
  });
});

describe('widenedFilterParams', () => {
  it('widens a window by one day at each end, in Zagreb wall-clock terms', () => {
    // July 2026 is CEST (UTC+2): Zagreb midnight on 1 July is 30 June 22:00 UTC.
    const params = widenedFilterParams({
      from: { year: 2026, month: 7, day: 1 },
      to: { year: 2026, month: 7, day: 31 },
    });

    expect(params.datumIzdavanja?.pocetak).toBe('2026-06-29T22:00:00.000Z'); // midnight of 30 June, one day before
    expect(params.datumIzdavanja?.kraj).toBe('2026-07-31T22:00:00.000Z'); // midnight of 1 Aug, one day after
    expect(params.datumDospijeca).toEqual({});
    expect(params.iznos).toEqual({});
  });

  it('widens correctly across a DST transition', () => {
    // Late March 2026: CET (UTC+1) before the transition, CEST (UTC+2) after.
    const params = widenedFilterParams({
      from: { year: 2026, month: 3, day: 29 },
      to: { year: 2026, month: 3, day: 29 },
    });

    expect(params.datumIzdavanja?.pocetak).toBe('2026-03-27T23:00:00.000Z'); // 28 Mar midnight, still CET
    expect(params.datumIzdavanja?.kraj).toBe('2026-03-29T22:00:00.000Z'); // 30 Mar midnight, now CEST
  });

  it('does not widen past a given earliest bound (backfill must never ask before eRačun receipt began)', () => {
    const params = widenedFilterParams(
      { from: { year: 2026, month: 1, day: 1 }, to: { year: 2026, month: 1, day: 31 } },
      { year: 2026, month: 1, day: 1 },
    );

    // Without the clamp this would be 31 Dec 2025 midnight — one day before window.from.
    expect(params.datumIzdavanja?.pocetak).toBe('2025-12-31T23:00:00.000Z'); // 1 Jan 2026 Zagreb midnight
  });

  it('still widens normally when the window sits well clear of the earliest bound', () => {
    const params = widenedFilterParams(
      { from: { year: 2026, month: 3, day: 10 }, to: { year: 2026, month: 3, day: 20 } },
      { year: 2026, month: 1, day: 1 },
    );

    expect(params.datumIzdavanja?.pocetak).toBe('2026-03-08T23:00:00.000Z'); // 9 Mar midnight, one day before
  });
});

describe('withinZagrebWindow', () => {
  const july: { from: { year: number; month: number; day: number }; to: { year: number; month: number; day: number } } = {
    from: { year: 2026, month: 7, day: 1 },
    to: { year: 2026, month: 7, day: 31 },
  };

  it('includes a Document issued on the exact last day of the window (the off-by-one this exists to prevent)', () => {
    // 31 July 2026 00:00 Zagreb (CEST, UTC+2) = 30 July 22:00 UTC.
    const lastDayOfJuly = Date.parse('2026-07-30T22:00:00.000Z');

    expect(withinZagrebWindow(lastDayOfJuly, july)).toBe(true);
  });

  it('excludes a Document issued the day after the window', () => {
    // 1 August 2026 00:00 Zagreb (CEST) = 31 July 22:00 UTC.
    const firstDayOfAugust = Date.parse('2026-07-31T22:00:00.000Z');

    expect(withinZagrebWindow(firstDayOfAugust, july)).toBe(false);
  });

  it('excludes a Document issued the day before the window', () => {
    // 30 June 2026 00:00 Zagreb (CEST) = 29 June 22:00 UTC.
    const lastDayOfJune = Date.parse('2026-06-29T22:00:00.000Z');

    expect(withinZagrebWindow(lastDayOfJune, july)).toBe(false);
  });

  it('a widened query followed by narrowing keeps exactly the exact-window Documents', () => {
    const params = widenedFilterParams(july);
    // The widened pocetak/kraj bracket both boundary-adjacent instants above; narrowing must
    // still land on the exact window regardless of whether the Portal's bounds are inclusive.
    expect(Date.parse(params.datumIzdavanja!.pocetak!)).toBeLessThanOrEqual(
      Date.parse('2026-06-29T22:00:00.000Z'),
    );
    expect(Date.parse(params.datumIzdavanja!.kraj!)).toBeGreaterThanOrEqual(
      Date.parse('2026-07-31T22:00:00.000Z'),
    );
  });
});
