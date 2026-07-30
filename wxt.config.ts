import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifestVersion: 3,
  manifest: {
    // unlimitedStorage: the XML cache (HANDOFF, "Cache"). activeTab: lets the popup
    // (entrypoints/popup/main.ts) find and message the active tab's content script
    // (issue #7) without needing a host permission for the Portal's origin. downloads: the
    // `archive` port's real implementation (ADR-0001, issue #8) writes via
    // chrome.downloads.download rather than any file-system API.
    permissions: ['unlimitedStorage', 'activeTab', 'downloads'],
  },
});
