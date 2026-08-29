// The message contract between the popup and the Portal content script (issue #7). The content
// script runs the actual list request (ADR-0005); the popup only asks for the result over
// browser.runtime messaging, since it has no access to the Portal page itself.
//
// Everything crossing this boundary must survive **JSON** serialisation, not structured
// cloning. Firefox clones extension messages structurally, so an ArrayBuffer arrives intact;
// Chrome JSON-serialises them, and `JSON.stringify(arrayBuffer)` is `{}` — the Export's bytes
// arrived as an empty object, every Document in a Run failed with "Export body does not begin
// with a ZIP signature (PK)", and Firefox never showed it (found live on Chrome). Hence the
// Export's bytes travel as base64 (`encodeExportBytes`/`decodeExportBytes` below) rather than
// as an ArrayBuffer, the same reason utils/store.ts and utils/archive.ts base64 their bytes for
// storage and for disk. Keep any future binary payload on this same path.

import type { DocumentRow, FilterParams } from './portal';

export interface ListDocumentsMessage {
  type: 'emr:list-documents';
  /** Bounds the Portal's own search, per docs/portal-api.md's server-side filtering — omitted
   * for a normal Run's unbounded walk of the full history (ADR-0008), given for the first-run
   * backfill's bounded window (issue #11, utils/backfill.ts). */
  filterParams?: FilterParams;
}

export type ListDocumentsResponse =
  | { ok: true; recordsTotal: number; rows: DocumentRow[] }
  | { ok: false; error: string };

export function isListDocumentsMessage(message: unknown): message is ListDocumentsMessage {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'emr:list-documents';
}

export interface ExportDocumentMessage {
  type: 'emr:export-document';
  id: number;
}

export type ExportDocumentResponse =
  /** Base64, never an ArrayBuffer — see the JSON-serialisation note at the top of this file. */
  { ok: true; bytes: string } | { ok: false; error: string };

export function isExportDocumentMessage(message: unknown): message is ExportDocumentMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'emr:export-document' &&
    typeof (message as { id?: unknown }).id === 'number'
  );
}

/** Base64-encodes in fixed-size chunks rather than `btoa(String.fromCharCode(...bytes))` in one
 * call, which blows the call stack on anything but a small file (utils/store.ts, utils/eml.ts and
 * utils/archive.ts each carry the same helper, for the same reason). */
export function encodeExportBytes(body: ArrayBuffer | Uint8Array): string {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
  }
  return btoa(binary);
}

/** The inverse, byte-identical: the Export's bytes are a ZIP that utils/export.ts unpacks and,
 * for the eRačun, an XAdES-signed document nothing may re-serialise (trap 1). */
export function decodeExportBytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
