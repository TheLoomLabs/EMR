import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { storage } from '#imports';
import { DEFAULT_SETTINGS, getSettings, isFiled, markFiled, setSettings, type Settings } from './store';

beforeEach(() => {
  fakeBrowser.reset();
});

describe('getSettings', () => {
  it('returns sensible defaults when nothing has been set, so a Run can complete', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

const sample: Settings = {
  accountantEmail: 'knjigovodstvo@primjer.hr',
  subjectTemplate: 'eRačuni - {mjesec}/{godina}',
  archiveRoot: 'Poslovna arhiva',
};

describe('setSettings', () => {
  it('round-trips the values a user sets', async () => {
    await setSettings(sample);

    expect(await getSettings()).toEqual(sample);
  });

  it('persists to local browser storage, not just in-memory state, so it survives a restart', async () => {
    await setSettings(sample);

    expect(await storage.getItem('local:settings')).toEqual(sample);
  });
});

describe('isFiled', () => {
  it('is false for an id that has never been marked Filed', async () => {
    expect(await isFiled(1)).toBe(false);
  });

  it('is true once the id has been marked Filed', async () => {
    await markFiled(1, 1772233200000);

    expect(await isFiled(1)).toBe(true);
    expect(await isFiled(2)).toBe(false);
  });
});

describe('markFiled', () => {
  it('does not disturb other ids already marked Filed', async () => {
    await markFiled(1, 1000);
    await markFiled(2, 2000);

    expect(await isFiled(1)).toBe(true);
    expect(await isFiled(2)).toBe(true);
  });

  it('persists to local browser storage, so a lost Filed set only costs a re-fetch (ADR-0004)', async () => {
    await markFiled(7, 1772233200000);

    expect(await storage.getItem('local:filed')).toEqual({ 7: 1772233200000 });
  });
});
