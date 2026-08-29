import { APPTOKEN_EVENT, observeAppToken } from '@/utils/apptoken';
import {
  encodeExportBytes,
  isExportDocumentMessage,
  isListDocumentsMessage,
  type ExportDocumentResponse,
  type ListDocumentsResponse,
} from '@/utils/messages';
import { listDocuments } from '@/utils/portal';
import { HttpPortalPort } from '@/utils/portal-client';

export default defineContentScript({
  // Was 'mikroracun.porezna-uprava.hr' — missing the 'e' the real Portal hostname has, so
  // this content script never ran on the actual site. Confirmed against a live DNS lookup
  // while investigating issue #6.
  matches: ['*://mikroeracun.porezna-uprava.hr/*'],
  main(ctx) {
    ctx.addEventListener(window, APPTOKEN_EVENT, (event) => {
      observeAppToken((event as CustomEvent<string>).detail);
    });

    browser.runtime.onMessage.addListener(
      (message: unknown): Promise<ListDocumentsResponse | ExportDocumentResponse> | undefined => {
        if (isListDocumentsMessage(message)) {
          return listDocuments(new HttpPortalPort(), message.filterParams)
            .then(({ recordsTotal, rows }): ListDocumentsResponse => ({ ok: true, recordsTotal, rows }))
            .catch((error): ListDocumentsResponse => ({ ok: false, error: (error as Error).message }));
        }

        if (isExportDocumentMessage(message)) {
          return new HttpPortalPort()
            .exportDocument(message.id)
            // Base64, not the ArrayBuffer itself: Chrome JSON-serialises extension messages and
            // an ArrayBuffer JSON-serialises to `{}` (utils/messages.ts).
            .then((bytes): ExportDocumentResponse => ({ ok: true, bytes: encodeExportBytes(bytes) }))
            .catch((error): ExportDocumentResponse => ({ ok: false, error: (error as Error).message }));
        }

        return undefined;
      },
    );
  },
});
