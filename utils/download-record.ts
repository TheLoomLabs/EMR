// ADR-0013: before fetching an Export, a Run asks the browser what this extension has already
// written to disk, and skips a Document only when that record can *prove* it — never a guess.
// This is not reading the Archive back (trap 1 stands): `chrome.downloads.search` reports
// metadata the browser already tracked, and no byte of an Archive file is ever read.

/** One `chrome.downloads.search` result, narrowed to exactly what ADR-0013's proof needs: the
 * absolute path the browser wrote to, whether the write reached `state: "complete"`, and
 * whether the file still `exists`. Filtering to this extension's own downloads (`byExtensionId`)
 * is the real port's job, not this shape's — a fake never has to fabricate that field. */
export interface DownloadRecordEntry {
  /** The absolute, platform-specific path `DownloadItem.filename` reported — not the relative
   * `archivePath` this extension requested, which `chrome.downloads` resolves against its own
   * download directory before reporting it back. */
  filename: string;
  complete: boolean;
  exists: boolean;
}

function pathEndsWith(full: readonly string[], suffix: readonly string[]): boolean {
  if (suffix.length > full.length) return false;
  const offset = full.length - suffix.length;
  return suffix.every((segment, i) => segment === full[offset + i]);
}

/** Splits a browser-reported absolute path on both `/` and `\` — Chrome reports a
 * platform-native full path, and a relative `filename` given with forward slashes (as every
 * Archive path is) becomes backslash-joined directories on Windows. Comparing by segment,
 * never by raw string equality, is what makes matching correct on every platform. */
function pathSegments(filename: string): string[] {
  return filename.split(/[/\\]/).filter((segment) => segment.length > 0);
}

/** The browser's download record, queried once per Run and indexed here — never re-queried per
 * Document (ADR-0013). Indexed by filename (the basename), since two Documents never share one:
 * the eRačun/visualisation stems are unique per Document and every Prilog filename is prefixed
 * by its own Document's stem. Only entries that are both `complete` and still `exists` are ever
 * indexed — a partial or vanished download must read back as absent, never present. */
export class DownloadRecord {
  private readonly byBasename = new Map<string, string[][]>();

  constructor(entries: readonly DownloadRecordEntry[]) {
    for (const entry of entries) {
      if (!entry.complete || !entry.exists) continue;
      const segments = pathSegments(entry.filename);
      if (segments.length === 0) continue;
      const basename = segments[segments.length - 1];
      const list = this.byBasename.get(basename);
      if (list) {
        list.push(segments);
      } else {
        this.byBasename.set(basename, [segments]);
      }
    }
  }

  /** True when a completed, still-existing download's path ends with exactly this directory and
   * filename — the exact proof ADR-0013 requires. A missing, cleared or partial record yields
   * `false`, never a false `true`: that would need a completed, still-existing file at the exact
   * expected path. */
  has(directory: readonly string[], filename: string): boolean {
    const candidates = this.byBasename.get(filename);
    if (!candidates) return false;
    return candidates.some((segments) => pathEndsWith(segments, [...directory, filename]));
  }

  /** How many completed, still-existing downloads in `directory` have a filename starting with
   * `prefix` — how a Document's Prilog count is checked without ever guessing a Prilog's own
   * filename (ADR-0013): only the count is knowable ahead of opening the Export, so only the
   * count is compared. */
  countWithPrefix(directory: readonly string[], prefix: string): number {
    let count = 0;
    for (const [basename, candidatesList] of this.byBasename) {
      if (!basename.startsWith(prefix)) continue;
      for (const segments of candidatesList) {
        if (pathEndsWith(segments.slice(0, -1), directory)) count += 1;
      }
    }
    return count;
  }
}

/** The `downloadRecord` port a Run sees: load the browser's download record once. The real
 * implementation (`DownloadsRecordPort`) queries `chrome.downloads.search`; a fake in
 * tests returns canned entries. */
export interface DownloadRecordPort {
  load(): Promise<DownloadRecord>;
}

/** The port's real implementation, named `Downloads…Port` to match `utils/archive.ts`'s
 * `DownloadsArchivePort` — both wrap `chrome.downloads`, one `.download`, this one `.search`.
 * Queries every download `chrome.downloads.search` will show this extension, filtered to the
 * ones this extension itself wrote (`byExtensionId`) — the browser's own record of "what this
 * extension has already written", per ADR-0013, not every download on the machine. */
export class DownloadsRecordPort implements DownloadRecordPort {
  async load(): Promise<DownloadRecord> {
    const items = await browser.downloads.search({});
    const entries: DownloadRecordEntry[] = items
      .filter((item) => item.byExtensionId === browser.runtime.id)
      .map((item) => ({
        filename: item.filename,
        complete: item.state === 'complete',
        exists: item.exists,
      }));
    return new DownloadRecord(entries);
  }
}
