// Parsing the Settings Accountant field (issue #30; CONTEXT.md "Accountant"): the Accountant is
// one party reachable at several addresses, typed into a single comma-separated field. Pure: no
// network, no browser, no fakes.
//
// Validation is deliberately shallow — enough to catch `ana@` with the domain missing, not an
// adjudication of RFC 5322. The mail client is the real authority.

export class AccountantAddressError extends Error {
  constructor(address: string) {
    super(`"${address}" is not an email address.`);
    this.name = 'AccountantAddressError';
  }
}

const SHALLOW_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Splits the Accountant field into its addresses: comma-separated only — a semicolon is not a
 * separator — with surrounding whitespace trimmed and empty entries (a trailing or doubled
 * comma) discarded. Throws, naming the offending entry, on anything that is not shallowly an
 * email address; nothing downstream ever has to interpret what a user typed, since callers only
 * see this function's return value once it has not thrown. */
export function parseAccountantAddresses(raw: string): string[] {
  const addresses = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const address of addresses) {
    if (!SHALLOW_EMAIL_PATTERN.test(address)) {
      throw new AccountantAddressError(address);
    }
  }

  return addresses;
}
