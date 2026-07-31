import { defineConfig } from 'wxt';
import { PORTAL_ORIGIN } from './utils/portal-tab';

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
    // its own try/catch ever started. downloads: the `archive` port's real implementation
    // (ADR-0001, issue #8) writes via chrome.downloads.download rather than any file-system
    // API. downloads.open: the Bundle's `.eml` writer (issue #12, utils/eml-writer.ts) opens
    // the file it just wrote so the mail client presents it ready to go (ADR-0003) — a separate
    // permission from `downloads` itself.
    permissions: ['storage', 'unlimitedStorage', 'downloads', 'downloads.open'],
    // host_permissions, not activeTab (ADR-0010, issue #21): from EMR's own detached window,
    // `tabs.query({ active: true, currentWindow: true })` returns EMR's own tab, never the
    // Portal's, so the Portal tab is instead found by matching this origin
    // (entrypoints/window/main.ts, utils/portal-tab.ts) — which activeTab cannot grant.
    host_permissions: [`${PORTAL_ORIGIN}/*`],
    // No `default_popup` (ADR-0010, issue #21) — the entrypoints/window folder is an unlisted
    // page WXT does not wire into `action` on its own, so `action` itself has to be declared
    // here or the manifest carries no toolbar icon at all. entrypoints/background.ts's
    // `action.onClicked` opens or focuses the window instead.
    action: { default_title: 'EMR' },
  },
});
