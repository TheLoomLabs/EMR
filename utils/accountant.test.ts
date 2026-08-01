import { describe, expect, it } from 'vitest';
import { AccountantAddressError, parseAccountantAddresses } from './accountant';

describe('parseAccountantAddresses', () => {
  it('parses a single address', () => {
    expect(parseAccountantAddresses('ana@primjer.hr')).toEqual(['ana@primjer.hr']);
  });

  it('splits several addresses on commas', () => {
    expect(parseAccountantAddresses('ana@primjer.hr,ivo@primjer.hr')).toEqual(['ana@primjer.hr', 'ivo@primjer.hr']);
  });

  it('trims surrounding whitespace around each address', () => {
    expect(parseAccountantAddresses(' ana@primjer.hr , ivo@primjer.hr ')).toEqual(['ana@primjer.hr', 'ivo@primjer.hr']);
  });

  it('tolerates a trailing comma', () => {
    expect(parseAccountantAddresses('ana@primjer.hr,')).toEqual(['ana@primjer.hr']);
  });

  it('tolerates a doubled comma', () => {
    expect(parseAccountantAddresses('ana@primjer.hr,,ivo@primjer.hr')).toEqual(['ana@primjer.hr', 'ivo@primjer.hr']);
  });

  it('returns an empty list for an empty field', () => {
    expect(parseAccountantAddresses('')).toEqual([]);
  });

  it('returns an empty list for a field that is only whitespace and commas', () => {
    expect(parseAccountantAddresses('  , , '.trim())).toEqual([]);
  });

  it('does not accept a semicolon as a separator — the whole entry fails validation instead', () => {
    expect(() => parseAccountantAddresses('ana@primjer.hr;ivo@primjer.hr')).toThrow(AccountantAddressError);
  });

  it('blocks and names an entry missing its domain', () => {
    expect(() => parseAccountantAddresses('ana@')).toThrow('"ana@" is not an email address.');
  });

  it('blocks and names an entry missing the @', () => {
    expect(() => parseAccountantAddresses('ana.primjer.hr')).toThrow(AccountantAddressError);
  });

  it('names the specific bad entry among otherwise-valid ones', () => {
    expect(() => parseAccountantAddresses('ana@primjer.hr, ivo@, marko@primjer.hr')).toThrow('"ivo@" is not an email address.');
  });
});
