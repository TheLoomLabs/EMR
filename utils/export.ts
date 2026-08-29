// Unpack and validate an Export (issue #5) — pure logic, no network, no fakes.
// See CONTEXT.md (Export, Prilog) and docs/portal-api.md ("The Export", traps 9, 11).

import { unzipSync } from 'fflate';

/** Thrown for every way an Export can fail to be what the Portal promised. Every failure here
 * is a drift signal: the Portal owes us no API stability, and the failure mode that actually
 * loses Documents is silent success. */
export class ExportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportValidationError';
  }
}

export interface Prilog {
  /** The Issuer-given filename, exactly as it appears in the ZIP entry, with the `{id}/`
   * prefix already stripped. Not yet sanitised for the filesystem — that is Archive
   * filenames' job (utils/filing.ts). */
  name: string;
  bytes: Uint8Array;
}

export interface UnpackedExport {
  /** The eRačun's raw bytes, exactly as received — never re-serialised, unwrapped or
   * pretty-printed, because that voids the XAdES signature. */
  eracun: Uint8Array;
  visualisation: Uint8Array;
  prilozi: Prilog[];
}

const PORTAL_GENERATED_XML = /^[0-9a-f]{32}\.xml$/i;
const PORTAL_GENERATED_PDF = /^[0-9a-f]{32}\.pdf$/i;

// Optional BOM, optional XML declaration, optional leading comments, then the SBDH root —
// possibly namespace-prefixed. Never used to touch the bytes returned to the caller.
const SBDH_ROOT = /^<(?:[A-Za-z_][\w.-]*:)?StandardBusinessDocument(?=[\s/>])/;

/** Given the bytes of an Export and its row's `brojPriloga`, produces named entries ready to
 * write — or fails loudly with `ExportValidationError`. See docs/portal-api.md, "The Export". */
export function unpackExport(body: ArrayBuffer | Uint8Array, brojPriloga: number): UnpackedExport {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);

  // The response carries no Content-Type — content sniffing will not help, so this is the one
  // check that stands in for it. Also catches a JSON error body served with status 200.
  //
  // The failure names what actually arrived (length, first bytes). Without that, an empty body
  // and a JSON error body read identically in the report, which is exactly what made the Chrome
  // messaging bug (utils/messages.ts) look like a Portal problem for a whole Run.
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new ExportValidationError(
      `Export body does not begin with a ZIP signature (PK) — not a ZIP, possibly a JSON error body served with status 200 (${describeBody(bytes)})`,
    );
  }

  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes);
  } catch (cause) {
    throw new ExportValidationError(`Export body could not be unzipped: ${(cause as Error).message}`);
  }

  const entryPaths = Object.keys(unzipped).filter((path) => !path.endsWith('/'));
  const strippedNames = stripIdDirectory(entryPaths);

  const expectedCount = 1 + 1 + brojPriloga;
  if (entryPaths.length !== expectedCount) {
    throw new ExportValidationError(
      `Export has ${entryPaths.length} entries, expected ${expectedCount} (1 eRačun + 1 visualisation + brojPriloga ${brojPriloga})`,
    );
  }

  let eracunPath: string | undefined;
  let visualisationPath: string | undefined;
  const prilozi: Prilog[] = [];

  for (const path of entryPaths) {
    const name = strippedNames.get(path)!;
    if (PORTAL_GENERATED_XML.test(name)) {
      if (eracunPath !== undefined) {
        throw new ExportValidationError(
          `Export has more than one {32-hex}.xml entry: "${eracunPath}" and "${path}"`,
        );
      }
      eracunPath = path;
    } else if (PORTAL_GENERATED_PDF.test(name)) {
      if (visualisationPath !== undefined) {
        throw new ExportValidationError(
          `Export has more than one {32-hex}.pdf entry: "${visualisationPath}" and "${path}"`,
        );
      }
      visualisationPath = path;
    } else {
      prilozi.push({ name, bytes: unzipped[path] });
    }
  }

  if (eracunPath === undefined) {
    throw new ExportValidationError('Export has no {32-hex}.xml entry — no eRačun found');
  }
  if (visualisationPath === undefined) {
    throw new ExportValidationError('Export has no {32-hex}.pdf entry — no visualisation found');
  }

  const eracun = unzipped[eracunPath];
  assertStandardBusinessDocumentRoot(eracun);

  return { eracun, visualisation: unzipped[visualisationPath], prilozi };
}

/** Strips the `{id}/` prefix every Export entry shares (trap 11) and returns each entry's name
 * relative to it. Fails if entries are not all nested exactly one level under the same
 * directory — a shape the Portal has never been observed to produce. */
function stripIdDirectory(paths: string[]): Map<string, string> {
  if (paths.length === 0) {
    throw new ExportValidationError('Export ZIP has no entries');
  }

  const [first] = paths;
  const slash = first.indexOf('/');
  if (slash === -1) {
    throw new ExportValidationError(`Export entry "${first}" is not nested under an id directory`);
  }
  const prefix = first.slice(0, slash + 1);

  const names = new Map<string, string>();
  for (const path of paths) {
    if (!path.startsWith(prefix)) {
      throw new ExportValidationError(
        `Export entries are not all nested under the same id directory: "${first}" vs "${path}"`,
      );
    }
    const rest = path.slice(prefix.length);
    if (rest === '' || rest.includes('/')) {
      throw new ExportValidationError(`Export entry "${path}" is not exactly one level under the id directory`);
    }
    names.set(path, rest);
  }
  return names;
}

/** The eRačun's root element must be `StandardBusinessDocument`, not `Invoice` (trap 9) — checked
 * by decoding a lookahead of the bytes for validation only. The bytes returned to the caller are
 * never touched. */
function assertStandardBusinessDocumentRoot(xml: Uint8Array): void {
  const head = new TextDecoder('utf-8').decode(xml.subarray(0, 4096));
  const withoutBom = head.replace(/^\uFEFF/, '');
  const withoutDeclaration = withoutBom.replace(/^\s*<\?xml[^?]*\?>/, '');
  const withoutComments = withoutDeclaration.replace(/^(\s*<!--[\s\S]*?-->)*/, '');
  if (!SBDH_ROOT.test(withoutComments.trimStart())) {
    throw new ExportValidationError(
      'eRačun XML root element is not StandardBusinessDocument (trap 9) — the Export may not be SBDH-wrapped, or the body is not the eRačun',
    );
  }
}

/** What arrived instead of a ZIP, said in one clause: how many bytes, and — for a short,
 * printable body, which is what an error payload is — the body itself, so the report carries the
 * Portal's own words rather than a guess about them. */
function describeBody(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return 'body was empty';
  }
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 200));
  const printable = /^[\t\n\r\x20-\x7e\u00a0-\uffff]*$/.test(head);
  const shown = printable ? `starts "${head.slice(0, 120)}"` : `starts with bytes ${[...bytes.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`;
  return `${bytes.length} bytes, ${shown}`;
}
