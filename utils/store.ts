/** The `store` port (issue #1's Implementation Decisions → The seam). Settings are the only
 * configuration there is — the rest of the extension reads them through this module, never
 * through browser storage directly. */

export interface Settings {
  accountantEmail: string;
  subjectTemplate: string;
  archiveRoot: string;
}

/** A user who sets nothing can still complete a Run: Preuzmi only needs archiveRoot.
 * accountantEmail defaults empty — it's needed only for Pošalji, a separate button. */
export const DEFAULT_SETTINGS: Settings = {
  accountantEmail: '',
  subjectTemplate: 'eRačuni',
  archiveRoot: 'Arhiva',
};

const settingsItem = storage.defineItem<Settings>('local:settings', {
  fallback: DEFAULT_SETTINGS,
});

export function getSettings(): Promise<Settings> {
  return settingsItem.getValue();
}

export function setSettings(settings: Settings): Promise<void> {
  return settingsItem.setValue(settings);
}

/** The Filed set (ADR-0007): Document `id` → the instant it was Filed. A cache, not a source of
 * truth (ADR-0004) — losing it costs a re-fetch, never correctness. */
const filedItem = storage.defineItem<Record<number, number>>('local:filed', {
  fallback: {},
});

export async function isFiled(id: number): Promise<boolean> {
  const filed = await filedItem.getValue();
  return id in filed;
}

/** Records a Document as Filed only once every one of its files is on disk — callers must not
 * call this before every write for the Document has succeeded. */
export async function markFiled(id: number, filedAt: number): Promise<void> {
  const filed = await filedItem.getValue();
  await filedItem.setValue({ ...filed, [id]: filedAt });
}

/** Base64-encodes in fixed-size chunks rather than `btoa(String.fromCharCode(...bytes))` in one
 * call, which blows the call stack on anything but a small file (utils/archive.ts has the same
 * helper for the same reason — writing to storage, like writing to disk, needs a string). */
function toBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

interface CachedEracun {
  bytes: string; // base64
  cachedAt: number;
}

/** The eRačun XML cache (issue #1's Implementation Decisions → State; issue #9): bytes cached
 * at download time, keyed by Document `id`, pruned after 24 months. Not an optimisation — trap
 * 1 means the extension can never read the Archive back, so this cache is the only way the
 * Bundle (a later issue) can ever get an already-filed Document's XML bytes.
 *
 * One storage item per Document id, not one item holding every entry — this cache runs to the
 * "low hundreds of MB" over 24 months (docs/portal-api.md), and a single-blob item would mean
 * every Document filed later in the cache's life re-serialises everyone else's bytes just to
 * add its own. `unlimitedStorage` (wxt.config.ts) already lifts the quota; this is about the
 * cost of a single write, not the cache's total size. */
const ERACUN_CACHE_KEY_PREFIX = 'eracun-cache:';

function eracunCacheItem(id: number) {
  return storage.defineItem<CachedEracun>(`local:${ERACUN_CACHE_KEY_PREFIX}${id}`);
}

export const ERACUN_CACHE_RETENTION_MONTHS = 24;

/** Caches a Document's eRačun XML bytes, exactly as unpacked from its Export — never
 * re-serialised (trap 9), since this is the only surviving copy once the Archive write happens. */
export async function cacheEracun(id: number, bytes: Uint8Array, cachedAt: number): Promise<void> {
  await eracunCacheItem(id).setValue({ bytes: toBase64(bytes), cachedAt });
}

export async function getCachedEracun(id: number): Promise<Uint8Array | undefined> {
  const entry = await eracunCacheItem(id).getValue();
  return entry === null ? undefined : fromBase64(entry.bytes);
}

function monthsBefore(epochMillis: number, months: number): number {
  const date = new Date(epochMillis);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.getTime();
}

/** Drops every cache entry older than 24 months, run once per Run. This is retention
 * housekeeping, not a legal Filing date (ADR-0006) — plain wall-clock arithmetic is enough,
 * unlike trap 8's Zagreb-midnight requirement for what folder a Document lands in.
 *
 * Reads the whole local storage area once via `storage.snapshot` to find the cache's keys —
 * there is no per-item alternative, since the items are defined dynamically by id and nothing
 * else in local storage enumerates them — then removes only the stale ones by key. */
export async function pruneEracunCache(now: number): Promise<void> {
  const cutoff = monthsBefore(now, ERACUN_CACHE_RETENTION_MONTHS);
  const all = await storage.snapshot('local');

  const staleKeys: `local:${string}`[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(ERACUN_CACHE_KEY_PREFIX)) continue;
    const entry = value as CachedEracun;
    if (entry.cachedAt < cutoff) {
      staleKeys.push(`local:${key}`);
    }
  }

  if (staleKeys.length > 0) {
    await storage.removeItems(staleKeys);
  }
}
