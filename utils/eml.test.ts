import { describe, expect, it } from 'vitest';
import { assembleEml } from './eml';

const FIXED_DATE = new Date('2026-07-30T10:00:00.000Z');
const BOUNDARY = 'fixed-boundary';

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

describe('assembleEml', () => {
  it('produces RFC 5322 headers naming the recipient, subject and a multipart boundary', () => {
    const eml = decode(
      assembleEml({
        to: 'knjigovoda@example.com',
        subject: 'eRacuni 07/2026',
        attachments: [],
        date: FIXED_DATE,
        boundary: BOUNDARY,
      }),
    );

    expect(eml).toContain('MIME-Version: 1.0\r\n');
    expect(eml).toContain('Date: Thu, 30 Jul 2026 10:00:00 GMT\r\n');
    expect(eml).toContain('To: knjigovoda@example.com\r\n');
    expect(eml).toContain('Subject: eRacuni 07/2026\r\n');
    expect(eml).toContain(`Content-Type: multipart/mixed; boundary="${BOUNDARY}"\r\n`);
  });

  it('never sends a From header — the extension holds no mail credentials (ADR-0003)', () => {
    const eml = decode(
      assembleEml({ to: 'knjigovoda@example.com', subject: 'x', attachments: [], date: FIXED_DATE, boundary: BOUNDARY }),
    );

    expect(eml).not.toMatch(/^From:/m);
  });

  it('RFC 2047-encodes a subject carrying Croatian diacritics', () => {
    const eml = decode(
      assembleEml({ to: 'a@example.com', subject: 'eRačuni 07/2026', attachments: [], date: FIXED_DATE, boundary: BOUNDARY }),
    );

    expect(eml).toContain(`Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent('eRačuni 07/2026')))}?=\r\n`);
    expect(eml).not.toContain('eRačuni 07/2026');
  });

  it('leaves a pure-ASCII subject unencoded', () => {
    const eml = decode(
      assembleEml({ to: 'a@example.com', subject: 'eRacuni 07/2026', attachments: [], date: FIXED_DATE, boundary: BOUNDARY }),
    );

    expect(eml).toContain('Subject: eRacuni 07/2026\r\n');
  });

  it('produces a valid message for a month with no Documents — a body part and zero attachment parts', () => {
    const eml = decode(
      assembleEml({ to: 'a@example.com', subject: 'x', body: 'Nema dokumenata.', attachments: [], date: FIXED_DATE, boundary: BOUNDARY }),
    );

    // Exactly two boundary occurrences of the closing kind: the one part (text) plus the terminator.
    expect(eml.match(new RegExp(`--${BOUNDARY}\r\n`, 'g'))).toHaveLength(1);
    expect(eml).toContain(`--${BOUNDARY}--\r\n`);
    expect(eml).toContain('Content-Type: text/plain; charset="UTF-8"');
  });

  it('attaches every given attachment as base64, one MIME part each, named and typed correctly', () => {
    const eml = decode(
      assembleEml({
        to: 'a@example.com',
        subject: 'x',
        attachments: [
          { filename: '2026-07-01_1-1-1.xml', bytes: new TextEncoder().encode('<StandardBusinessDocument/>') },
          { filename: '2026-07-15_2-1-1.xml', bytes: new TextEncoder().encode('<StandardBusinessDocument/>') },
        ],
        date: FIXED_DATE,
        boundary: BOUNDARY,
      }),
    );

    expect(eml).toContain('Content-Type: application/xml; name="2026-07-01_1-1-1.xml"');
    expect(eml).toContain('Content-Disposition: attachment; filename="2026-07-01_1-1-1.xml"');
    expect(eml).toContain('Content-Type: application/xml; name="2026-07-15_2-1-1.xml"');
    expect(eml.match(new RegExp(`--${BOUNDARY}\r\n`, 'g'))).toHaveLength(3); // text part + 2 attachments
  });

  it('base64-encodes attachment bytes byte-identically — decoding the MIME part recovers the exact input', () => {
    const original = new Uint8Array([0x3c, 0x3f, 0x78, 0x6d, 0x6c, 0x00, 0xff, 0x10, 0x9a]); // arbitrary bytes, including a NUL and high bytes
    const eml = decode(
      assembleEml({
        to: 'a@example.com',
        subject: 'x',
        attachments: [{ filename: 'test.xml', bytes: original }],
        date: FIXED_DATE,
        boundary: BOUNDARY,
      }),
    );

    const body = eml.split(`Content-Disposition: attachment; filename="test.xml"\r\n\r\n`)[1];
    const encoded = body.split(`\r\n--${BOUNDARY}--`)[0];
    const decoded = Uint8Array.from(atob(encoded.replace(/\r\n/g, '')), (c) => c.charCodeAt(0));

    expect(decoded).toEqual(original);
  });

  it('wraps a large attachment body at 76 characters per line (RFC 2045)', () => {
    const bytes = new Uint8Array(1000).fill(65);
    const eml = decode(
      assembleEml({ to: 'a@example.com', subject: 'x', attachments: [{ filename: 'big.xml', bytes }], date: FIXED_DATE, boundary: BOUNDARY }),
    );

    const body = eml.split('\r\n\r\n')[2].split(`\r\n--${BOUNDARY}--`)[0];
    for (const line of body.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it('base64-encodes a large attachment without blowing the call stack', () => {
    const bytes = new Uint8Array(500_000).fill(65); // 500 KB
    expect(() =>
      assembleEml({ to: 'a@example.com', subject: 'x', attachments: [{ filename: 'big.xml', bytes }], date: FIXED_DATE, boundary: BOUNDARY }),
    ).not.toThrow();
  });

  it('generates a distinct boundary per call when none is given, so two messages never collide', () => {
    const a = decode(assembleEml({ to: 'a@example.com', subject: 'x', attachments: [], date: FIXED_DATE }));
    const b = decode(assembleEml({ to: 'a@example.com', subject: 'x', attachments: [], date: FIXED_DATE }));

    const boundaryOf = (eml: string) => /boundary="([^"]+)"/.exec(eml)![1];
    expect(boundaryOf(a)).not.toBe(boundaryOf(b));
  });
});
