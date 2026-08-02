import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import type { Browser } from 'wxt/browser';
import { DownloadsEmlWriterPort, EmlWriteError } from './eml-writer';

beforeEach(() => {
  fakeBrowser.reset();
});

/** Stubs `browser.downloads` exactly like utils/archive.test.ts's own helper — `download` and
 * `open` are driven explicitly, `onChanged` is fired by the test. */
function stubDownloads(downloadId = 1) {
  const download = vi.fn().mockResolvedValue(downloadId);
  const open = vi.fn().mockResolvedValue(undefined);
  let listener: ((delta: Browser.downloads.DownloadDelta) => void) | undefined;
  const addListener = vi.fn((fn: (delta: Browser.downloads.DownloadDelta) => void) => {
    listener = fn;
  });
  const removeListener = vi.fn(() => {
    listener = undefined;
  });
  fakeBrowser.downloads.download = download;
  fakeBrowser.downloads.open = open;
  fakeBrowser.downloads.onChanged.addListener = addListener as never;
  fakeBrowser.downloads.onChanged.removeListener = removeListener as never;

  return {
    download,
    open,
    async settle(delta: Browser.downloads.DownloadDelta) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      listener?.(delta);
    },
  };
}

describe('DownloadsEmlWriterPort', () => {
  it('writes the given bytes as a message/rfc822 blob: URL at the given filename', async () => {
    const downloads = stubDownloads();
    const port = new DownloadsEmlWriterPort();
    const bytes = new TextEncoder().encode('MIME-Version: 1.0\r\n');

    const write = port.write('eRačuni 07-2026.eml', bytes);
    await downloads.settle({ id: 1, state: { current: 'complete' } });
    await write;

    expect(downloads.download).toHaveBeenCalledTimes(1);
    const [options] = downloads.download.mock.calls[0];
    expect(options.filename).toBe('eRačuni 07-2026.eml');
    expect(options.url).toMatch(/^blob:/);
    expect(options.conflictAction).toBe('overwrite');
    expect(options.saveAs).toBe(false);
  });

  it('revokes the blob: URL once the download settles', async () => {
    const downloads = stubDownloads();
    const port = new DownloadsEmlWriterPort();
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL');

    const write = port.write('x.eml', new TextEncoder().encode('x'));
    await downloads.settle({ id: 1, state: { current: 'complete' } });
    await write;

    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('resolves the download id once the download completes, but never opens it itself', async () => {
    const downloads = stubDownloads(7);
    const port = new DownloadsEmlWriterPort();

    const write = port.write('x.eml', new TextEncoder().encode('x'));
    await downloads.settle({ id: 7, state: { current: 'complete' } });

    await expect(write).resolves.toBe(7);
    expect(downloads.open).not.toHaveBeenCalled();
  });

  it('rejects when the download is interrupted', async () => {
    const downloads = stubDownloads();
    const port = new DownloadsEmlWriterPort();

    const write = port.write('failing.eml', new TextEncoder().encode('x'));
    const assertion = expect(write).rejects.toThrow(EmlWriteError);
    await downloads.settle({ id: 1, state: { current: 'interrupted' }, error: { current: 'FILE_FAILED' } });
    await assertion;

    expect(downloads.open).not.toHaveBeenCalled();
  });

  it('base64-encodes a large payload without blowing the call stack', async () => {
    const downloads = stubDownloads();
    const port = new DownloadsEmlWriterPort();
    const bytes = new Uint8Array(500_000).fill(65);

    const write = port.write('big.eml', bytes);
    await downloads.settle({ id: 1, state: { current: 'complete' } });
    await expect(write).resolves.toBe(1);
  });

  it('open() calls downloads.open with nothing awaited first, since Firefox only allows it from a user input handler', async () => {
    const downloads = stubDownloads();
    const port = new DownloadsEmlWriterPort();

    const open = port.open(7);

    // The call must have already happened synchronously, before this test even awaits anything.
    expect(downloads.open).toHaveBeenCalledTimes(1);
    expect(downloads.open).toHaveBeenCalledWith(7);
    await open;
  });
});
