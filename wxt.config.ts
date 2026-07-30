import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifestVersion: 3,
  manifest: {
    // storage: required for `wxt/storage` (utils/store.ts) to reach browser.storage.local at
    // all — @wxt-dev/storage throws "You must add the 'storage' permission to your manifest"
    // without it. unlimitedStorage lifts local storage's quota for the XML cache (HANDOFF,
    // "Cache") but does not itself grant API access; the two are independent permissions.
    // Found live on Firefox (issue #13): every `store` call — Settings, the Filed set, the
    // eRačun cache — was throwing, which is why Preuzmi's click handler failed silently before
    // its own try/catch ever started. activeTab: lets the popup (entrypoints/popup/main.ts)
    // find and message the active tab's content script (issue #7) without needing a host
    // permission for the Portal's origin. downloads: the `archive` port's real implementation
    // (ADR-0001, issue #8) writes via chrome.downloads.download rather than any file-system
    // API. downloads.open: the Bundle's `.eml` writer (issue #12, utils/eml-writer.ts) opens
    // the file it just wrote so the mail client presents it ready to go (ADR-0003) — a separate
    // permission from `downloads` itself.
    permissions: ['storage', 'unlimitedStorage', 'activeTab', 'downloads', 'downloads.open'],
  },
});
