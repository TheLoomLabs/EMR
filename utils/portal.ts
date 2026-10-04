// The `portal` port (issue #7) — everything about listing Documents that isn't the raw HTTP
// call itself: paging past page 1 (docs/portal-api.md, "Paging"), row
// validation (trap 6 and the five required fields), and widening/narrowing a bounded date
// window (trap 8, "kraj works — bounded windows are available"). All pure — no fetch, no DOM —
// so it is testable against a hand-written fake PortalPort rather than the real Portal.
//
// The real implementation is utils/portal-client.ts, which runs inside the Portal's own page
// per ADR-0005.

import { shiftZagrebDate, zagrebDate, zagrebMidnightMillis, type ZagrebDate } from './filing';

export class PortalListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortalListError';
  }
}

export interface DateRangeFilter {
  pocetak?: string; // ISO-8601 instant
  kraj?: string;
}

export interface FilterParams {
  datumIzdavanja?: DateRangeFilter;
  datumDospijeca?: DateRangeFilter;
  iznos?: { pocetak?: number; kraj?: number };
}

export interface SearchRequest {
  start: number; // zero-based page index, not a row offset
  length: number;
  filterParams: FilterParams;
}

/** The raw, unvalidated wire shape. Fetching this and nothing more is the port's whole job —
 * validating it is listDocuments's job, so a fake needs only return JSON shaped like this. */
export interface RawSearchResponse {
  recordsTotal: number;
  data: unknown[];
}

/** The seam ADR-0005 requires: everything that actually talks to the Portal sits behind this
 * one method. utils/portal-client.ts is the real implementation; tests use a fake instead. */
export interface PortalPort {
  searchInbound(request: SearchRequest): Promise<RawSearchResponse>;
}

/** A list row, validated just enough to file (docs/portal-api.md, "A row"). Fields beyond the
 * five checked by parseRow pass through unvalidated — no defaults are ever filled in. */
export interface DocumentRow {
  id: number;
  brojDokumenta: string;
  dobavljac: { oib: string; naziv: string; [key: string]: unknown };
  datumIzdavanja: number;
  vrstaDokumenta: { code: number; [key: string]: unknown };
  [key: string]: unknown;
}

function parseRow(raw: unknown): DocumentRow {
  if (typeof raw !== 'object' || raw === null) {
    throw new PortalListError(`row is not an object: ${JSON.stringify(raw)}`);
  }
  const row = raw as Record<string, unknown>;

  if (typeof row.id !== 'number') {
    throw new PortalListError('row is missing a numeric id — no default filled in');
  }
  if (typeof row.datumIzdavanja !== 'number') {
    throw new PortalListError(`row ${row.id} is missing a numeric datumIzdavanja`);
  }
  if (typeof row.brojDokumenta !== 'string') {
    throw new PortalListError(`row ${row.id} is missing a string brojDokumenta`);
  }
  const dobavljac = row.dobavljac as Record<string, unknown> | undefined;
  if (typeof dobavljac?.oib !== 'string') {
    throw new PortalListError(`row ${row.id} is missing dobavljac.oib`);
  }
  const vrstaDokumenta = row.vrstaDokumenta as Record<string, unknown> | undefined;
  if (typeof vrstaDokumenta?.code !== 'number') {
    throw new PortalListError(`row ${row.id} is missing vrstaDokumenta.code`);
  }

  return row as DocumentRow;
}

const DEFAULT_PAGE_SIZE = 50;

export interface ListDocumentsResult {
  recordsTotal: number;
  rows: DocumentRow[];
}

/** Walks every page of the filtered window rather than assuming one request suffices.
 *
 * `start` is a zero-based **page index**, not a row offset: page 2 at `length: 50` is
 * `start: 1` (docs/portal-api.md, "Paging"). Sending a row offset asks for page 51 and gets an
 * empty page back. Because the server computes the row offset itself as `start * length`, every
 * page before the last must come back full — a short one means the server capped `length`, and
 * the next page index would silently skip rows. That, and a page repeating a Document already
 * seen, both fail loudly (trap 6). */
export async function listDocuments(
  port: PortalPort,
  filterParams: FilterParams = {},
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<ListDocumentsResult> {
  const rows: DocumentRow[] = [];
  const seenIds = new Set<number>();
  let page = 0;
  let recordsTotal: number | undefined;

  for (;;) {
    const response = await port.searchInbound({ start: page, length: pageSize, filterParams });

    if (recordsTotal === undefined) {
      recordsTotal = response.recordsTotal;
    } else if (response.recordsTotal !== recordsTotal) {
      throw new PortalListError(
        `recordsTotal changed mid-page, from ${recordsTotal} to ${response.recordsTotal} — the filtered set moved under us`,
      );
    }

    if (response.data.length > pageSize) {
      throw new PortalListError(
        `page ${page} returned ${response.data.length} rows, more than the requested length ${pageSize} — a parse failure`,
      );
    }

    if (response.data.length === 0 && rows.length < recordsTotal) {
      throw new PortalListError(
        `page ${page} returned zero rows with ${rows.length} of recordsTotal ${recordsTotal} read — a parse failure, not an empty inbox (trap 6)`,
      );
    }

    for (const raw of response.data) {
      const row = parseRow(raw);
      if (seenIds.has(row.id)) {
        throw new PortalListError(
          `page ${page} repeated Document ${row.id} from an earlier page — the Portal is not paging the way we expect`,
        );
      }
      seenIds.add(row.id);
      rows.push(row);
    }

    if (rows.length >= recordsTotal) break;

    if (response.data.length < pageSize) {
      throw new PortalListError(
        `page ${page} returned ${response.data.length} rows, fewer than the requested length ${pageSize}, with only ${rows.length} of recordsTotal ${recordsTotal} read — the Portal may be capping length, which would make later pages skip rows`,
      );
    }

    page += 1;
  }

  return { recordsTotal, rows };
}

export interface ZagrebWindow {
  /** Inclusive. */
  from: ZagrebDate;
  /** Inclusive. */
  to: ZagrebDate;
}

/** Builds `filterParams` a day wider at each end than the window actually wants
 * (docs/portal-api.md, "kraj works — bounded windows are available"): whether the Portal's
 * bounds are inclusive is deliberately left unresolved, and querying wider is correct under
 * either reading. Narrow back to the exact window with `withinZagrebWindow`.
 *
 * `earliest`, when given, floors the widened start so it never precedes it — used by the
 * first-run backfill (issue #11, utils/backfill.ts) so the widening never asks for a date before
 * eRačun receipt began, even though `window.from` itself may already sit exactly on that
 * boundary. */
export function widenedFilterParams(window: ZagrebWindow, earliest?: ZagrebDate): FilterParams {
  const widenedFrom = shiftZagrebDate(window.from, -1);
  const from = earliest && compareZagrebDate(widenedFrom, earliest) < 0 ? earliest : widenedFrom;
  return {
    datumIzdavanja: {
      pocetak: new Date(zagrebMidnightMillis(from)).toISOString(),
      kraj: new Date(zagrebMidnightMillis(shiftZagrebDate(window.to, 1))).toISOString(),
    },
    datumDospijeca: {},
    iznos: {},
  };
}

/** Client-side narrowing back to the exact Zagreb window (trap 8): a row's `datumIzdavanja` is
 * epoch millis at Zagreb midnight, so the comparison is done on Zagreb calendar dates, never on
 * the raw millis or a UTC read of them. */
export function withinZagrebWindow(datumIzdavanja: number, window: ZagrebWindow): boolean {
  const date = zagrebDate(datumIzdavanja);
  return compareZagrebDate(date, window.from) >= 0 && compareZagrebDate(date, window.to) <= 0;
}

function compareZagrebDate(a: ZagrebDate, b: ZagrebDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/** A group of Documents sharing one Issuer OIB, for display (issue #23, replacing
 * summarizeRow). `oib` is the identity; `name` is one display label chosen for the group, never
 * a list of the several the Issuer's own software may have written (CONTEXT.md's Issuer rule;
 * docs/portal-api.md recorded seven OIBs arriving under eight `naziv` strings in this
 * Recipient's own data). */
export interface IssuerGroup {
  oib: string;
  name: string;
  documents: readonly DocumentRow[];
}

/** Groups Documents by Issuer OIB — never by `naziv`, which the same Issuer's own software can
 * write two different ways. The display name follows ADR-0008's rule for the Archive folder
 * name it mirrors: the `naziv` of the group's lowest-`id`, i.e. earliest, Document. Groups are
 * ordered the same way — ascending by their earliest Document's `id` — and each group's
 * Documents are ordered ascending by `id` too, so the result is deterministic regardless of the
 * order `rows` happened to arrive in. */
export function groupByIssuer(rows: readonly DocumentRow[]): IssuerGroup[] {
  const documentsByOib = new Map<string, DocumentRow[]>();
  for (const row of rows) {
    const oib = row.dobavljac.oib;
    const existing = documentsByOib.get(oib);
    if (existing) {
      existing.push(row);
    } else {
      documentsByOib.set(oib, [row]);
    }
  }

  const groups: IssuerGroup[] = [];
  for (const [oib, documents] of documentsByOib) {
    documents.sort((a, b) => a.id - b.id);
    groups.push({ oib, name: documents[0].dobavljac.naziv, documents });
  }
  groups.sort((a, b) => a.documents[0].id - b.documents[0].id);
  return groups;
}
