// Writes a Bundle's `.eml` and opens it (ADR-0003: "writes... into the download directory and
// opens it"). Deliberately separate from utils/archive.ts's ArchivePort: an Archive write is
// never opened — trap 1 means the extension can never read a file it has written back, and
// nothing about filing depends on the file being opened — but the whole point of a Bundle is to
// hand the finished draft straight to the user's own mail client, so this port's job includes
// the open step ArchivePort's never does.

export class EmlWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmlWriteError';
  }
}

export interface EmlWriterPort {
  /** Resolves once the file is on disk, with the id needed to {@link open} it. Deliberately does
   * not open the file itself — see {@link open}'s doc comment for why the two must stay apart. */
  write(filename: string, bytes: Uint8Array): Promise<number>;
  /** Wraps `browser.downloads.open` with nothing awaited first, so the call reaches the browser
   * while it's still willing to run it — see the doc comment above the real implementation. */
  open(downloadId: number): Promise<void>;
}

/** `browser.downloads.download` resolves once Chrome has *started* the download, not once it
 * has finished — opening the file before it's actually on disk would fail, so this waits for
 * the matching `state.current` to settle, exactly like utils/archive.ts's own helper. */
function waitForDownloadToSettle(downloadId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    function onChanged(delta: Browser.downloads.DownloadDelta): void {
      if (delta.id !== downloadId || delta.state?.current === undefined) return;
      if (delta.state.current === 'complete') {
        browser.downloads.onChanged.removeListener(onChanged);
        resolve();
      } else if (delta.state.current === 'interrupted') {
        browser.downloads.onChanged.removeListener(onChanged);
        reject(
          new EmlWriteError(
            `download ${downloadId} at "${delta.filename?.current ?? '?'}" was interrupted: ${delta.error?.current ?? 'unknown reason'}`,
          ),
        );
      }
    }
    browser.downloads.onChanged.addListener(onChanged);
  });
}

/** The `eml-writer` port's real implementation. Writes via `chrome.downloads.download` with a
 * `blob:` URL, exactly like `DownloadsArchivePort` and for the same reason — Firefox rejects
 * `downloads.download` calls with a `data:` URL outright (Firefox bug 1622986; see
 * utils/archive.ts). `conflictAction: 'overwrite'` matches ADR-0004's spirit: recomposing the
 * same month overwrites its previous draft rather than accumulating `(1)`, `(2)` copies —
 * consistent with the Bundle being stateless and safe to repeat (CONTEXT.md, "Bundle"). */
export class DownloadsEmlWriterPort implements EmlWriterPort {
  async write(filename: string, bytes: Uint8Array): Promise<number> {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'message/rfc822' }));
    try {
      const downloadId = await browser.downloads.download({
        url,
        filename,
        conflictAction: 'overwrite',
        saveAs: false,
      });
      await waitForDownloadToSettle(downloadId);
      return downloadId;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** `downloads.open` throws "may only be called from a user input handler" the moment anything
   * is awaited first — Firefox drops that privilege as soon as control returns to the event
   * loop, and both the download and the wait for it to settle in {@link write} do exactly that.
   * So this must be invoked as the first thing in a fresh click handler, with the id from an
   * already-finished {@link write} — never chained onto it directly (issue: "downloads.open may
   * only be called from a user input handler"). */
  async open(downloadId: number): Promise<void> {
    await browser.downloads.open(downloadId);
  }
}
