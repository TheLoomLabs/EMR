import { describe, expect, it } from 'vitest';
import { isOrdinaryInvoice, knownDocumentTypeCodes, markedTypeForCode } from './document-types';

describe('isOrdinaryInvoice', () => {
  it('is true for the two Ordinary invoice codes', () => {
    expect(isOrdinaryInvoice(380)).toBe(true);
    expect(isOrdinaryInvoice(82)).toBe(true);
  });

  it('is false for a Marked type code', () => {
    expect(isOrdinaryInvoice(381)).toBe(false);
  });

  it('is false for a code absent from the table', () => {
    expect(isOrdinaryInvoice(9999)).toBe(false);
  });
});

describe('markedTypeForCode', () => {
  it('is null for an Ordinary invoice', () => {
    expect(markedTypeForCode(380)).toBeNull();
    expect(markedTypeForCode(82)).toBeNull();
  });

  it('maps one code from each Marked type category', () => {
    expect(markedTypeForCode(81)).toBe('ODOBRENJE');
    expect(markedTypeForCode(80)).toBe('TERECENJE');
    expect(markedTypeForCode(384)).toBe('ISPRAVAK');
    expect(markedTypeForCode(386)).toBe('PREDUJAM');
    expect(markedTypeForCode(325)).toBe('PREDRACUN');
  });

  it('is NEPOZNATO for a code the docs explicitly leave unmapped', () => {
    expect(markedTypeForCode(130)).toBe('NEPOZNATO');
  });

  it('is NEPOZNATO for a code absent from the table entirely (drift)', () => {
    expect(markedTypeForCode(9999)).toBe('NEPOZNATO');
  });
});

describe('the shipped table', () => {
  it('accounts for exactly the 55 codes docs/document-types.md lists, none twice', () => {
    const codes = knownDocumentTypeCodes();
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBe(55);
  });
});
