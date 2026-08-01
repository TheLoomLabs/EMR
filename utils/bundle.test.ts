import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { Clock } from './clock';
import type { Delay } from './delay';
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
  type BundlePlanProgress,
  type BundlePortalPort,
  type BundlePorts,
  type BundleStore,
} from './bundle';
import type { DocumentRow, FilterParams } from './portal';

const XML_HEX = 'deadbeefdeadbeefdeadbeefdeadbeef';
const PDF_HEX = 'cafebabecafebabecafebabecafebabe';

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** A synthetic Export ZIP to the shape docs/portal-api.md documents — mirrors utils/run.test.ts's
 * own builder, since both exercise the same unpackExport (utils/export.ts). */
function buildExportZip(id: number, eracunMarker: string, priloziNames: string[] = []): Uint8Array {
  const files: Record<string, Uint8Array> = {
    [`${id}/${XML_HEX}.xml`]: utf8(`<StandardBusinessDocument>${eracunMarker}</StandardBusinessDocument>`),
    [`${id}/${PDF_HEX}.pdf`]: utf8(`%PDF-1.4 synthetic visualisation for ${id}`),
  };
  for (const name of priloziNames) {
    files[`${id}/${name}`] = utf8(`synthetic prilog for ${id}: ${name}`);
  }
  return zipSync(files, { level: 0 });
}

function row(overrides: Partial<DocumentRow> & { id: number }): DocumentRow {
  return {
    brojDokumenta: `${overrides.id}/1/1`,
    dobavljac: { oib: '11111111111', naziv: 'Izdavatelj d.o.o.' },
    datumIzdavanja: Date.parse('2026-07-15T00:00:00.000Z'),
    vrstaDokumenta: { code: 380 },
    brojPriloga: 0,
    ...overrides,
  } as DocumentRow;
}

class FakeBundlePortalPort implements BundlePortalPort {
  requests: FilterParams[] = [];
  exportCalls: number[] = [];
  private concurrent = 0;
  maxConcurrent = 0;

  constructor(
    private readonly recordsTotal: number,
    private readonly rows: DocumentRow[],
    private readonly exports: ReadonlyMap<number, Uint8Array> = new Map(),
  ) {}

  async listDocuments(filterParams: FilterParams) {
    this.requests.push(filterParams);
    return { recordsTotal: this.recordsTotal, rows: this.rows };
  }

  async exportDocument(id: number): Promise<ArrayBuffer> {
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    this.exportCalls.push(id);
    const bytes = this.exports.get(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.concurrent -= 1;
    if (bytes === undefined) {
      throw new Error(`FakeBundlePortalPort has no Export fixture for id ${id}`);
    }
    return toArrayBuffer(bytes);
  }
}

class FakeBundleStore implements BundleStore {
  readonly cached = new Map<number, { bytes: Uint8Array; cachedAt: number }>();
  constructor(private readonly cache: Map<number, Uint8Array> = new Map()) {}
  async getCachedEracun(id: number) {
    return this.cache.get(id);
  }
  async cacheEracun(id: number, bytes: Uint8Array, cachedAt: number) {
    this.cache.set(id, bytes);
    this.cached.set(id, { bytes, cachedAt });
  }
}

class FakeClock implements Clock {
  constructor(private readonly value: number) {}
  now(): number {
    return this.value;
  }
}

class FakeDelay implements Delay {
  readonly waits: number[] = [];
  async wait(ms: number): Promise<void> {
    this.waits.push(ms);
  }
}

function bundlePorts(overrides: Partial<BundlePorts> = {}): BundlePorts {
  return {
    portal: new FakeBundlePortalPort(0, []),
    store: new FakeBundleStore(),
    clock: new FakeClock(1772233200000),
    delay: new FakeDelay(),
    ...overrides,
  };
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
    const portal = new FakeBundlePortalPort(0, []);

    await planBundle(bundlePorts({ portal }), JULY);

    expect(portal.requests).toHaveLength(1);
    const [request] = portal.requests;
    expect(request.datumIzdavanja?.pocetak).toBe('2026-06-29T22:00:00.000Z'); // 30 June Zagreb midnight
    expect(request.datumIzdavanja?.kraj).toBe('2026-07-31T22:00:00.000Z'); // 1 Aug Zagreb midnight
  });

  it('narrows to the exact Zagreb month, excluding rows from the widened extra day on either side', async () => {
    const withinMonth = row({ id: 1, datumIzdavanja: Date.parse('2026-06-30T22:00:00.000Z') }); // 1 July Zagreb midnight
    const dayBefore = row({ id: 2, datumIzdavanja: Date.parse('2026-06-29T22:00:00.000Z') }); // 30 June Zagreb midnight
    const dayAfter = row({ id: 3, datumIzdavanja: Date.parse('2026-07-31T22:00:00.000Z') }); // 1 Aug Zagreb midnight
    const lastDay = row({ id: 4, datumIzdavanja: Date.parse('2026-07-30T22:00:00.000Z') }); // 31 July Zagreb midnight
    const portal = new FakeBundlePortalPort(4, [withinMonth, dayBefore, dayAfter, lastDay]);
    const store = new FakeBundleStore(
      new Map([
        [1, new TextEncoder().encode('<StandardBusinessDocument/>1')],
        [4, new TextEncoder().encode('<StandardBusinessDocument/>4')],
      ]),
    );

    const plan = await planBundle(bundlePorts({ portal, store }), JULY);

    expect(plan.documents.map((d) => d.documentId)).toEqual([1, 4]);
  });

  it('returns an empty plan for a month with no Documents', async () => {
    const plan = await planBundle(bundlePorts(), JULY);

    expect(plan.documents).toEqual([]);
    expect(plan.totalSizeBytes).toBe(0);
  });

  it('reads each Document XML from the cache, never fetching an Export, when the cache is fully warm', async () => {
    const bytes = new TextEncoder().encode('<StandardBusinessDocument/>cached-bytes');
    const portal = new FakeBundlePortalPort(1, [row({ id: 1 })]);
    const store = new FakeBundleStore(new Map([[1, bytes]]));

    const plan = await planBundle(bundlePorts({ portal, store }), JULY);

    expect(plan.documents).toEqual([{ documentId: 1, filename: '2026-07-15_1-1-1.xml', bytes }]);
    expect(portal.exportCalls).toEqual([]); // a fully warm cache requests no Exports at all
  });

  it('sums attachment byte lengths into totalSizeBytes', async () => {
    const portal = new FakeBundlePortalPort(2, [row({ id: 1 }), row({ id: 2, brojDokumenta: '2/1/1' })]);
    const store = new FakeBundleStore(
      new Map([
        [1, new Uint8Array(100)],
        [2, new Uint8Array(250)],
      ]),
    );

    const plan = await planBundle(bundlePorts({ portal, store }), JULY);

    expect(plan.totalSizeBytes).toBe(350);
  });

  it('composing the same month twice produces an equivalent plan — no dependence on send history', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const store = new FakeBundleStore(new Map([[1, bytes]]));

    const first = await planBundle(bundlePorts({ portal: new FakeBundlePortalPort(1, [row({ id: 1 })]), store }), JULY);
    const second = await planBundle(bundlePorts({ portal: new FakeBundlePortalPort(1, [row({ id: 1 })]), store }), JULY);

    expect(first).toEqual(second);
  });

  it('disambiguates two Documents whose date and brojDokumenta coincide — different Issuers can share both', async () => {
    const bytesA = new TextEncoder().encode('<StandardBusinessDocument/>A');
    const bytesB = new TextEncoder().encode('<StandardBusinessDocument/>B');
    const portal = new FakeBundlePortalPort(2, [
      row({ id: 1, brojDokumenta: '1/1/1', dobavljac: { oib: '11111111111', naziv: 'Prvi d.o.o.' } }),
      row({ id: 2, brojDokumenta: '1/1/1', dobavljac: { oib: '22222222222', naziv: 'Drugi d.o.o.' } }),
    ]);
    const store = new FakeBundleStore(
      new Map([
        [1, bytesA],
        [2, bytesB],
      ]),
    );

    const plan = await planBundle(bundlePorts({ portal, store }), JULY);

    const filenames = plan.documents.map((d) => d.filename);
    expect(new Set(filenames).size).toBe(2);
    expect(filenames).toContain('2026-07-15_1-1-1.xml');
    expect(filenames).toContain('2026-07-15_1-1-1_22222222222.xml'); // disambiguated by the colliding Issuer's OIB, not the Portal id (ADR-0007)
  });

  describe('recovering an uncached Document from the Portal (ADR-0012, issue #31)', () => {
    it('fetches an Export for a Document the cache has no entry for, and attaches its eRačun bytes', async () => {
      const zip = buildExportZip(1, 'recovered');
      const portal = new FakeBundlePortalPort(1, [row({ id: 1 })], new Map([[1, zip]]));
      const store = new FakeBundleStore();

      const plan = await planBundle(bundlePorts({ portal, store }), JULY);

      expect(portal.exportCalls).toEqual([1]);
      expect(plan.documents).toHaveLength(1);
      expect(new TextDecoder().decode(plan.documents[0].bytes)).toBe('<StandardBusinessDocument>recovered</StandardBusinessDocument>');
    });

    it('requests exactly the missing Documents on a partial miss, no more', async () => {
      const rows = [row({ id: 1 }), row({ id: 2, brojDokumenta: '2/1/1' }), row({ id: 3, brojDokumenta: '3/1/1' })];
      const portal = new FakeBundlePortalPort(3, rows, new Map([[2, buildExportZip(2, 'two')]]));
      const store = new FakeBundleStore(
        new Map([
          [1, new Uint8Array([1])],
          [3, new Uint8Array([3])],
        ]),
      );

      await planBundle(bundlePorts({ portal, store }), JULY);

      expect(portal.exportCalls).toEqual([2]);
    });

    it('writes recovered XML back to the cache, keyed by id, at the clock\'s instant', async () => {
      const zip = buildExportZip(1, 'recovered');
      const portal = new FakeBundlePortalPort(1, [row({ id: 1 })], new Map([[1, zip]]));
      const store = new FakeBundleStore();
      const clock = new FakeClock(999);

      await planBundle(bundlePorts({ portal, store, clock }), JULY);

      expect(store.cached.get(1)?.cachedAt).toBe(999);
      expect(new TextDecoder().decode(store.cached.get(1)!.bytes)).toBe('<StandardBusinessDocument>recovered</StandardBusinessDocument>');
    });

    it('a second planBundle of the same month requests no Exports, now that the cache is warm', async () => {
      const zip = buildExportZip(1, 'recovered');
      const store = new FakeBundleStore();
      const rows = [row({ id: 1 })];

      await planBundle(bundlePorts({ portal: new FakeBundlePortalPort(1, rows, new Map([[1, zip]])), store }), JULY);
      const secondPortal = new FakeBundlePortalPort(1, rows, new Map([[1, zip]]));
      await planBundle(bundlePorts({ portal: secondPortal, store }), JULY);

      expect(secondPortal.exportCalls).toEqual([]);
    });

    it('discards the visualisation and any Prilozi from a Send-time Export, keeping only the eRačun', async () => {
      const zip = buildExportZip(1, 'recovered', ['Prilog-A.pdf']);
      const portal = new FakeBundlePortalPort(1, [row({ id: 1, brojPriloga: 1 })], new Map([[1, zip]]));

      const plan = await planBundle(bundlePorts({ portal, store: new FakeBundleStore() }), JULY);

      expect(plan.documents).toHaveLength(1);
      expect(new TextDecoder().decode(plan.documents[0].bytes)).toBe('<StandardBusinessDocument>recovered</StandardBusinessDocument>');
    });

    it('attachment bytes are byte-identical whether cached or freshly fetched (ADR-0003, trap 9)', async () => {
      const cachedBytes = new TextEncoder().encode('<StandardBusinessDocument/>already-cached');
      const zip = buildExportZip(2, 'fresh');
      const rows = [row({ id: 1 }), row({ id: 2, brojDokumenta: '2/1/1' })];
      const portal = new FakeBundlePortalPort(2, rows, new Map([[2, zip]]));
      const store = new FakeBundleStore(new Map([[1, cachedBytes]]));

      const plan = await planBundle(bundlePorts({ portal, store }), JULY);

      const cached = plan.documents.find((d) => d.documentId === 1)!;
      const fetched = plan.documents.find((d) => d.documentId === 2)!;
      expect(cached.bytes).toEqual(cachedBytes);
      expect(new TextDecoder().decode(fetched.bytes)).toBe('<StandardBusinessDocument>fresh</StandardBusinessDocument>');
    });

    it('throws BundleError, naming the Document, when the Portal cannot supply an uncached Document', async () => {
      const portal = new FakeBundlePortalPort(1, [row({ id: 42, brojDokumenta: '9/9/9' })], new Map());

      await expect(planBundle(bundlePorts({ portal }), JULY)).rejects.toThrow(BundleError);
      await expect(planBundle(bundlePorts({ portal }), JULY)).rejects.toThrow(/42/);
    });

    it('throws BundleError when a Document missing from the cache also lacks a numeric brojPriloga', async () => {
      const portal = new FakeBundlePortalPort(1, [row({ id: 1, brojPriloga: undefined })], new Map([[1, buildExportZip(1, 'x')]]));

      await expect(planBundle(bundlePorts({ portal }), JULY)).rejects.toThrow(BundleError);
    });

    it('throttles recovery fetches sequentially, never more than one Export in flight at once', async () => {
      const rows = [row({ id: 1 }), row({ id: 2, brojDokumenta: '2/1/1' }), row({ id: 3, brojDokumenta: '3/1/1' })];
      const exports = new Map([
        [1, buildExportZip(1, 'a')],
        [2, buildExportZip(2, 'b')],
        [3, buildExportZip(3, 'c')],
      ]);
      const portal = new FakeBundlePortalPort(3, rows, exports);

      await planBundle(bundlePorts({ portal }), JULY);

      expect(portal.exportCalls).toEqual([1, 2, 3]);
      expect(portal.maxConcurrent).toBe(1);
    });

    it('waits between recovery fetches, using the same pause and constant a Run uses, but not before the first one', async () => {
      const rows = [row({ id: 1 }), row({ id: 2, brojDokumenta: '2/1/1' }), row({ id: 3, brojDokumenta: '3/1/1' })];
      const exports = new Map([
        [1, buildExportZip(1, 'a')],
        [2, buildExportZip(2, 'b')],
        [3, buildExportZip(3, 'c')],
      ]);
      const portal = new FakeBundlePortalPort(3, rows, exports);
      const delay = new FakeDelay();

      await planBundle(bundlePorts({ portal, delay }), JULY);

      expect(delay.waits).toEqual([1000, 1000]); // EXPORT_DELAY_MS (utils/run.ts), one fewer than the fetch count
    });

    it('reports progress while recovery fetches happen, and never calls onProgress when the cache is fully warm', async () => {
      const store = new FakeBundleStore(new Map([[1, new Uint8Array([1])]]));
      const snapshots: BundlePlanProgress[] = [];

      await planBundle(bundlePorts({ portal: new FakeBundlePortalPort(1, [row({ id: 1 })]), store }), JULY, {
        onProgress: (p) => snapshots.push(p),
      });

      expect(snapshots).toEqual([]);
    });

    it('reports progress naming the Document being fetched and a running fetched count', async () => {
      const rows = [row({ id: 1 }), row({ id: 2, brojDokumenta: '2/1/1' })];
      const exports = new Map([
        [1, buildExportZip(1, 'a')],
        [2, buildExportZip(2, 'b')],
      ]);
      const portal = new FakeBundlePortalPort(2, rows, exports);
      const snapshots: BundlePlanProgress[] = [];

      await planBundle(bundlePorts({ portal }), JULY, { onProgress: (p) => snapshots.push(p) });

      expect(snapshots).toEqual([
        { total: 2, current: { documentId: 1, broj: '1/1/1', issuerName: 'Izdavatelj d.o.o.' }, fetched: 0 },
        { total: 2, current: null, fetched: 1 },
        { total: 2, current: { documentId: 2, broj: '2/1/1', issuerName: 'Izdavatelj d.o.o.' }, fetched: 1 },
        { total: 2, current: null, fetched: 2 },
      ]);
    });
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
      composeBundle(plan, { accountantEmails: ['knjigovoda@example.com'], subjectTemplate: 'eRačuni' }),
    );

    expect(eml).toContain('To: knjigovoda@example.com\r\n');
    expect(eml).toContain('Content-Disposition: attachment; filename="2026-07-15_1-1-1.xml"');
  });

  it('produces a valid message for a month with no Documents', () => {
    const plan = { month: JULY, documents: [], totalSizeBytes: 0 };

    const eml = new TextDecoder('utf-8').decode(
      composeBundle(plan, { accountantEmails: ['knjigovoda@example.com'], subjectTemplate: 'eRačuni' }),
    );

    expect(eml).toContain('To: knjigovoda@example.com\r\n');
    expect(eml).not.toContain('Content-Disposition: attachment');
  });

  it('attaches XML bytes byte-identical to what planBundle read from the cache', () => {
    const original = new Uint8Array([0x3c, 0x53, 0x00, 0xff, 0x10]);
    const plan = { month: JULY, documents: [{ documentId: 1, filename: 'a.xml', bytes: original }], totalSizeBytes: original.length };

    const eml = new TextDecoder('utf-8').decode(composeBundle(plan, { accountantEmails: ['a@example.com'], subjectTemplate: 'x' }));
    const body = eml.split('Content-Disposition: attachment; filename="a.xml"\r\n\r\n')[1];
    const encoded = body.split(/\r\n--/)[0].replace(/\r\n/g, '');
    const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));

    expect(decoded).toEqual(original);
  });

  it('addresses every Accountant address as an equal addressee of the one message — no Cc, no Bcc (ADR-0003, issue #30)', () => {
    const plan = { month: JULY, documents: [], totalSizeBytes: 0 };

    const eml = new TextDecoder('utf-8').decode(
      composeBundle(plan, { accountantEmails: ['ana@example.com', 'ivo@example.com'], subjectTemplate: 'eRačuni' }),
    );

    expect(eml).toContain('To: ana@example.com, ivo@example.com\r\n');
    expect(eml).not.toMatch(/^Cc:/m);
    expect(eml).not.toMatch(/^Bcc:/m);
  });
});
