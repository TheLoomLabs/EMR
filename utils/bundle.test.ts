import { describe, expect, it } from 'vitest';
import {
  BundleError,
  bundleFilename,
  bundleMonthLabel,
  bundleSubject,
  bundleWindow,
  composeBundle,
  isReachableBundleMonth,
  planBundle,
  reachableYearRange,
  type BundlePortalPort,
  type BundleStore,
} from './bundle';
import type { DocumentRow, FilterParams } from './portal';

function row(overrides: Partial<DocumentRow> & { id: number }): DocumentRow {
  return {
    brojDokumenta: `${overrides.id}/1/1`,
    dobavljac: { oib: '11111111111', naziv: 'Izdavatelj d.o.o.' },
    datumIzdavanja: Date.parse('2026-07-15T00:00:00.000Z'),
    vrstaDokumenta: { code: 380 },
    ...overrides,
  } as DocumentRow;
}

class FakeBundlePortalPort implements BundlePortalPort {
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

class FakeBundleStore implements BundleStore {
  constructor(private readonly cache: Map<number, Uint8Array>) {}
  async getCachedEracun(id: number) {
    return this.cache.get(id);
  }
}

const JULY = { year: 2026, month: 7 };

describe('bundleWindow', () => {
  it('spans the whole calendar month, 1st through last day, inclusive', () => {
    expect(bundleWindow(JULY)).toEqual({
      from: { year: 2026, month: 7, day: 1 },
      to: { year: 2026, month: 7, day: 31 },
    });
  });

  it('gets the last day right for a 30-day month and February', () => {
    expect(bundleWindow({ year: 2026, month: 4 }).to).toEqual({ year: 2026, month: 4, day: 30 });
    expect(bundleWindow({ year: 2026, month: 2 }).to).toEqual({ year: 2026, month: 2, day: 28 });
  });
});

describe('bundleMonthLabel', () => {
  it('renders the English month name and year (ADR-0011)', () => {
    expect(bundleMonthLabel(JULY)).toBe('July 2026');
    expect(bundleMonthLabel({ year: 2026, month: 1 })).toBe('January 2026');
  });
});

describe('isReachableBundleMonth', () => {
  const now = Date.parse('2026-07-15T00:00:00.000Z'); // Zagreb 2026-07-15

  it('is unreachable before eRačun receipt began', () => {
    expect(isReachableBundleMonth({ year: 2025, month: 12 }, now)).toBe(false);
  });

  it('is reachable exactly at the floor', () => {
    expect(isReachableBundleMonth({ year: 2026, month: 1 }, now)).toBe(true);
  });

  it('is reachable for the current month but not the month after', () => {
    expect(isReachableBundleMonth({ year: 2026, month: 7 }, now)).toBe(true);
    expect(isReachableBundleMonth({ year: 2026, month: 8 }, now)).toBe(false);
  });

  it('reads the ceiling in Europe/Zagreb, not UTC — a UTC read would place it a month earlier (trap 8)', () => {
    const zagrebMarch1UtcFeb28 = 1772319600000; // Zagreb 2026-03-01 00:00, UTC 2026-02-28 23:00
    expect(isReachableBundleMonth({ year: 2026, month: 3 }, zagrebMarch1UtcFeb28)).toBe(true);
  });
});

describe('reachableYearRange', () => {
  it('spans from the eRačun receipt year through the current Zagreb year', () => {
    expect(reachableYearRange(Date.parse('2026-07-15T00:00:00.000Z'))).toEqual({ min: 2026, max: 2026 });
    expect(reachableYearRange(Date.parse('2027-03-01T00:00:00.000Z'))).toEqual({ min: 2026, max: 2027 });
  });

  it('reads the current year in Europe/Zagreb, not UTC — a UTC read would place it a year earlier (trap 8)', () => {
    const zagrebJan1UtcDec31 = 1767222000000; // Zagreb 2026-01-01 00:00, UTC 2025-12-31 23:00
    expect(reachableYearRange(zagrebJan1UtcDec31)).toEqual({ min: 2026, max: 2026 });
  });
});

describe('planBundle', () => {
  it('queries a window widened a day at each end, per docs/portal-api.md', async () => {
    const port = new FakeBundlePortalPort(0, []);
    const store = new FakeBundleStore(new Map());

    await planBundle(port, store, JULY);

    expect(port.requests).toHaveLength(1);
    const [request] = port.requests;
    expect(request.datumIzdavanja?.pocetak).toBe('2026-06-29T22:00:00.000Z'); // 30 June Zagreb midnight
    expect(request.datumIzdavanja?.kraj).toBe('2026-07-31T22:00:00.000Z'); // 1 Aug Zagreb midnight
  });

  it('narrows to the exact Zagreb month, excluding rows from the widened extra day on either side', async () => {
    const withinMonth = row({ id: 1, datumIzdavanja: Date.parse('2026-06-30T22:00:00.000Z') }); // 1 July Zagreb midnight
    const dayBefore = row({ id: 2, datumIzdavanja: Date.parse('2026-06-29T22:00:00.000Z') }); // 30 June Zagreb midnight
    const dayAfter = row({ id: 3, datumIzdavanja: Date.parse('2026-07-31T22:00:00.000Z') }); // 1 Aug Zagreb midnight
    const lastDay = row({ id: 4, datumIzdavanja: Date.parse('2026-07-30T22:00:00.000Z') }); // 31 July Zagreb midnight
    const port = new FakeBundlePortalPort(4, [withinMonth, dayBefore, dayAfter, lastDay]);
    const store = new FakeBundleStore(
      new Map([
        [1, new TextEncoder().encode('<StandardBusinessDocument/>1')],
        [4, new TextEncoder().encode('<StandardBusinessDocument/>4')],
      ]),
    );

    const plan = await planBundle(port, store, JULY);

    expect(plan.documents.map((d) => d.documentId)).toEqual([1, 4]);
  });

  it('returns an empty plan for a month with no Documents', async () => {
    const port = new FakeBundlePortalPort(0, []);
    const store = new FakeBundleStore(new Map());

    const plan = await planBundle(port, store, JULY);

    expect(plan.documents).toEqual([]);
    expect(plan.totalSizeBytes).toBe(0);
  });

  it('reads each Document XML from the cache, never re-fetching an Export — trap 1', async () => {
    const bytes = new TextEncoder().encode('<StandardBusinessDocument/>cached-bytes');
    const port = new FakeBundlePortalPort(1, [row({ id: 1 })]);
    const store = new FakeBundleStore(new Map([[1, bytes]]));

    const plan = await planBundle(port, store, JULY);

    expect(plan.documents).toEqual([{ documentId: 1, filename: '2026-07-15_1-1-1.xml', bytes }]);
  });

  it('sums attachment byte lengths into totalSizeBytes', async () => {
    const port = new FakeBundlePortalPort(2, [row({ id: 1 }), row({ id: 2, brojDokumenta: '2/1/1' })]);
    const store = new FakeBundleStore(
      new Map([
        [1, new Uint8Array(100)],
        [2, new Uint8Array(250)],
      ]),
    );

    const plan = await planBundle(port, store, JULY);

    expect(plan.totalSizeBytes).toBe(350);
  });

  it('fails loudly, naming the Document, when a row in the month has no cached eRačun', async () => {
    const port = new FakeBundlePortalPort(1, [row({ id: 42, brojDokumenta: '9/9/9' })]);
    const store = new FakeBundleStore(new Map());

    await expect(planBundle(port, store, JULY)).rejects.toThrow(BundleError);
    await expect(planBundle(port, store, JULY)).rejects.toThrow(/42/);
  });

  it('composing the same month twice produces an equivalent plan — no dependence on send history', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const port = new FakeBundlePortalPort(1, [row({ id: 1 })]);
    const store = new FakeBundleStore(new Map([[1, bytes]]));

    const first = await planBundle(port, store, JULY);
    const second = await planBundle(port, store, JULY);

    expect(first).toEqual(second);
  });

  it('disambiguates two Documents whose date and brojDokumenta coincide — different Issuers can share both', async () => {
    const bytesA = new TextEncoder().encode('<StandardBusinessDocument/>A');
    const bytesB = new TextEncoder().encode('<StandardBusinessDocument/>B');
    const port = new FakeBundlePortalPort(2, [
      row({ id: 1, brojDokumenta: '1/1/1', dobavljac: { oib: '11111111111', naziv: 'Prvi d.o.o.' } }),
      row({ id: 2, brojDokumenta: '1/1/1', dobavljac: { oib: '22222222222', naziv: 'Drugi d.o.o.' } }),
    ]);
    const store = new FakeBundleStore(
      new Map([
        [1, bytesA],
        [2, bytesB],
      ]),
    );

    const plan = await planBundle(port, store, JULY);

    const filenames = plan.documents.map((d) => d.filename);
    expect(new Set(filenames).size).toBe(2);
    expect(filenames).toContain('2026-07-15_1-1-1.xml');
    expect(filenames).toContain('2026-07-15_1-1-1_22222222222.xml'); // disambiguated by the colliding Issuer's OIB, not the Portal id (ADR-0007)
  });
});

describe('bundleSubject', () => {
  it('appends the month as MM/YYYY to the settings template', () => {
    expect(bundleSubject('eRačuni', JULY)).toBe('eRačuni 07/2026');
  });
});

describe('bundleFilename', () => {
  it('sanitises the subject template the same way Archive segments are sanitised', () => {
    expect(bundleFilename('eRačuni', JULY)).toBe('eRačuni 07-2026.eml');
  });
});

describe('composeBundle', () => {
  it('addresses the message and sets the subject from settings, and attaches every planned Document', () => {
    const plan = {
      month: JULY,
      documents: [{ documentId: 1, filename: '2026-07-15_1-1-1.xml', bytes: new TextEncoder().encode('<StandardBusinessDocument/>') }],
      totalSizeBytes: 10,
    };

    const eml = new TextDecoder('utf-8').decode(
      composeBundle(plan, { accountantEmail: 'knjigovoda@example.com', subjectTemplate: 'eRačuni' }),
    );

    expect(eml).toContain('To: knjigovoda@example.com\r\n');
    expect(eml).toContain('Content-Disposition: attachment; filename="2026-07-15_1-1-1.xml"');
  });

  it('produces a valid message for a month with no Documents', () => {
    const plan = { month: JULY, documents: [], totalSizeBytes: 0 };

    const eml = new TextDecoder('utf-8').decode(
      composeBundle(plan, { accountantEmail: 'knjigovoda@example.com', subjectTemplate: 'eRačuni' }),
    );

    expect(eml).toContain('To: knjigovoda@example.com\r\n');
    expect(eml).not.toContain('Content-Disposition: attachment');
  });

  it('attaches XML bytes byte-identical to what planBundle read from the cache', () => {
    const original = new Uint8Array([0x3c, 0x53, 0x00, 0xff, 0x10]);
    const plan = { month: JULY, documents: [{ documentId: 1, filename: 'a.xml', bytes: original }], totalSizeBytes: original.length };

    const eml = new TextDecoder('utf-8').decode(composeBundle(plan, { accountantEmail: 'a@example.com', subjectTemplate: 'x' }));
    const body = eml.split('Content-Disposition: attachment; filename="a.xml"\r\n\r\n')[1];
    const encoded = body.split(/\r\n--/)[0].replace(/\r\n/g, '');
    const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));

    expect(decoded).toEqual(original);
  });
});
