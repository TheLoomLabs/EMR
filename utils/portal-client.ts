// The `portal` port's real implementation (issue #7). Runs inside the Portal's own page per
// ADR-0005, so it inherits the authenticated session (the browser attaches cookies to a
// same-origin fetch on its own) and can read the live apptoken (utils/apptoken.ts).
//
// Sends only what docs/portal-api.md's Request headers table lists. traceparent, tracestate,
// X-INSTANA-* and the /monitoring/eum/ telemetry call are Instana front-end noise and are never
// sent from here.

import { getAppToken } from './apptoken';
import { PortalListError, type PortalPort, type RawSearchResponse, type SearchRequest } from './portal';

const LIST_ENDPOINT = '/api/dokumenti/pretraga/ulazni';

export class HttpPortalPort implements PortalPort {
  async searchInbound(request: SearchRequest): Promise<RawSearchResponse> {
    const response = await fetch(LIST_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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

    const body: unknown = await response.json();
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
}
