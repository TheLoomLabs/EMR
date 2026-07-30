// The message contract between the popup and the Portal content script (issue #7). The content
// script runs the actual list request (ADR-0005); the popup only asks for the result over
// browser.runtime messaging, since it has no access to the Portal page itself.

import type { DocumentRow } from './portal';

export interface ListDocumentsMessage {
  type: 'emr:list-documents';
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

export type ExportDocumentResponse = { ok: true; bytes: ArrayBuffer } | { ok: false; error: string };

export function isExportDocumentMessage(message: unknown): message is ExportDocumentMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'emr:export-document' &&
    typeof (message as { id?: unknown }).id === 'number'
  );
}
