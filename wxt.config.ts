import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifestVersion: 3,
  manifest: {
    // unlimitedStorage: the XML cache (HANDOFF, "Cache"). activeTab: lets the popup
    // (entrypoints/popup/main.ts) find and message the active tab's content script
    // (issue #7) without needing a host permission for the Portal's origin. downloads: the
    // `archive` port's real implementation (ADR-0001, issue #8) writes via
    // chrome.downloads.download rather than any file-system API. downloads.open: the Bundle's
    // `.eml` writer (issue #12, utils/eml-writer.ts) opens the file it just wrote so the mail
    // client presents it ready to go (ADR-0003) — a separate permission from `downloads` itself.
    permissions: ['unlimitedStorage', 'activeTab', 'downloads', 'downloads.open'],
  },
});
