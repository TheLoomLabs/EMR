import { APPTOKEN_EVENT, observeAppToken } from '@/utils/apptoken';

export default defineContentScript({
  // Was 'mikroracun.porezna-uprava.hr' — missing the 'e' the real Portal hostname has, so
  // this content script never ran on the actual site. Confirmed against a live DNS lookup
  // while investigating issue #6.
  matches: ['*://mikroeracun.porezna-uprava.hr/*'],
  main(ctx) {
    ctx.addEventListener(window, APPTOKEN_EVENT, (event) => {
      observeAppToken((event as CustomEvent<string>).detail);
    });
  },
});
