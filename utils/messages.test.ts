// The messaging boundary's one hard requirement: what crosses it must survive **JSON**
// serialisation. Chrome JSON-serialises extension messages where Firefox clones them
// structurally, so an ArrayBuffer that arrives intact on Firefox arrives as `{}` on Chrome —
// which is how a whole Chrome Run failed with "Export body does not begin with a ZIP signature
// (PK)" while Firefox filed the same Documents fine.

import { describe, expect, it } from 'vitest';
import { decodeExportBytes, encodeExportBytes, type ExportDocumentResponse } from './messages';

/** Stands in for Chrome's messaging: a message goes over the wire as JSON, not as a clone. */
function overChromeMessaging<T>(message: T): T {
  return JSON.parse(JSON.stringify(message)) as T;
}

describe('the Export across the messaging boundary', () => {
  it('recovers the exact bytes after a round trip through JSON messaging', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x7f, 0x80, 0xfe]);

    const response: ExportDocumentResponse = { ok: true, bytes: encodeExportBytes(zip) };
    const received = overChromeMessaging(response);
    expect(received.ok).toBe(true);

    const decoded = new Uint8Array(decodeExportBytes((received as { bytes: string }).bytes));
    expect(decoded).toEqual(zip);
  });

  it('would have lost an ArrayBuffer sent raw — the bug this encoding exists to prevent', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

    const received = overChromeMessaging({ ok: true, bytes: zip.buffer });

    // `{}` on the far side: length 0, no PK, indistinguishable from the Portal serving garbage.
    expect(new Uint8Array(received.bytes as ArrayBuffer & Record<string, never>).length).toBe(0);
  });

  it('carries a large Export without blowing the call stack — a real ZIP is not small', () => {
    const big = new Uint8Array(2 * 1024 * 1024); // 2 MB
    for (let i = 0; i < big.length; i++) {
      big[i] = i % 256;
    }

    const decoded = new Uint8Array(decodeExportBytes(encodeExportBytes(big)));

    // Compared by sampling rather than a 2M-element deep equal, which costs seconds; byte-identity
    // itself is pinned by the round-trip test above.
    expect(decoded.length).toBe(big.length);
    for (const at of [0, 1, 0x7fff, 0x8000, 0x8001, big.length - 1]) {
      expect(decoded[at]).toBe(big[at]);
    }
  });

  it('accepts an ArrayBuffer as well as a Uint8Array — exportDocument returns the former', () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);

    expect(encodeExportBytes(bytes.buffer)).toBe(encodeExportBytes(bytes));
  });
});
