import { APPTOKEN_EVENT } from '@/utils/apptoken';

// Runs in the Portal page's own MAIN world (issue #6, docs/portal-api.md "The apptoken
// problem") — not the isolated world content.ts runs in, which has no access to the SPA's
// in-memory Redux store. Watches every outgoing XMLHttpRequest for the `apptoken` header
// the Portal's own axios instance attaches and rebroadcasts the value as a DOM
// CustomEvent, which does cross from the MAIN world into the isolated one.
//
// Deliberately does not read the token out of the SPA's Redux store by name: that name is
// a minified identifier that changes on every Portal rebuild, where the `apptoken` header
// name is not — it is a value both sides chose deliberately and is stable across redeploys.
export default defineContentScript({
  matches: ['*://mikroeracun.porezna-uprava.hr/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string) {
      if (name.toLowerCase() === 'apptoken' && value !== '') {
        window.dispatchEvent(new CustomEvent(APPTOKEN_EVENT, { detail: value }));
      }
      return originalSetRequestHeader.call(this, name, value);
    };
  },
});
