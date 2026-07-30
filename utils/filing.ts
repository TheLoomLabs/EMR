// Filing rules — where a Document lands and what its files are called (issue #4).
// Pure: no network, no browser, no fakes. See CONTEXT.md and docs/adr/0006–0009.

import { markedTypeForCode } from './document-types';

const FILING_TIME_ZONE = 'Europe/Zagreb';

const zagrebFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: FILING_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export interface ZagrebDate {
  year: number;
  month: number; // 1-12
  day: number;
}

/** Year, month and day of an epoch-millis instant, read in Europe/Zagreb — never UTC, never the
 * host's zone (trap 8). The Portal's dates are epoch millis at Zagreb midnight, so a UTC read is
 * off by one at every month boundary. */
export function zagrebDate(epochMillis: number): ZagrebDate {
  const parts = zagrebFormatter.formatToParts(new Date(epochMillis));
  const get = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** The inverse of `zagrebDate`: the epoch-millis instant of local midnight for a Zagreb calendar
 * date. Re-checks the UTC offset at the resolved instant in case a DST transition moved it right
 * at midnight. */
export function zagrebMidnightMillis(date: ZagrebDate): number {
  const guess = Date.UTC(date.year, date.month - 1, date.day);
  const offset = zagrebUtcOffsetMinutes(guess);
  const confirmedOffset = zagrebUtcOffsetMinutes(guess - offset * 60_000);
  return guess - confirmedOffset * 60_000;
}

function zagrebUtcOffsetMinutes(utcMillis: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: FILING_TIME_ZONE,
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date(utcMillis));
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+0';
  const match = /GMT([+-]\d+)/.exec(name);
  return match ? Number(match[1]) * 60 : 0;
}

/** Adds (or subtracts) whole calendar days to a Zagreb date. Pure calendar arithmetic pivoted on
 * UTC noon, so a timezone offset can never push the result onto the wrong day. */
export function shiftZagrebDate(date: ZagrebDate, deltaDays: number): ZagrebDate {
  const pivot = Date.UTC(date.year, date.month - 1, date.day, 12);
  const shifted = new Date(pivot + deltaDays * 86_400_000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function isoDate(date: ZagrebDate): string {
  return `${date.year}-${pad2(date.month)}-${pad2(date.day)}`;
}

const RESERVED_WINDOWS_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

// Path separators (trap 2) and the other characters Windows/macOS/Linux forbid in a path segment.
const ILLEGAL_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;

/** A path or filename segment, sanitised ourselves rather than left to the browser: path
 * separators are neutralised (trap 2) and trailing dots are stripped (trap 3). Identical on
 * every host platform and locale — it never consults the OS or `Intl` for casing. */
export function sanitizeSegment(segment: string): string {
  const withoutIllegalChars = segment.replace(ILLEGAL_CHARS, '-');
  const withoutTrailingDots = withoutIllegalChars.replace(/\.+$/, '');
  if (RESERVED_WINDOWS_NAMES.has(withoutTrailingDots.toLocaleUpperCase('en-US'))) {
    return `${withoutTrailingDots}_`;
  }
  return withoutTrailingDots;
}

export interface PartyNameCandidate {
  id: number;
  naziv: string;
}

/** A party's (Issuer's or Recipient's) Archive folder name: the `naziv` of its lowest-`id`
 * Document (ADR-0008). Chosen once per OIB and then fixed, so it is stable however the
 * candidates arrive — a re-derivation from full history always lands on the same name. */
export function resolvePartyName(candidates: readonly PartyNameCandidate[]): string {
  return candidates.reduce((lowest, candidate) => (candidate.id < lowest.id ? candidate : lowest)).naziv;
}

export interface FilingRow {
  brojDokumenta: string;
  datumIzdavanja: number;
  vrstaDokumenta: { code: number };
}

/** A Document's filename stem: its Filing date and its sanitised `broj dokumenta`, with the
 * Marked type appended when the Document is not an Ordinary invoice. The eRačun and the
 * visualisation share this stem. */
export function documentStem(row: FilingRow): string {
  const stem = `${isoDate(zagrebDate(row.datumIzdavanja))}_${sanitizeSegment(row.brojDokumenta)}`;
  const markedType = markedTypeForCode(row.vrstaDokumenta.code);
  return markedType ? `${stem}_${markedType}` : stem;
}

export function eracunFilename(stem: string): string {
  return `${stem}.xml`;
}

export function visualisationFilename(stem: string): string {
  return `${stem}.pdf`;
}

/** A Prilog keeps the name its Issuer gave it, sanitised, appended to the Document's stem — so
 * it still sits next to its Document in a directory listing. */
export function prilogFilename(stem: string, issuerGivenName: string): string {
  return `${stem}_${sanitizeSegment(issuerGivenName)}`;
}

export interface ArchiveLocation {
  archiveRoot: string;
  recipientName: string;
  issuerName: string;
  datumIzdavanja: number;
}

/** The Archive directory for a Document, as path segments:
 * `{Archive root} / {Recipient name} / {YYYY} / {MM} / {Issuer name}`.
 * Year and month come from the Filing date in Europe/Zagreb; `MM` is two digits so folders
 * sort. Every segment is sanitised — including the two party names, which come from Portal
 * `naziv` strings the extension does not otherwise control. */
export function archiveDirectory(location: ArchiveLocation): string[] {
  const filingDate = zagrebDate(location.datumIzdavanja);
  return [
    sanitizeSegment(location.archiveRoot),
    sanitizeSegment(location.recipientName),
    filingDate.year.toString(),
    pad2(filingDate.month),
    sanitizeSegment(location.issuerName),
  ];
}

export interface YearStraddleInput {
  datumIzdavanja: number;
  datumZaprimanja: number;
}

/** A Year straddle: the Filing date and the receipt date fall in different Zagreb years
 * (ADR-0006) — issued 28.12, received 06.01. Reported, never re-filed. */
export function isYearStraddle({ datumIzdavanja, datumZaprimanja }: YearStraddleInput): boolean {
  return zagrebDate(datumIzdavanja).year !== zagrebDate(datumZaprimanja).year;
}

export interface FilingPlan {
  directory: string[];
  stem: string;
  eracun: string;
  visualisation: string;
  yearStraddle: boolean;
}

/** Everything about where a Document lands and what its files are called, except its Prilozi —
 * those need each Prilog's own Issuer-given name, known only once the Export is unpacked; build
 * their filenames with `prilogFilename(plan.stem, name)`. */
export function planFiling(
  row: FilingRow & YearStraddleInput,
  location: Omit<ArchiveLocation, 'datumIzdavanja'>,
): FilingPlan {
  const stem = documentStem(row);
  return {
    directory: archiveDirectory({ ...location, datumIzdavanja: row.datumIzdavanja }),
    stem,
    eracun: eracunFilename(stem),
    visualisation: visualisationFilename(stem),
    yearStraddle: isYearStraddle(row),
  };
}
