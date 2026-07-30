// Pure `.eml` (RFC 5322 + MIME) assembly for the Bundle (issue #12). No network, no browser,
// no fakes — see CONTEXT.md ("Bundle") and ADR-0003. utils/bundle.ts is the only caller: it
// gathers the month's attachments, this module only turns them into message bytes.
//
// Deliberately minimal: MIME-Version, Date, To, Subject, a multipart/mixed body with an
// optional text part and one part per attachment. No `From` — the extension holds no mail
// credentials and knows no address to put there (ADR-0003); the user's own mail client fills
// its default identity in when the file is opened.

const CRLF = '\r\n';

/** Base64-encodes in fixed-size chunks rather than `btoa(String.fromCharCode(...bytes))` in one
 * call, which blows the call stack on anything but a small file (utils/archive.ts and
 * utils/store.ts each have the same helper, for the same reason). */
function toBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
  }
  return btoa(binary);
}

/** Wraps a base64 string at 76 characters (RFC 2045 §6.8), the line length every MIME decoder
 * assumes even though it is not strictly mandatory for correctness. */
function wrapBase64(base64: string): string {
  const LINE_LENGTH = 76;
  const lines: string[] = [];
  for (let offset = 0; offset < base64.length; offset += LINE_LENGTH) {
    lines.push(base64.slice(offset, offset + LINE_LENGTH));
  }
  return lines.join(CRLF);
}

const ASCII_ONLY = /^[\x00-\x7f]*$/;

/** RFC 2047 encoded-word, used for a header value (the Subject) that may carry Croatian
 * diacritics. Left alone when the value is already pure ASCII, so an English-only subject
 * template reads unencoded like any ordinary header. */
function encodeHeaderValue(value: string): string {
  if (ASCII_ONLY.test(value)) return value;
  return `=?UTF-8?B?${toBase64(new TextEncoder().encode(value))}?=`;
}

export interface EmlAttachment {
  /** ASCII filename — every caller in this project derives it from utils/filing.ts's
   * `documentStem`/`eracunFilename`, which never contain non-ASCII characters, so this module
   * does not RFC-2231-encode `Content-Disposition`'s filename parameter. */
  filename: string;
  bytes: Uint8Array;
  mimeType?: string;
}

export interface EmlMessage {
  to: string;
  subject: string;
  /** Plain-text body, before the attachments. Empty string produces a body-less text part. */
  body?: string;
  attachments: readonly EmlAttachment[];
  /** Injected for deterministic tests; the real caller (utils/bundle.ts) lets both default. */
  date?: Date;
  boundary?: string;
}

const DEFAULT_MIME_TYPE = 'application/xml';

function textPart(boundary: string, body: string): string {
  return (
    `--${boundary}${CRLF}` +
    `Content-Type: text/plain; charset="UTF-8"${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    `${wrapBase64(toBase64(new TextEncoder().encode(body)))}${CRLF}`
  );
}

function attachmentPart(boundary: string, attachment: EmlAttachment): string {
  const mimeType = attachment.mimeType ?? DEFAULT_MIME_TYPE;
  return (
    `--${boundary}${CRLF}` +
    `Content-Type: ${mimeType}; name="${attachment.filename}"${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}` +
    `Content-Disposition: attachment; filename="${attachment.filename}"${CRLF}${CRLF}` +
    `${wrapBase64(toBase64(attachment.bytes))}${CRLF}`
  );
}

/** Assembles a complete `.eml` file's bytes: headers plus a multipart/mixed body carrying the
 * text part and every attachment, in the order given. Attachment bytes are base64-encoded
 * unchanged — this module never inspects or re-serialises them, so the XAdES signature inside
 * an eRačun XML attachment survives untouched (ADR-0003, trap 9). */
export function assembleEml(message: EmlMessage): Uint8Array {
  const boundary = message.boundary ?? `emr-${crypto.randomUUID()}`;
  const date = message.date ?? new Date();

  const headers = [
    'MIME-Version: 1.0',
    `Date: ${date.toUTCString()}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeaderValue(message.subject)}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].join(CRLF);

  const parts = [textPart(boundary, message.body ?? ''), ...message.attachments.map((a) => attachmentPart(boundary, a))];

  const eml = `${headers}${CRLF}${CRLF}${parts.join('')}--${boundary}--${CRLF}`;
  return new TextEncoder().encode(eml);
}
