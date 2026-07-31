import { describe, expect, it } from 'vitest';
import { selectPortalTab, type CandidateTab } from './portal-tab';

describe('selectPortalTab', () => {
  it('finds the Portal tab among unrelated ones', () => {
    const tabs: CandidateTab[] = [
      { id: 1, url: 'https://example.com/' },
      { id: 2, url: 'https://mikroeracun.porezna-uprava.hr/ulazni-dokumenti' },
    ];

    expect(selectPortalTab(tabs)?.id).toBe(2);
  });

  it('returns undefined when no tab matches the Portal origin', () => {
    const tabs: CandidateTab[] = [{ id: 1, url: 'https://example.com/' }, { id: 2, url: 'about:blank' }];

    expect(selectPortalTab(tabs)).toBeUndefined();
  });

  it('returns undefined for an empty tab list', () => {
    expect(selectPortalTab([])).toBeUndefined();
  });

  it('prefers the active tab among several Portal tabs', () => {
    const tabs: CandidateTab[] = [
      { id: 1, url: 'https://mikroeracun.porezna-uprava.hr/a', active: false },
      { id: 2, url: 'https://mikroeracun.porezna-uprava.hr/b', active: true },
      { id: 3, url: 'https://mikroeracun.porezna-uprava.hr/c', active: false },
    ];

    expect(selectPortalTab(tabs)?.id).toBe(2);
  });

  it('falls back to the first match, in list order, when several Portal tabs are all inactive', () => {
    const tabs: CandidateTab[] = [
      { id: 1, url: 'https://mikroeracun.porezna-uprava.hr/a', active: false },
      { id: 2, url: 'https://mikroeracun.porezna-uprava.hr/b', active: false },
    ];

    expect(selectPortalTab(tabs)?.id).toBe(1);
  });

  it('ignores a tab whose url is missing or not well-formed', () => {
    const tabs: CandidateTab[] = [{ id: 1, url: 'not-a-url' }, { id: 2 }];

    expect(selectPortalTab(tabs)).toBeUndefined();
  });

  it('never matches a different origin sharing the same hostname text', () => {
    const tabs: CandidateTab[] = [{ id: 1, url: 'https://mikroeracun.porezna-uprava.hr.evil.example/' }];

    expect(selectPortalTab(tabs)).toBeUndefined();
  });
});
