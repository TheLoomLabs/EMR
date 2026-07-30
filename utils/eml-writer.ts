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
  writeAndOpen(filename: string, bytes: Uint8Array): Promise<void>;
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
  async writeAndOpen(filename: string, bytes: Uint8Array): Promise<void> {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'message/rfc822' }));
    try {
      const downloadId = await browser.downloads.download({
        url,
        filename,
        conflictAction: 'overwrite',
        saveAs: false,
      });
      await waitForDownloadToSettle(downloadId);
      await browser.downloads.open(downloadId);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
