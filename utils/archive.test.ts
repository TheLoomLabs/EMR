import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import type { Browser } from 'wxt/browser';
import { archivePath, ArchiveError, DownloadsArchivePort } from './archive';

beforeEach(() => {
  fakeBrowser.reset();
});

describe('archivePath', () => {
  it('joins directory segments and the filename with forward slashes', () => {
    expect(archivePath(['Arhiva', 'Recolo d.o.o.', '2026', '07', 'Primjer d.o.o.'], '2026-07-01_1-1-1.xml')).toBe(
      'Arhiva/Recolo d.o.o./2026/07/Primjer d.o.o./2026-07-01_1-1-1.xml',
    );
  });
});

/** Stubs `browser.downloads` so a test can drive `chrome.downloads.download`'s async
 * completion itself — `@webext-core/fake-browser` doesn't implement either API
 * (see its own "mock the function yourself" message). `fireChange` simulates the
 * `downloads.onChanged` event `DownloadsArchivePort.write` waits on. */
function stubDownloads(downloadId = 1) {
  const download = vi.fn().mockResolvedValue(downloadId);
  let listener: ((delta: Browser.downloads.DownloadDelta) => void) | undefined;
  const addListener = vi.fn((fn: (delta: Browser.downloads.DownloadDelta) => void) => {
    listener = fn;
  });
  const removeListener = vi.fn(() => {
    listener = undefined;
  });
  fakeBrowser.downloads.download = download;
  fakeBrowser.downloads.onChanged.addListener = addListener as never;
  fakeBrowser.downloads.onChanged.removeListener = removeListener as never;

  return {
    download,
    addListener,
    removeListener,
    /** Waits for `write`'s internal promise chain to register its `onChanged` listener, then
     * fires it — `download`'s resolution and the listener registration both happen across a
     * microtask boundary the test has to let run first. */
    async settle(delta: Browser.downloads.DownloadDelta) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      listener?.(delta);
    },
  };
}

describe('DownloadsArchivePort', () => {
  it('writes with conflictAction overwrite, so a re-run never produces a (1) copy (ADR-0004)', async () => {
    const downloads = stubDownloads();
    const port = new DownloadsArchivePort();

    const write = port.write('Arhiva/Primjer/2026/07/Recolo/document.xml', new TextEncoder().encode('<xml/>'));
    await downloads.settle({ id: 1, state: { current: 'complete' } });
    await write;

    expect(downloads.download).toHaveBeenCalledTimes(1);
    const [options] = downloads.download.mock.calls[0];
    expect(options.filename).toBe('Arhiva/Primjer/2026/07/Recolo/document.xml');
    expect(options.conflictAction).toBe('overwrite');
    expect(options.saveAs).toBe(false);
  });

  it('never asks the browser to download anything but the bytes it was given, as a blob: URL', async () => {
    const downloads = stubDownloads();
    const port = new DownloadsArchivePort();
    const bytes = new TextEncoder().encode('hello archive');

    const write = port.write('path/to/file.xml', bytes);
    await downloads.settle({ id: 1, state: { current: 'complete' } });
    await write;

    const [options] = downloads.download.mock.calls[0];
    expect(options.url).toMatch(/^blob:/);
  });

  it('revokes the blob: URL only once the download settles, never before', async () => {
    const downloads = stubDownloads();
    const port = new DownloadsArchivePort();
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL');

    const write = port.write('path/to/file.xml', new TextEncoder().encode('x'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revokeObjectURL).not.toHaveBeenCalled(); // download() resolved, not settled yet

    await downloads.settle({ id: 1, state: { current: 'complete' } });
    await write;
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('base64-encodes a large payload without blowing the call stack', async () => {
    const downloads = stubDownloads();
    const port = new DownloadsArchivePort();
    const bytes = new Uint8Array(500_000).fill(65); // 500 KB of 'A'

    const write = port.write('big.pdf', bytes);
    await downloads.settle({ id: 1, state: { current: 'complete' } });
    await expect(write).resolves.toBeUndefined();
    expect(downloads.download).toHaveBeenCalledTimes(1);
  });

  it('does not resolve merely because the download started — only once it reaches state "complete"', async () => {
    const downloads = stubDownloads();
    const port = new DownloadsArchivePort();

    const write = port.write('slow.pdf', new TextEncoder().encode('x'));
    let settled = false;
    write.then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false); // download() resolved, but no onChanged("complete") yet

    await downloads.settle({ id: 1, state: { current: 'complete' } });
    await write;
    expect(settled).toBe(true);
  });

  it('rejects when the download is interrupted, so the Document is never marked Filed (ADR-0004)', async () => {
    const downloads = stubDownloads();
    const port = new DownloadsArchivePort();

    const write = port.write('failing.pdf', new TextEncoder().encode('x'));
    const assertion = expect(write).rejects.toThrow(ArchiveError);
    await downloads.settle({ id: 1, state: { current: 'interrupted' }, error: { current: 'FILE_FAILED' } });
    await assertion;
  });

  it('removes its onChanged listener once the download settles, leaking neither listeners nor state', async () => {
    const downloads = stubDownloads();
    const port = new DownloadsArchivePort();

    const write = port.write('document.xml', new TextEncoder().encode('x'));
    await downloads.settle({ id: 1, state: { current: 'complete' } });
    await write;

    expect(downloads.removeListener).toHaveBeenCalledTimes(1);
  });
});
