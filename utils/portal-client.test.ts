// Regression coverage for two Firefox verification findings (issue #13, 2026-07-30), both about
// the exact value of the `Accept` header:
//
// 1. A missing `Accept` header let the Portal's content negotiation serve `searchInbound` back
//    as XML instead of JSON on a real HTTP 200, surfacing as a raw SyntaxError from
//    `response.json()` instead of a diagnosable PortalListError.
// 2. Naively fixing (1) with a bare `Accept: application/json` broke `exportDocument` instead —
//    that endpoint has no JSON representation, so a strict `application/json` got rejected with
//    406 before the ZIP was ever built. The fix that reconciles both is axios's own default,
//    `application/json, text/plain, */*` — JSON preferred, `*/*` as the fallback that keeps
//    Export working.
//
// See docs/portal-api.md, "Accept was missing from this table — and then the fix broke Export".

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { observeAppToken, resetAppToken } from './apptoken';
import { PortalListError } from './portal';
import { HttpPortalPort } from './portal-client';

const ACCEPT_HEADER = 'application/json, text/plain, */*';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** What the Portal actually served in the field: a 200 whose body is a well-formed
 * <DatatableResponse> XML document, not the documented JSON shape. Not empty, not an HTTP
 * error — genuinely the wrong representation, because the request's Accept header was the bare
 * wildcard fetch default. */
function xmlDatatableResponse(): Response {
  return new Response('<DatatableResponse><data></data><recordsTotal>0</recordsTotal></DatatableResponse>', {
    status: 200,
    headers: { 'Content-Type': 'application/xml;charset=UTF-8' },
  });
}

beforeEach(() => {
  resetAppToken();
  observeAppToken('c29tZS10b2tlbi12YWx1ZQ==');
});

describe('HttpPortalPort.searchInbound', () => {
  it('sends the same Accept axios would, not a bare application/json', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ recordsTotal: 0, data: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await new HttpPortalPort().searchInbound({ start: 0, length: 50, filterParams: {} });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Accept).toBe(ACCEPT_HEADER);

    vi.unstubAllGlobals();
  });

  it('fails loudly, naming the Content-Type, when the Portal serves XML on a 200 instead of JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(xmlDatatableResponse()));

    await expect(new HttpPortalPort().searchInbound({ start: 0, length: 50, filterParams: {} })).rejects.toThrow(
      PortalListError,
    );
    await expect(new HttpPortalPort().searchInbound({ start: 0, length: 50, filterParams: {} })).rejects.toThrow(
      /application\/xml/,
    );

    vi.unstubAllGlobals();
  });
});

describe('HttpPortalPort.exportDocument', () => {
  it('sends the same Accept axios would, with the trailing */* Export needs to stay 406-free', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ArrayBuffer(4), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new HttpPortalPort().exportDocument(1);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Accept).toBe(ACCEPT_HEADER);

    vi.unstubAllGlobals();
  });
});
