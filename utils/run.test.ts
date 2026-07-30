import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { ArchivePort } from './archive';
import type { Clock } from './clock';
import type { DocumentRow } from './portal';
import { RunError, runOne, type RunPortalPort, type RunPorts, type RunStore } from './run';
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

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.writeLog.push(path);
    if (this.failAfterWrites !== undefined && this.writeLog.length > this.failAfterWrites) {
      throw new Error(`simulated failure writing ${path}`);
    }
    this.files.set(path, bytes);
  }
}

class FakeRunStore implements RunStore {
  private readonly filed = new Map<number, number>();

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
}

class FakeClock implements Clock {
  constructor(private readonly value: number) {}
  now(): number {
    return this.value;
  }
}

class FakeRunPortalPort implements RunPortalPort {
  readonly exportCalls: number[] = [];

  constructor(
    private readonly rows: DocumentRow[],
    private readonly exports: ReadonlyMap<number, Uint8Array>,
  ) {}

  async listDocuments() {
    return { recordsTotal: this.rows.length, rows: this.rows };
  }

  async exportDocument(id: number): Promise<ArrayBuffer> {
    this.exportCalls.push(id);
    const bytes = this.exports.get(id);
    if (bytes === undefined) {
      throw new Error(`FakeRunPortalPort has no Export fixture for id ${id}`);
    }
    return toArrayBuffer(bytes);
  }
}

const settings: Settings = { accountantEmail: '', subjectTemplate: 'eRačuni', archiveRoot: 'Arhiva' };

describe('runOne', () => {
  it('files the first unfiled Document under {root}/{Recipient}/{YYYY}/{MM}/{Issuer}/, with every Prilog', async () => {
    const rows = [row({ id: 5, brojPriloga: 1 })];
    const exports = new Map([[5, buildExportZip(5, ['Prilog-A.pdf'])]]);
    const archive = new FakeArchivePort();
    const store = new FakeRunStore(settings);
    const portal = new FakeRunPortalPort(rows, exports);

    const result = await runOne({ portal, archive, store, clock: new FakeClock(1772233200000) });

    expect(result).toEqual({
      filed: true,
      documentId: 5,
      // Trailing dots are stripped by sanitizeSegment (trap 3) — "d.o.o." becomes "d.o.o".
      directory: ['Arhiva', 'Primatelj d.o.o', '2026', '02', 'Izdavatelj d.o.o'],
      filenames: ['2026-02-28_5-1-1.xml', '2026-02-28_5-1-1.pdf', '2026-02-28_5-1-1_Prilog-A.pdf'],
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

    await runOne({ portal, archive, store: new FakeRunStore(settings), clock: new FakeClock(1) });

    const written = archive.files.get('Arhiva/Primatelj d.o.o/2026/02/Izdavatelj d.o.o/2026-02-28_7-1-1.xml');
    expect(written).toEqual(originalBytes);
  });

  it('sends exactly one id per Export request, even though the endpoint is batch-capable', async () => {
    const rows = [row({ id: 11 })];
    const portal = new FakeRunPortalPort(rows, new Map([[11, buildExportZip(11)]]));

    await runOne({ portal, archive: new FakeArchivePort(), store: new FakeRunStore(settings), clock: new FakeClock(1) });

    expect(portal.exportCalls).toEqual([11]);
  });

  it('skips a Document already marked Filed and picks the next one', async () => {
    const rows = [row({ id: 1 }), row({ id: 2 })];
    const store = new FakeRunStore(settings);
    await store.markFiled(1, 1000);
    const portal = new FakeRunPortalPort(rows, new Map([[2, buildExportZip(2)]]));

    const result = await runOne({ portal, archive: new FakeArchivePort(), store, clock: new FakeClock(1) });

    expect(result).toMatchObject({ filed: true, documentId: 2 });
    expect(portal.exportCalls).toEqual([2]);
  });

  it('returns filed:false and fetches no Export when every Document is already Filed', async () => {
    const rows = [row({ id: 1 })];
    const store = new FakeRunStore(settings);
    await store.markFiled(1, 1000);
    const archive = new FakeArchivePort();
    const portal = new FakeRunPortalPort(rows, new Map());

    const result = await runOne({ portal, archive, store, clock: new FakeClock(1) });

    expect(result).toEqual({ filed: false });
    expect(archive.files.size).toBe(0);
    expect(portal.exportCalls).toEqual([]);
  });

  it('re-running over the same Document overwrites at identical paths rather than a (1) copy (ADR-0004)', async () => {
    const rows = [row({ id: 9 })];
    const exports = new Map([[9, buildExportZip(9)]]);
    const archive = new FakeArchivePort();
    const clock = new FakeClock(1);
    // A store that never records Filed, so runOne re-selects the same Document each time.
    const neverFiledStore: RunStore = {
      getSettings: async () => settings,
      isFiled: async () => false,
      markFiled: async () => {},
    };
    const runPorts: RunPorts = { portal: new FakeRunPortalPort(rows, exports), archive, store: neverFiledStore, clock };

    await runOne(runPorts);
    const pathsAfterFirstRun = [...archive.files.keys()].sort();

    await runOne({ ...runPorts, portal: new FakeRunPortalPort(rows, exports) });
    const pathsAfterSecondRun = [...archive.files.keys()].sort();

    expect(pathsAfterSecondRun).toEqual(pathsAfterFirstRun);
    expect(archive.writeLog).toHaveLength(4); // 2 files, written once per run
  });

  it('marks a Document Filed only once every one of its files is written', async () => {
    const rows = [row({ id: 3, brojPriloga: 1 })];
    const exports = new Map([[3, buildExportZip(3, ['Prilog.pdf'])]]);
    const archive = new FakeArchivePort();
    archive.failAfterWrites = 1; // the eRačun writes fine; the visualisation write fails
    const store = new FakeRunStore(settings);
    const portal = new FakeRunPortalPort(rows, exports);

    await expect(runOne({ portal, archive, store, clock: new FakeClock(1) })).rejects.toThrow(
      'simulated failure writing',
    );

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

    const result = await runOne({ portal, archive: new FakeArchivePort(), store, clock: new FakeClock(1) });

    expect(result).toMatchObject({
      filed: true,
      directory: ['Arhiva', 'Primatelj d.o.o', '2026', '02', 'Prvo Ime d.o.o'],
    });
  });

  it.each([
    ['datumZaprimanja', { datumZaprimanja: undefined }],
    ['brojPriloga', { brojPriloga: undefined }],
    ['kupac', { kupac: undefined }],
    ['kupac.naziv', { kupac: { oib: '22222222222' } }],
  ])('fails loudly when the selected Document is missing %s, rather than filling in a default', async (_name, overrides) => {
    const rows = [row({ id: 1, ...overrides })];
    const portal = new FakeRunPortalPort(rows, new Map());

    await expect(
      runOne({ portal, archive: new FakeArchivePort(), store: new FakeRunStore(settings), clock: new FakeClock(1) }),
    ).rejects.toThrow(RunError);
  });

  it('files the target Document even when an unrelated, already-Filed historical row is malformed', async () => {
    // A row missing `kupac` entirely — malformed, but irrelevant to today's target and already
    // Filed. It must not abort the Run ("a failure to stop only its own Document", issue #1).
    const malformedHistoricalRow = { ...row({ id: 1 }), kupac: undefined };
    const rows = [malformedHistoricalRow, row({ id: 2 })];
    const store = new FakeRunStore(settings);
    await store.markFiled(1, 1);
    const portal = new FakeRunPortalPort(rows, new Map([[2, buildExportZip(2)]]));

    const result = await runOne({ portal, archive: new FakeArchivePort(), store, clock: new FakeClock(1) });

    expect(result).toMatchObject({ filed: true, documentId: 2 });
  });
});
