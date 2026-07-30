import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { ArchivePort } from './archive';
import type { Clock } from './clock';
import type { Delay } from './delay';
import { listDocuments } from './portal';
import type { DocumentRow, PortalPort, RawSearchResponse, SearchRequest } from './portal';
import { EXPORT_DELAY_MS, run, type RunPortalPort, type RunPorts, type RunProgress, type RunStore } from './run';
import type { Settings } from './store';

const XML_HEX = 'deadbeefdeadbeefdeadbeefdeadbeef';
const PDF_HEX = 'cafebabecafebabecafebabecafebabe';

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function eracunXml(marker: string): string {
  return (
    '<StandardBusinessDocument xmlns="urn:example:sbdh">' +
    '<StandardBusinessDocumentHeader/>' +
    `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">${marker}</Invoice>` +
    '</StandardBusinessDocument>'
  );
}

/** A synthetic Export ZIP to the shape docs/portal-api.md documents — see utils/export.test.ts. */
function buildExportZip(id: number, priloziNames: string[] = []): Uint8Array {
  const files: Record<string, Uint8Array> = {
    [`${id}/${XML_HEX}.xml`]: utf8(eracunXml(`document ${id}`)),
    [`${id}/${PDF_HEX}.pdf`]: utf8(`%PDF-1.4 synthetic visualisation for ${id}`),
  };
  for (const name of priloziNames) {
    files[`${id}/${name}`] = utf8(`synthetic prilog for ${id}: ${name}`);
  }
  return zipSync(files, { level: 0 });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Purely structural fixtures — no OIB, business name, invoice number or Document id from a
 * real capture, per issue #1's Testing Decisions. */
function row(overrides: Partial<DocumentRow> & { id: number }): DocumentRow {
  return {
    brojDokumenta: `${overrides.id}/1/1`,
    dobavljac: { oib: '11111111111', naziv: 'Izdavatelj d.o.o.' },
    kupac: { oib: '22222222222', naziv: 'Primatelj d.o.o.' },
    datumIzdavanja: 1772233200000, // 2026-02-28, Zagreb midnight
    datumZaprimanja: 1772233200000,
    vrstaDokumenta: { code: 380 }, // Ordinary invoice — no Marked type suffix
    brojPriloga: 0,
    ...overrides,
  } as DocumentRow;
}

class FakeArchivePort implements ArchivePort {
  readonly files = new Map<string, Uint8Array>();
  readonly writeLog: string[] = [];
  /** Throws once more than this many writes have been attempted, to simulate a write failing
   * partway through a Document (used to test the Filed-only-after-every-write rule). */
  failAfterWrites?: number;
  /** Documents whose every write should throw, to simulate one Document's Archive being
   * unreachable while others succeed. */
  failForDocumentIds = new Set<number>();

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.writeLog.push(path);
    // Matches this fixture's filename stem exactly (`{date}_{id}-1-1...`) — a plain substring
    // check on `id` would also match unrelated digits in the date or other ids' stems.
    const failingId = [...this.failForDocumentIds].find((id) => new RegExp(`_${id}-1-1[._]`).test(path));
    if (failingId !== undefined) {
      throw new Error(`simulated failure writing ${path} for document ${failingId}`);
    }
    if (this.failAfterWrites !== undefined && this.writeLog.length > this.failAfterWrites) {
      throw new Error(`simulated failure writing ${path}`);
    }
    this.files.set(path, bytes);
  }
}

interface CachedEracun {
  bytes: Uint8Array;
  cachedAt: number;
}

class FakeRunStore implements RunStore {
  private readonly filed = new Map<number, number>();
  readonly cached = new Map<number, CachedEracun>();
  readonly pruneCalls: number[] = [];

  constructor(private readonly settings: Settings) {}

  async getSettings(): Promise<Settings> {
    return this.settings;
  }

  async isFiled(id: number): Promise<boolean> {
    return this.filed.has(id);
  }

  async markFiled(id: number, filedAt: number): Promise<void> {
    this.filed.set(id, filedAt);
  }

  async cacheEracun(id: number, bytes: Uint8Array, cachedAt: number): Promise<void> {
    this.cached.set(id, { bytes, cachedAt });
  }

  async pruneEracunCache(now: number): Promise<void> {
    this.pruneCalls.push(now);
  }
}

class FakeClock implements Clock {
  constructor(private readonly value: number) {}
  now(): number {
    return this.value;
  }
}

/** Never actually waits — a Run under test must not spend real wall-clock time sleeping, but
 * still records every call so the throttling behaviour itself is assertable. */
class FakeDelay implements Delay {
  readonly waits: number[] = [];
  async wait(ms: number): Promise<void> {
    this.waits.push(ms);
  }
}

/** Tracks how many `exportDocument` calls are in flight at once, via a real microtask gap
 * (not just a synchronous Map lookup) — the only way to catch a Run that dispatched two
 * Exports without awaiting the first. */
class FakeRunPortalPort implements RunPortalPort {
  readonly exportCalls: number[] = [];
  private concurrent = 0;
  maxConcurrent = 0;

  constructor(
    private readonly rows: DocumentRow[],
    private readonly exports: ReadonlyMap<number, Uint8Array>,
  ) {}

  async listDocuments() {
    return { recordsTotal: this.rows.length, rows: this.rows };
  }

  async exportDocument(id: number): Promise<ArrayBuffer> {
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    this.exportCalls.push(id);
    const bytes = this.exports.get(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.concurrent -= 1;
    if (bytes === undefined) {
      throw new Error(`FakeRunPortalPort has no Export fixture for id ${id}`);
    }
    return toArrayBuffer(bytes);
  }
}

/** A raw, page-serving fake of the lower-level `PortalPort` (utils/portal.ts), used to exercise
 * genuine multi-page traversal through `listDocuments` rather than a Run-level fake that hides
 * paging away. Mirrors utils/portal.test.ts's fake of the same shape. */
class FakePagingPortalPort implements PortalPort {
  readonly requests: SearchRequest[] = [];
  private index = 0;

  constructor(private readonly pages: RawSearchResponse[]) {}

  async searchInbound(request: SearchRequest): Promise<RawSearchResponse> {
    this.requests.push(request);
    const page = this.pages[this.index];
    this.index += 1;
    if (page === undefined) {
      throw new Error(`FakePagingPortalPort asked for more pages (call ${this.index}) than it was given`);
    }
    return page;
  }
}

/** A `RunPortalPort` whose `listDocuments` genuinely pages, by delegating to the real
 * `listDocuments` (utils/portal.ts) over a small page size. */
class PagingFakeRunPortalPort implements RunPortalPort {
  readonly exportCalls: number[] = [];
  private readonly portalPort: FakePagingPortalPort;

  constructor(
    pages: RawSearchResponse[],
    private readonly exports: ReadonlyMap<number, Uint8Array>,
    private readonly pageSize = 2,
  ) {
    this.portalPort = new FakePagingPortalPort(pages);
  }

  async listDocuments() {
    return listDocuments(this.portalPort, {}, this.pageSize);
  }

  async exportDocument(id: number): Promise<ArrayBuffer> {
    this.exportCalls.push(id);
    const bytes = this.exports.get(id);
    if (bytes === undefined) {
      throw new Error(`PagingFakeRunPortalPort has no Export fixture for id ${id}`);
    }
    return toArrayBuffer(bytes);
  }
}

const settings: Settings = { accountantEmail: '', subjectTemplate: 'eRačuni', archiveRoot: 'Arhiva' };

function ports(overrides: Partial<RunPorts> = {}): RunPorts {
  return {
    portal: new FakeRunPortalPort([], new Map()),
    archive: new FakeArchivePort(),
    store: new FakeRunStore(settings),
    clock: new FakeClock(1772233200000),
    delay: new FakeDelay(),
    ...overrides,
  };
}

describe('run', () => {
  it('files every unfiled Document under {root}/{Recipient}/{YYYY}/{MM}/{Issuer}/, with every Prilog', async () => {
    const rows = [row({ id: 5, brojPriloga: 1 })];
    const exports = new Map([[5, buildExportZip(5, ['Prilog-A.pdf'])]]);
    const archive = new FakeArchivePort();
    const store = new FakeRunStore(settings);
    const portal = new FakeRunPortalPort(rows, exports);

    const report = await run(ports({ portal, archive, store }));

    expect(report).toEqual({
      filed: [
        {
          documentId: 5,
          // Trailing dots are stripped by sanitizeSegment (trap 3) — "d.o.o." becomes "d.o.o".
          directory: ['Arhiva', 'Primatelj d.o.o', '2026', '02', 'Izdavatelj d.o.o'],
          filenames: ['2026-02-28_5-1-1.xml', '2026-02-28_5-1-1.pdf', '2026-02-28_5-1-1_Prilog-A.pdf'],
        },
      ],
      skipped: [],
      failed: [],
      yearStraddles: [],
      nepoznato: [],
      drift: [],
    });
    expect([...archive.files.keys()].sort()).toEqual([
      'Arhiva/Primatelj d.o.o/2026/02/Izdavatelj d.o.o/2026-02-28_5-1-1.pdf',
      'Arhiva/Primatelj d.o.o/2026/02/Izdavatelj d.o.o/2026-02-28_5-1-1.xml',
      'Arhiva/Primatelj d.o.o/2026/02/Izdavatelj d.o.o/2026-02-28_5-1-1_Prilog-A.pdf',
    ]);
    expect(await store.isFiled(5)).toBe(true);
  });

  it('writes the eRačun XML byte-identical to what the Export carried, never re-serialised', async () => {
    const rows = [row({ id: 7 })];
    const originalBytes = utf8(eracunXml('document 7'));
    const zip = zipSync(
      {
        [`7/${XML_HEX}.xml`]: originalBytes,
        [`7/${PDF_HEX}.pdf`]: utf8('%PDF-1.4'),
      },
      { level: 0 },
    );
    const archive = new FakeArchivePort();
    const portal = new FakeRunPortalPort(rows, new Map([[7, zip]]));

    await run(ports({ portal, archive }));

    const written = archive.files.get('Arhiva/Primatelj d.o.o/2026/02/Izdavatelj d.o.o/2026-02-28_7-1-1.xml');
    expect(written).toEqual(originalBytes);
  });

  it('sends exactly one id per Export request, even though the endpoint is batch-capable', async () => {
    const rows = [row({ id: 11 })];
    const portal = new FakeRunPortalPort(rows, new Map([[11, buildExportZip(11)]]));

    await run(ports({ portal }));

    expect(portal.exportCalls).toEqual([11]);
  });

  it('skips a Document already marked Filed and still files the rest', async () => {
    const rows = [row({ id: 1 }), row({ id: 2 })];
    const store = new FakeRunStore(settings);
    await store.markFiled(1, 1000);
    const portal = new FakeRunPortalPort(rows, new Map([[2, buildExportZip(2)]]));

    const report = await run(ports({ portal, store }));

    expect(report.skipped).toEqual([1]);
    expect(report.filed).toMatchObject([{ documentId: 2 }]);
    expect(portal.exportCalls).toEqual([2]);
  });

  it('never stops early on the assumption that already-Filed rows come first (HANDOFF: result order is not a contract)', async () => {
    // The Filed Document (100) is listed before the unfiled one (1) — an incremental Run that
    // stopped at the first Filed row would miss id 1 entirely.
    const rows = [row({ id: 100 }), row({ id: 1 })];
    const store = new FakeRunStore(settings);
    await store.markFiled(100, 1000);
    const portal = new FakeRunPortalPort(rows, new Map([[1, buildExportZip(1)]]));

    const report = await run(ports({ portal, store }));

    expect(report.skipped).toEqual([100]);
    expect(report.filed).toMatchObject([{ documentId: 1 }]);
  });

  it('writes nothing and fetches no Export when every Document is already Filed', async () => {
    const rows = [row({ id: 1 })];
    const store = new FakeRunStore(settings);
    await store.markFiled(1, 1000);
    const archive = new FakeArchivePort();
    const portal = new FakeRunPortalPort(rows, new Map());

    const report = await run(ports({ portal, archive, store }));

    expect(report).toEqual({
      filed: [],
      skipped: [1],
      failed: [],
      yearStraddles: [],
      nepoznato: [],
      drift: [],
    });
    expect(archive.files.size).toBe(0);
    expect(portal.exportCalls).toEqual([]);
  });

  it('a second Run over unchanged data writes nothing (a Document already Filed is skipped)', async () => {
    const rows = [row({ id: 1 }), row({ id: 2 })];
    const store = new FakeRunStore(settings);
    const exports = new Map([
      [1, buildExportZip(1)],
      [2, buildExportZip(2)],
    ]);
    const archive = new FakeArchivePort();

    await run(ports({ portal: new FakeRunPortalPort(rows, exports), archive, store }));
    const writesAfterFirstRun = archive.writeLog.length;

    const secondReport = await run(ports({ portal: new FakeRunPortalPort(rows, exports), archive, store }));

    expect(secondReport).toEqual({
      filed: [],
      skipped: [1, 2],
      failed: [],
      yearStraddles: [],
      nepoznato: [],
      drift: [],
    });
    expect(archive.writeLog).toHaveLength(writesAfterFirstRun);
  });

  it('re-running over the same Document overwrites at identical paths rather than a (1) copy (ADR-0004)', async () => {
    const rows = [row({ id: 9 })];
    const exports = new Map([[9, buildExportZip(9)]]);
    const archive = new FakeArchivePort();
    const clock = new FakeClock(1);
    // A store that never records Filed, so run re-selects the same Document each time.
    const neverFiledStore: RunStore = {
      getSettings: async () => settings,
      isFiled: async () => false,
      markFiled: async () => {},
      cacheEracun: async () => {},
      pruneEracunCache: async () => {},
    };

    await run(ports({ portal: new FakeRunPortalPort(rows, exports), archive, store: neverFiledStore, clock }));
    const pathsAfterFirstRun = [...archive.files.keys()].sort();

    await run(ports({ portal: new FakeRunPortalPort(rows, exports), archive, store: neverFiledStore, clock }));
    const pathsAfterSecondRun = [...archive.files.keys()].sort();

    expect(pathsAfterSecondRun).toEqual(pathsAfterFirstRun);
    expect(archive.writeLog).toHaveLength(4); // 2 files, written once per run
  });

  it('interrupting a Run (one Document fails) and re-running resumes without duplicating or skipping', async () => {
    const rows = [row({ id: 1 }), row({ id: 2 })];
    const exports = new Map([
      [1, buildExportZip(1)],
      [2, buildExportZip(2)],
    ]);
    const store = new FakeRunStore(settings);
    const archive = new FakeArchivePort();
    archive.failForDocumentIds.add(2); // simulates the interruption: document 2 never finishes

    const firstReport = await run(ports({ portal: new FakeRunPortalPort(rows, exports), archive, store }));
    expect(firstReport.filed).toMatchObject([{ documentId: 1 }]);
    expect(firstReport.failed).toMatchObject([{ documentId: 2 }]);
    expect(await store.isFiled(1)).toBe(true);
    expect(await store.isFiled(2)).toBe(false);

    archive.failForDocumentIds.clear(); // the interruption is over — document 2 can now succeed
    const secondPortal = new FakeRunPortalPort(rows, exports);
    const secondReport = await run(ports({ portal: secondPortal, archive, store }));

    expect(secondReport.skipped).toEqual([1]);
    expect(secondReport.failed).toEqual([]);
    expect(secondReport.filed).toMatchObject([{ documentId: 2 }]);
    expect(secondPortal.exportCalls).toEqual([2]); // document 1 is not re-fetched
    expect([...archive.files.keys()].sort()).toEqual([
      'Arhiva/Primatelj d.o.o/2026/02/Izdavatelj d.o.o/2026-02-28_1-1-1.pdf',
      'Arhiva/Primatelj d.o.o/2026/02/Izdavatelj d.o.o/2026-02-28_1-1-1.xml',
      'Arhiva/Primatelj d.o.o/2026/02/Izdavatelj d.o.o/2026-02-28_2-1-1.pdf',
      'Arhiva/Primatelj d.o.o/2026/02/Izdavatelj d.o.o/2026-02-28_2-1-1.xml',
    ]);
  });

  it('marks a Document Filed only once every one of its files is written', async () => {
    const rows = [row({ id: 3, brojPriloga: 1 })];
    const exports = new Map([[3, buildExportZip(3, ['Prilog.pdf'])]]);
    const archive = new FakeArchivePort();
    archive.failAfterWrites = 1; // the eRačun writes fine; the visualisation write fails
    const store = new FakeRunStore(settings);
    const portal = new FakeRunPortalPort(rows, exports);

    const report = await run(ports({ portal, archive, store }));

    expect(report.failed).toMatchObject([{ documentId: 3 }]);
    expect(await store.isFiled(3)).toBe(false);
  });

  it("resolves the Issuer's folder name from its lowest-id Document, not the target Document's own naziv (ADR-0008)", async () => {
    const rows = [
      row({ id: 1, dobavljac: { oib: '11111111111', naziv: 'Prvo Ime d.o.o.' } }),
      row({ id: 2, dobavljac: { oib: '11111111111', naziv: 'Drugo Ime d.o.o.' } }),
    ];
    const store = new FakeRunStore(settings);
    await store.markFiled(1, 1);
    const portal = new FakeRunPortalPort(rows, new Map([[2, buildExportZip(2)]]));

    const report = await run(ports({ portal, store }));

    expect(report.filed).toMatchObject([{ directory: ['Arhiva', 'Primatelj d.o.o', '2026', '02', 'Prvo Ime d.o.o'] }]);
  });

  it.each([
    ['datumZaprimanja', { datumZaprimanja: undefined }],
    ['brojPriloga', { brojPriloga: undefined }],
    ['kupac', { kupac: undefined }],
    ['kupac.naziv', { kupac: { oib: '22222222222' } }],
  ])(
    'records a failure — rather than filling in a default — when the selected Document is missing %s, without aborting the Run',
    async (_name, overrides) => {
      const rows = [
        row({ id: 1, ...overrides }),
        // A distinct kupac OIB, so document 1's malformed kupac (in the `kupac.naziv` case,
        // one that carries the *same* OIB as the default but no naziv) can never contaminate
        // document 2's own name resolution — candidatesFor scans the whole row list per OIB.
        row({ id: 2, kupac: { oib: '99999999999', naziv: 'Drugi Primatelj d.o.o.' } }),
      ];
      const portal = new FakeRunPortalPort(rows, new Map([[2, buildExportZip(2)]]));

      const report = await run(ports({ portal }));

      expect(report.failed).toHaveLength(1);
      expect(report.failed[0].documentId).toBe(1);
      expect(report.filed).toMatchObject([{ documentId: 2 }]);
    },
  );

  it('files the target Document even when an unrelated, already-Filed historical row is malformed', async () => {
    // A row missing `kupac` entirely — malformed, but irrelevant to today's target and already
    // Filed. It must not abort the Run ("a failure to stop only its own Document", issue #1).
    const malformedHistoricalRow = { ...row({ id: 1 }), kupac: undefined };
    const rows = [malformedHistoricalRow, row({ id: 2 })];
    const store = new FakeRunStore(settings);
    await store.markFiled(1, 1);
    const portal = new FakeRunPortalPort(rows, new Map([[2, buildExportZip(2)]]));

    const report = await run(ports({ portal, store }));

    expect(report.filed).toMatchObject([{ documentId: 2 }]);
    expect(report.failed).toEqual([]);
  });

  describe('throttling', () => {
    it('fetches Exports sequentially, never more than one in flight at once', async () => {
      const rows = [row({ id: 1 }), row({ id: 2 }), row({ id: 3 })];
      const exports = new Map([
        [1, buildExportZip(1)],
        [2, buildExportZip(2)],
        [3, buildExportZip(3)],
      ]);
      const portal = new FakeRunPortalPort(rows, exports);

      await run(ports({ portal }));

      expect(portal.exportCalls).toEqual([1, 2, 3]);
      expect(portal.maxConcurrent).toBe(1);
    });

    it('waits between Exports, but not before the first one', async () => {
      const rows = [row({ id: 1 }), row({ id: 2 }), row({ id: 3 })];
      const exports = new Map([
        [1, buildExportZip(1)],
        [2, buildExportZip(2)],
        [3, buildExportZip(3)],
      ]);
      const delay = new FakeDelay();

      await run(ports({ portal: new FakeRunPortalPort(rows, exports), delay }));

      expect(delay.waits).toEqual([EXPORT_DELAY_MS, EXPORT_DELAY_MS]); // one fewer than the Export count
    });

    it('does not wait for a Document skipped as already Filed, and does not wait before an Export that never happens (a validation failure)', async () => {
      const rows = [row({ id: 1 }), row({ id: 2, kupac: undefined }), row({ id: 3 })];
      const store = new FakeRunStore(settings);
      await store.markFiled(1, 1);
      const exports = new Map([[3, buildExportZip(3)]]);
      const delay = new FakeDelay();

      const report = await run(ports({ portal: new FakeRunPortalPort(rows, exports), store, delay }));

      expect(report.skipped).toEqual([1]);
      expect(report.failed).toMatchObject([{ documentId: 2 }]);
      expect(report.filed).toMatchObject([{ documentId: 3 }]);
      // Only one real Export (id 3) ever happened, so there is no pair of Exports to space out.
      expect(delay.waits).toEqual([]);
    });
  });

  describe('the eRačun XML cache', () => {
    it('caches a Document\'s eRačun bytes at download time, keyed by id, at the clock\'s instant', async () => {
      const rows = [row({ id: 4 })];
      const originalBytes = utf8(eracunXml('document 4'));
      const zip = zipSync(
        { [`4/${XML_HEX}.xml`]: originalBytes, [`4/${PDF_HEX}.pdf`]: utf8('%PDF-1.4') },
        { level: 0 },
      );
      const store = new FakeRunStore(settings);
      const clock = new FakeClock(1772233200000);

      await run(ports({ portal: new FakeRunPortalPort(rows, new Map([[4, zip]])), store, clock }));

      expect(store.cached.get(4)).toEqual({ bytes: originalBytes, cachedAt: 1772233200000 });
    });

    it('still caches the eRačun bytes even when the Archive write later fails', async () => {
      const rows = [row({ id: 5 })];
      const zip = buildExportZip(5);
      const store = new FakeRunStore(settings);
      const archive = new FakeArchivePort();
      archive.failAfterWrites = 0; // every write fails, including the very first

      const report = await run(ports({ portal: new FakeRunPortalPort(rows, new Map([[5, zip]])), archive, store }));

      expect(report.failed).toMatchObject([{ documentId: 5 }]);
      expect(store.cached.has(5)).toBe(true);
    });

    it('prunes the cache once per Run, at the clock\'s instant', async () => {
      const store = new FakeRunStore(settings);
      const clock = new FakeClock(1772233200000);

      await run(ports({ clock, store }));

      expect(store.pruneCalls).toEqual([1772233200000]);
    });
  });

  describe('paging', () => {
    it('walks the full filtered window across more than one page', async () => {
      const rows = Array.from({ length: 5 }, (_, i) => row({ id: i + 1 }));
      const pages: RawSearchResponse[] = [
        { recordsTotal: 5, data: [rows[0], rows[1]] },
        { recordsTotal: 5, data: [rows[2], rows[3]] },
        { recordsTotal: 5, data: [rows[4]] },
      ];
      const store = new FakeRunStore(settings);
      await store.markFiled(1, 1); // one already Filed, on the first page
      const exports = new Map(
        [2, 3, 4, 5].map((id) => [id, buildExportZip(id)] as const),
      );
      const portal = new PagingFakeRunPortalPort(pages, exports, 2);

      const report = await run(ports({ portal, store }));

      expect(report.skipped).toEqual([1]);
      expect(report.filed.map((f) => f.documentId)).toEqual([2, 3, 4, 5]);
      expect(portal.exportCalls).toEqual([2, 3, 4, 5]);
    });
  });

  it('files every unfiled Document in a mixed batch: one already Filed, one failing, one with two Prilozi, one with none, across more than one page', async () => {
    const rows = [
      row({ id: 1 }), // already Filed — skipped
      row({ id: 2, kupac: undefined }), // fails validation
      row({ id: 3, brojPriloga: 0 }), // succeeds, no Prilozi
      row({ id: 4, brojPriloga: 2 }), // succeeds, two Prilozi
      row({ id: 5, brojPriloga: 0 }), // succeeds, no Prilozi
    ];
    const pages: RawSearchResponse[] = [
      { recordsTotal: 5, data: [rows[0], rows[1]] },
      { recordsTotal: 5, data: [rows[2], rows[3]] },
      { recordsTotal: 5, data: [rows[4]] },
    ];
    const exports = new Map([
      [3, buildExportZip(3)],
      [4, buildExportZip(4, ['Prilog-A.pdf', 'Prilog-B.pdf'])],
      [5, buildExportZip(5)],
    ]);
    const store = new FakeRunStore(settings);
    await store.markFiled(1, 1);
    const portal = new PagingFakeRunPortalPort(pages, exports, 2);
    const delay = new FakeDelay();

    const report = await run(ports({ portal, store, delay }));

    expect(report.skipped).toEqual([1]);
    expect(report.failed).toMatchObject([{ documentId: 2 }]);
    expect(report.filed.map((f) => f.documentId)).toEqual([3, 4, 5]);
    const withPrilozi = report.filed.find((f) => f.documentId === 4)!;
    expect(withPrilozi.filenames).toHaveLength(4); // xml + pdf + 2 Prilozi
    const withoutPrilozi = report.filed.find((f) => f.documentId === 5)!;
    expect(withoutPrilozi.filenames).toHaveLength(2); // xml + pdf only
    // Three real Exports (3, 4, 5) → two waits between them. Document 2 never reached the
    // Portal, so it contributes no wait of its own.
    expect(delay.waits).toEqual([EXPORT_DELAY_MS, EXPORT_DELAY_MS]);
  });

  describe('the run report (issue #10)', () => {
    it('lists a filed Document under yearStraddles when its Datum izdavanja and Datum zaprimanja fall in different Zagreb years (ADR-0006)', async () => {
      const rows = [
        row({
          id: 1,
          datumIzdavanja: 1766876400000, // 2025-12-28 Zagreb
          datumZaprimanja: 1767654000000, // 2026-01-06 Zagreb
        }),
      ];
      const portal = new FakeRunPortalPort(rows, new Map([[1, buildExportZip(1)]]));

      const report = await run(ports({ portal }));

      expect(report.filed).toMatchObject([{ documentId: 1 }]);
      expect(report.yearStraddles).toEqual([1]);
    });

    it('does not list a filed Document under yearStraddles when both dates fall in the same Zagreb year', async () => {
      const rows = [row({ id: 1 })]; // fixture's datumIzdavanja and datumZaprimanja already agree
      const portal = new FakeRunPortalPort(rows, new Map([[1, buildExportZip(1)]]));

      const report = await run(ports({ portal }));

      expect(report.yearStraddles).toEqual([]);
    });

    it('lists a filed Document under nepoznato when its vrstaDokumenta.code marks NEPOZNATO, having still filed it', async () => {
      const rows = [row({ id: 1, vrstaDokumenta: { code: 130 } })]; // 130 is explicitly NEPOZNATO
      const portal = new FakeRunPortalPort(rows, new Map([[1, buildExportZip(1)]]));

      const report = await run(ports({ portal }));

      expect(report.filed).toMatchObject([{ documentId: 1 }]);
      expect(report.nepoznato).toEqual([1]);
      expect(report.drift).toEqual([]); // 130 is a known code, not drift
    });

    it('surfaces a vrstaDokumenta.code absent from the shipped list as drift, without stopping the Run, and it also reads as nepoznato', async () => {
      const rows = [row({ id: 1, vrstaDokumenta: { code: 9999 } }), row({ id: 2 })];
      const portal = new FakeRunPortalPort(rows, new Map([[1, buildExportZip(1)], [2, buildExportZip(2)]]));

      const report = await run(ports({ portal }));

      expect(report.filed.map((f) => f.documentId)).toEqual([1, 2]);
      expect(report.failed).toEqual([]);
      expect(report.drift).toEqual([{ documentId: 1, code: 9999 }]);
      expect(report.nepoznato).toEqual([1]);
    });

    it('does not report a failed Document under yearStraddles, nepoznato or drift', async () => {
      const rows = [row({ id: 1, kupac: undefined, vrstaDokumenta: { code: 9999 } })];
      const portal = new FakeRunPortalPort(rows, new Map());

      const report = await run(ports({ portal }));

      expect(report.failed).toMatchObject([{ documentId: 1 }]);
      expect(report.yearStraddles).toEqual([]);
      expect(report.nepoznato).toEqual([]);
      expect(report.drift).toEqual([]);
    });

    it('does not report an Ordinary invoice under nepoznato or drift', async () => {
      const rows = [row({ id: 1, vrstaDokumenta: { code: 380 } })];
      const portal = new FakeRunPortalPort(rows, new Map([[1, buildExportZip(1)]]));

      const report = await run(ports({ portal }));

      expect(report.nepoznato).toEqual([]);
      expect(report.drift).toEqual([]);
    });
  });

  describe('progress (issue #10)', () => {
    it('reports the Document currently being fetched and running totals as the Run proceeds', async () => {
      const rows = [row({ id: 1 }), row({ id: 2, kupac: undefined }), row({ id: 3 })];
      const store = new FakeRunStore(settings);
      await store.markFiled(1, 1);
      const exports = new Map([[3, buildExportZip(3)]]);
      const portal = new FakeRunPortalPort(rows, exports);
      const snapshots: RunProgress[] = [];

      await run(ports({ portal, store }), { onProgress: (p) => snapshots.push(p) });

      expect(snapshots).toEqual([
        { currentDocumentId: null, filed: 0, skipped: 1, failed: 0 }, // 1 skipped (already Filed)
        { currentDocumentId: 2, filed: 0, skipped: 1, failed: 0 }, // fetching 2 starts
        { currentDocumentId: null, filed: 0, skipped: 1, failed: 1 }, // 2 fails validation
        { currentDocumentId: 3, filed: 0, skipped: 1, failed: 1 }, // fetching 3 starts
        { currentDocumentId: null, filed: 1, skipped: 1, failed: 1 }, // 3 filed
      ]);
    });

    it('reports nothing skipped or fetched when every Document is already Filed', async () => {
      const rows = [row({ id: 1 })];
      const store = new FakeRunStore(settings);
      await store.markFiled(1, 1);
      const snapshots: RunProgress[] = [];

      await run(ports({ portal: new FakeRunPortalPort(rows, new Map()), store }), {
        onProgress: (p) => snapshots.push(p),
      });

      expect(snapshots).toEqual([{ currentDocumentId: null, filed: 0, skipped: 1, failed: 0 }]);
    });
  });

  describe('retrying just the failures (issue #10, documentIds)', () => {
    it('walks only the given Document ids, leaving the rest untouched', async () => {
      const rows = [row({ id: 1 }), row({ id: 2 }), row({ id: 3 })];
      const exports = new Map([[2, buildExportZip(2)]]);
      const portal = new FakeRunPortalPort(rows, exports);

      const report = await run(ports({ portal }), { documentIds: [2] });

      expect(report.filed).toMatchObject([{ documentId: 2 }]);
      expect(report.skipped).toEqual([]);
      expect(report.failed).toEqual([]);
      expect(portal.exportCalls).toEqual([2]);
    });

    it('re-files only the previously failed ids, and does not re-attempt an id that is not in the filter even if unfiled', async () => {
      const rows = [row({ id: 1 }), row({ id: 2 })];
      const exports = new Map([[1, buildExportZip(1)]]);
      const portal = new FakeRunPortalPort(rows, exports);

      const report = await run(ports({ portal }), { documentIds: [1] });

      expect(report.filed.map((f) => f.documentId)).toEqual([1]);
      expect(portal.exportCalls).toEqual([1]); // id 2 is unfiled but outside the filter — never touched
    });

    it('still resolves party names from the full row list, not just the filtered ones (ADR-0008)', async () => {
      const rows = [
        row({ id: 1, dobavljac: { oib: '11111111111', naziv: 'Prvo Ime d.o.o.' } }),
        row({ id: 2, dobavljac: { oib: '11111111111', naziv: 'Drugo Ime d.o.o.' } }),
      ];
      const portal = new FakeRunPortalPort(rows, new Map([[2, buildExportZip(2)]]));

      const report = await run(ports({ portal }), { documentIds: [2] });

      expect(report.filed).toMatchObject([{ directory: ['Arhiva', 'Primatelj d.o.o', '2026', '02', 'Prvo Ime d.o.o'] }]);
    });
  });
});
