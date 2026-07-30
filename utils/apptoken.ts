// Reading the live apptoken (issue #6). See docs/portal-api.md, "The apptoken problem".
//
// The token lives only in the Portal SPA's in-memory Redux store — never in
// sessionStorage, localStorage, a cookie or a response body — so it cannot be reached by
// name from an isolated-world content script (ADR-0005 notwithstanding: isolated worlds
// share the DOM with the page, not its JS heap). entrypoints/apptoken.content.ts runs in
// the MAIN world instead and watches every outgoing XMLHttpRequest for the header the
// Portal's own axios instance attaches, then rebroadcasts it as a DOM CustomEvent, which
// does cross the world boundary. This module is the isolated side: it remembers the most
// recently observed value and fails loudly when asked for one that hasn't arrived yet.

/** The name of the DOM CustomEvent apptoken.content.ts dispatches on `window`, carrying the
 * observed token as `detail`. Shared so the MAIN-world broadcaster and the isolated-world
 * listener agree on it without either hardcoding a copy of the other's string. */
export const APPTOKEN_EVENT = 'emr:apptoken-observed';

/** Thrown by `getAppToken` when no value has been observed yet — a Run must fail loudly
 * rather than send a Portal request with no `apptoken` header at all. */
export class AppTokenUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppTokenUnavailableError';
  }
}

let observed: string | undefined;

/** Records a freshly observed token value. Ignores an empty string — that is not a value
 * the Portal's own axios interceptor would ever attach, so it signals a bug in the
 * observer rather than a real token. */
export function observeAppToken(value: string): void {
  if (value === '') return;
  observed = value;
}

/** Returns the most recently observed token, or throws `AppTokenUnavailableError` if none
 * has been seen yet. Never returns a hardcoded or synthesised value — see docs/portal-api.md. */
export function getAppToken(): string {
  if (observed === undefined) {
    throw new AppTokenUnavailableError(
      'apptoken has not been observed on this page yet — open Ulazni dokumenti and let it finish loading before starting a Run',
    );
  }
  return observed;
}

/** Test-only: clears the observed value so tests don't leak state into one another. */
export function resetAppToken(): void {
  observed = undefined;
}
