import { beforeEach, describe, expect, it } from 'vitest';
import { AppTokenUnavailableError, getAppToken, observeAppToken, resetAppToken } from './apptoken';

beforeEach(() => {
  resetAppToken();
});

describe('getAppToken', () => {
  it('fails loudly when no token has been observed yet, rather than returning nothing', () => {
    expect(() => getAppToken()).toThrow(AppTokenUnavailableError);
  });

  it('returns a value once one has been observed', () => {
    observeAppToken('c29tZS10b2tlbi12YWx1ZQ==');

    expect(getAppToken()).toBe('c29tZS10b2tlbi12YWx1ZQ==');
  });

  it('returns the most recently observed value when several arrive', () => {
    observeAppToken('first');
    observeAppToken('second');

    expect(getAppToken()).toBe('second');
  });

  it('ignores an empty string, which the Portal would never actually attach', () => {
    observeAppToken('real-value');
    observeAppToken('');

    expect(getAppToken()).toBe('real-value');
  });

  it('still fails loudly if only an empty string has ever been observed', () => {
    observeAppToken('');

    expect(() => getAppToken()).toThrow(AppTokenUnavailableError);
  });
});
