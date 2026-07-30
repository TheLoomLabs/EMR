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
