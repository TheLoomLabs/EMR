import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { storage } from '#imports';
import { DEFAULT_SETTINGS, getSettings, setSettings, type Settings } from './store';

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
