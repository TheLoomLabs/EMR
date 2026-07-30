// The `portal` port's real implementation (issue #7). Runs inside the Portal's own page per
// ADR-0005, so it inherits the authenticated session (the browser attaches cookies to a
// same-origin fetch on its own) and can read the live apptoken (utils/apptoken.ts).
//
// Sends only what docs/portal-api.md's Request headers table lists, plus `Accept`. traceparent,
// tracestate, X-INSTANA-* and the /monitoring/eum/ telemetry call are Instana front-end noise and
// are never sent from here.
//
// `Accept` matters, and its exact value matters — found live on Firefox, in two parts (issue
// #13). First: the backend content-negotiates `searchInbound`, and without an explicit
// preference `fetch`'s bare `*/*` gets the same Document rows back as an XML
// `<DatatableResponse>` instead of JSON, so `response.json()` fails with a raw SyntaxError.
// Second: naively fixing that with a bare `Accept: application/json` broke `exportDocument`
// instead — that endpoint apparently has no JSON representation registered at all, so a strict
// `application/json` gets rejected outright with 406 `HttpMediaTypeNotAcceptableException`
// before the ZIP is ever built. `ACCEPT_HEADER` below is what actually reconciles both: it's
// axios's own default (what the real SPA sends on every request, GET or POST, list or export),
// `application/json, text/plain, */*` — JSON preferred, but the trailing `*/*` is what lets
// Export still succeed. This is why the original capture never listed `Accept` as a header the
// SPA sets deliberately: it isn't one, it's axios's default, applied uniformly.

import { getAppToken } from './apptoken';
import { PortalListError, type PortalPort, type RawSearchResponse, type SearchRequest } from './portal';

const LIST_ENDPOINT = '/api/dokumenti/pretraga/ulazni';
const EXPORT_ENDPOINT = '/api/dokument/akcija/izvezi';
const ACCEPT_HEADER = 'application/json, text/plain, */*';

/** Raised when the Export request itself fails at the HTTP level — a transport failure, not a
 * body that fails validation once fetched (that is ExportValidationError, utils/export.ts). */
export class PortalExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortalExportError';
  }
}

export class HttpPortalPort implements PortalPort {
  async searchInbound(request: SearchRequest): Promise<RawSearchResponse> {
    const response = await fetch(LIST_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: ACCEPT_HEADER,
        'X-Requested-With': 'JavaScript',
        apptoken: getAppToken(),
      },
      body: JSON.stringify({
        draw: 1, // The SPA increments this; the server appears not to return it (docs/portal-api.md).
        start: request.start,
        length: request.length,
        filterParams: request.filterParams,
      }),
    });

    if (!response.ok) {
      throw new PortalListError(`list request failed: HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      const contentType = response.headers.get('content-type') ?? 'unknown';
      throw new PortalListError(
        `list response was not JSON (Content-Type: ${contentType}) — the Portal may be content-negotiating away from JSON: ${(error as Error).message}`,
      );
    }
    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as Record<string, unknown>).recordsTotal !== 'number' ||
      !Array.isArray((body as Record<string, unknown>).data)
    ) {
      throw new PortalListError('list response is missing recordsTotal or data — the Portal may have changed');
    }

    const { recordsTotal, data } = body as { recordsTotal: number; data: unknown[] };
    return { recordsTotal, data };
  }

  /** The Export (issue #4's Implementation Decisions → "The Export"): a JSON array of exactly
   * one id, even though the endpoint is batch-capable — batching would break the per-Document
   * atomicity that makes a Run resumable. The response has no Content-Type, so it is read as an
   * ArrayBuffer unconditionally and left for utils/export.ts to validate and unpack.
   *
   * `Accept` must carry the trailing wildcard (ACCEPT_HEADER above) — a bare `application/json`
   * here gets rejected with 406 before the ZIP is ever built, since this endpoint has no JSON
   * representation to negotiate to (found live on Firefox, issue #13). */
  async exportDocument(id: number): Promise<ArrayBuffer> {
    const response = await fetch(EXPORT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: ACCEPT_HEADER,
        'X-Requested-With': 'JavaScript',
        apptoken: getAppToken(),
      },
      body: JSON.stringify([id]),
    });

    if (!response.ok) {
      throw new PortalExportError(`export request for id ${id} failed: HTTP ${response.status}`);
    }

    return response.arrayBuffer();
  }
}
