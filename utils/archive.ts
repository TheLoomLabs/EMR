// The `archive` port (issue #1's Implementation Decisions → The seam). Write-only, because an
// extension can never read back a file it has written (trap 1, ADR-0001) — no verification step
// may assume otherwise, so no read operation is exposed here at all.

/** A path relative to the Archive root, `/`-joined — directory segments (already sanitised by
 * utils/filing.ts) plus the filename. This is exactly what `chrome.downloads.download`'s
 * `filename` option wants: forward slashes, no leading slash. */
export function archivePath(directory: readonly string[], filename: string): string {
  return [...directory, filename].join('/');
}

/** Raised when `chrome.downloads.download` itself reports the write failed — disk full,
 * permission denied, or any other interruption `downloads.onChanged` surfaces. */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export interface ArchivePort {
  /** Writes `bytes` at `path`, overwriting whatever was there (ADR-0004) — never appending a
   * `(1)` copy. Idempotent: writing the same bytes at the same path twice leaves one file. */
  write(path: string, bytes: Uint8Array): Promise<void>;
}

/** Base64-encodes in fixed-size chunks rather than `btoa(String.fromCharCode(...bytes))` in one
 * call, which blows the call stack on anything but a small file. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
  }
  return btoa(binary);
}

/** `browser.downloads.download` resolves once Chrome has *started* the download, not once it
 * has finished — a later interruption (disk full, permission denied) surfaces only through
 * `downloads.onChanged`. Run relies on `write` resolving only once bytes are actually on disk
 * (a Document must not be marked Filed after a write that merely started), so this waits for
 * the matching `state.current` to settle. */
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
          new ArchiveError(
            `download ${downloadId} at "${delta.filename?.current ?? '?'}" was interrupted: ${delta.error?.current ?? 'unknown reason'}`,
          ),
        );
      }
    }
    browser.downloads.onChanged.addListener(onChanged);
  });
}

/** The `archive` port's real implementation (ADR-0001). Writes go through
 * `chrome.downloads.download` with a `data:` URL rather than a `blob:` one, because a `blob:`
 * URL needs `URL.createObjectURL`, which is unavailable in some extension-page contexts a
 * `data:` URL works in unconditionally. The browser never downloads anything of its own accord
 * here — every byte written is one this extension unpacked itself. */
export class DownloadsArchivePort implements ArchivePort {
  async write(path: string, bytes: Uint8Array): Promise<void> {
    const downloadId = await browser.downloads.download({
      url: `data:application/octet-stream;base64,${toBase64(bytes)}`,
      filename: path,
      conflictAction: 'overwrite',
      saveAs: false,
    });
    await waitForDownloadToSettle(downloadId);
  }
}
