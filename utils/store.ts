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
