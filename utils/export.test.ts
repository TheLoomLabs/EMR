import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ExportValidationError, unpackExport } from './export';

// Purely synthetic — not a value seen in any capture.
const XML_HEX = 'deadbeefdeadbeefdeadbeefdeadbeef';
const PDF_HEX = 'cafebabecafebabecafebabecafebabe';

const SYNTHETIC_ERACUN_XML =
  '<StandardBusinessDocument xmlns="urn:example:sbdh">' +
  '<StandardBusinessDocumentHeader/>' +
  '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/>' +
  '</StandardBusinessDocument>';

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Builds a synthetic Export ZIP to the shape docs/portal-api.md documents: entries nested
 * under `{id}/`, a {32-hex}.xml eRačun and {32-hex}.pdf visualisation, plus whatever else. */
function buildExportZip(
  files: Record<string, Uint8Array>,
  { id = '999999', flat = false }: { id?: string; flat?: boolean } = {},
): Uint8Array {
  const prefixed: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(files)) {
    prefixed[flat ? name : `${id}/${name}`] = bytes;
  }
  return zipSync(prefixed, { level: 0 });
}

function validExportFiles(priloziCount: number): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {
    [`${XML_HEX}.xml`]: utf8(SYNTHETIC_ERACUN_XML),
    [`${PDF_HEX}.pdf`]: utf8('%PDF-1.4 synthetic visualisation'),
  };
  for (let i = 0; i < priloziCount; i++) {
    files[`Prilog-${i}.pdf`] = utf8(`synthetic prilog ${i}`);
  }
  return files;
}

describe('unpackExport — a valid Export', () => {
  it('strips the {id}/ prefix, identifies the eRačun and visualisation, and returns bytes unchanged (zero Prilozi)', () => {
    const zip = buildExportZip(validExportFiles(0));

    const result = unpackExport(zip, 0);

    expect(new TextDecoder().decode(result.eracun)).toBe(SYNTHETIC_ERACUN_XML);
    expect(new TextDecoder().decode(result.visualisation)).toBe('%PDF-1.4 synthetic visualisation');
    expect(result.prilozi).toEqual([]);
  });

  it('collects every Prilog by its Issuer-given name, with the id prefix stripped (two Prilozi)', () => {
    const zip = buildExportZip(validExportFiles(2));

    const result = unpackExport(zip, 2);

    expect(result.prilozi).toHaveLength(2);
    const names = result.prilozi.map((p) => p.name).sort();
    expect(names).toEqual(['Prilog-0.pdf', 'Prilog-1.pdf']);
    expect(names.every((name) => !name.includes('/'))).toBe(true);
  });

  it('accepts an ArrayBuffer, matching how fetch delivers the response', () => {
    const zip = buildExportZip(validExportFiles(0));
    const buffer = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;

    const result = unpackExport(buffer, 0);

    expect(result.prilozi).toEqual([]);
  });
});

describe('unpackExport — failures', () => {
  it('fails when the body does not begin with PK, including a JSON error body served with status 200', () => {
    const jsonErrorBody = utf8('{"error":"session expired"}');

    expect(() => unpackExport(jsonErrorBody, 0)).toThrow(ExportValidationError);
    expect(() => unpackExport(jsonErrorBody, 0)).toThrow(/PK/);
  });

  it('fails when entry count does not equal 1 + 1 + brojPriloga', () => {
    const zip = buildExportZip(validExportFiles(1));

    expect(() => unpackExport(zip, 2)).toThrow(ExportValidationError);
    expect(() => unpackExport(zip, 2)).toThrow(/entries, expected/);
  });

  it('fails when there is no {32-hex}.xml entry', () => {
    const files = validExportFiles(0);
    delete files[`${XML_HEX}.xml`];
    files['not-hex-at-all.xml'] = utf8(SYNTHETIC_ERACUN_XML);
    const zip = buildExportZip(files);

    expect(() => unpackExport(zip, 0)).toThrow(/no eRačun/);
  });

  it('fails when there is no {32-hex}.pdf entry', () => {
    const files = validExportFiles(0);
    delete files[`${PDF_HEX}.pdf`];
    files['not-hex-at-all.pdf'] = utf8('%PDF');
    const zip = buildExportZip(files);

    expect(() => unpackExport(zip, 0)).toThrow(/no visualisation/);
  });

  it('fails when the eRačun root element is not StandardBusinessDocument (trap 9)', () => {
    const files = validExportFiles(0);
    files[`${XML_HEX}.xml`] = utf8(
      '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/>',
    );
    const zip = buildExportZip(files);

    expect(() => unpackExport(zip, 0)).toThrow(/StandardBusinessDocument/);
  });

  it('fails when entries are not nested under an id directory at all', () => {
    const zip = buildExportZip(validExportFiles(0), { flat: true });

    expect(() => unpackExport(zip, 0)).toThrow(/id directory/);
  });

  it('fails when there is more than one {32-hex}.xml entry', () => {
    const files = validExportFiles(0);
    files['11111111111111111111111111111111.xml'] = utf8(SYNTHETIC_ERACUN_XML);
    const zip = buildExportZip(files);

    expect(() => unpackExport(zip, 1)).toThrow(/more than one \{32-hex\}\.xml/);
  });

  it('fails when there is more than one {32-hex}.pdf entry', () => {
    const files = validExportFiles(0);
    files['22222222222222222222222222222222.pdf'] = utf8('%PDF-1.4 second visualisation');
    const zip = buildExportZip(files);

    expect(() => unpackExport(zip, 1)).toThrow(/more than one \{32-hex\}\.pdf/);
  });

  it('fails when entries are nested under inconsistent id directories', () => {
    const files = validExportFiles(0);
    const zip = zipSync(
      {
        [`111/${XML_HEX}.xml`]: files[`${XML_HEX}.xml`],
        [`222/${PDF_HEX}.pdf`]: files[`${PDF_HEX}.pdf`],
      },
      { level: 0 },
    );

    expect(() => unpackExport(zip, 0)).toThrow(/same id directory/);
  });
});

const FIXTURE_PATH = fileURLToPath(new URL('../captures/dokumenti.zip', import.meta.url));

// Real Export capture, git-ignored because it holds real invoice data (docs/portal-api.md).
// Skips cleanly when absent so the suite runs without it. Per that doc, the fixture has
// brojPriloga: 1 and three entries.
describe.skipIf(!existsSync(FIXTURE_PATH))('unpackExport — against captures/dokumenti.zip', () => {
  it('unpacks the real fixture into an eRačun, a visualisation and one Prilog', () => {
    const bytes = readFileSync(FIXTURE_PATH);

    const result = unpackExport(bytes, 1);

    expect(new TextDecoder().decode(result.eracun.subarray(0, 200))).toContain('<StandardBusinessDocument');
    expect(result.visualisation.byteLength).toBeGreaterThan(0);
    expect(result.prilozi).toHaveLength(1);
    expect(result.prilozi[0].bytes.byteLength).toBeGreaterThan(0);
    expect(result.prilozi[0].name).not.toContain('/');
  });

  it('fails loudly when brojPriloga does not match the fixture', () => {
    const bytes = readFileSync(FIXTURE_PATH);

    expect(() => unpackExport(bytes, 0)).toThrow(ExportValidationError);
  });
});
