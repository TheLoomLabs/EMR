import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { storage } from '#imports';
import {
  cacheEracun,
  DEFAULT_SETTINGS,
  getCachedEracun,
  getSettings,
  hasFiledAny,
  isFiled,
  markFiled,
  pruneEracunCache,
  setSettings,
  type Settings,
} from './store';

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

describe('hasFiledAny', () => {
  it('is false when nothing has ever been marked Filed (first use, issue #11)', async () => {
    expect(await hasFiledAny()).toBe(false);
  });

  it('is true once anything has been marked Filed', async () => {
    await markFiled(1, 1772233200000);

    expect(await hasFiledAny()).toBe(true);
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

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('cacheEracun / getCachedEracun', () => {
  it('is undefined for an id never cached', async () => {
    expect(await getCachedEracun(1)).toBeUndefined();
  });

  it('round-trips the exact bytes cached, byte-identical (trap 9 — never re-serialised)', async () => {
    const bytes = utf8('<StandardBusinessDocument>document 1</StandardBusinessDocument>');

    await cacheEracun(1, bytes, 1772233200000);

    expect(await getCachedEracun(1)).toEqual(bytes);
  });

  it('does not disturb other ids already cached', async () => {
    await cacheEracun(1, utf8('one'), 1000);
    await cacheEracun(2, utf8('two'), 2000);

    expect(await getCachedEracun(1)).toEqual(utf8('one'));
    expect(await getCachedEracun(2)).toEqual(utf8('two'));
  });

  it('persists each id under its own storage key, so caching one Document never rewrites another', async () => {
    await cacheEracun(1, utf8('one'), 1772233200000);
    await cacheEracun(2, utf8('two'), 1772233200001);

    const stored1 = (await storage.getItem('local:eracun-cache:1')) as { bytes: string; cachedAt: number };
    const stored2 = (await storage.getItem('local:eracun-cache:2')) as { bytes: string; cachedAt: number };
    expect(stored1.cachedAt).toBe(1772233200000);
    expect(stored2.cachedAt).toBe(1772233200001);
  });
});

describe('pruneEracunCache', () => {
  // Calendar dates picked so the day-of-month can never overflow across the subtraction
  // (28 exists in every month), keeping the boundary exact rather than approximate.
  const now = Date.UTC(2026, 1, 28); // 28 Feb 2026
  const exactlyTwentyFourMonthsAgo = Date.UTC(2024, 1, 28); // 28 Feb 2024
  const twentyFiveMonthsAgo = Date.UTC(2024, 0, 28); // 28 Jan 2024

  it('keeps an entry cached exactly 24 months ago', async () => {
    await cacheEracun(1, utf8('one'), exactlyTwentyFourMonthsAgo);

    await pruneEracunCache(now);

    expect(await getCachedEracun(1)).toEqual(utf8('one'));
  });

  it('drops an entry cached more than 24 months ago', async () => {
    await cacheEracun(1, utf8('one'), twentyFiveMonthsAgo);

    await pruneEracunCache(now);

    expect(await getCachedEracun(1)).toBeUndefined();
  });

  it('prunes only the stale entries, keeping recent ones', async () => {
    await cacheEracun(1, utf8('stale'), twentyFiveMonthsAgo);
    await cacheEracun(2, utf8('fresh'), now); // cached this instant

    await pruneEracunCache(now);

    expect(await getCachedEracun(1)).toBeUndefined();
    expect(await getCachedEracun(2)).toEqual(utf8('fresh'));
  });
});
