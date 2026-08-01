import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { DownloadsRecordPort, DownloadRecord, type DownloadRecordEntry } from './download-record';

beforeEach(() => {
  fakeBrowser.reset();
});

const DIR = ['Arhiva', 'Primatelj d.o.o', '2026', '07', 'Izdavatelj d.o.o'];

function entry(overrides: Partial<DownloadRecordEntry> & { filename: string }): DownloadRecordEntry {
  return { complete: true, exists: true, ...overrides };
}

describe('DownloadRecord', () => {
  describe('has', () => {
    it('is true for a completed, still-existing download whose path ends with the directory and filename', () => {
      const record = new DownloadRecord([
        entry({ filename: '/home/user/Downloads/Arhiva/Primatelj d.o.o/2026/07/Izdavatelj d.o.o/2026-07-01_1-1-1.xml' }),
      ]);

      expect(record.has(DIR, '2026-07-01_1-1-1.xml')).toBe(true);
    });

    it('matches a Windows-style absolute path with backslash separators against forward-slash directory segments', () => {
      const record = new DownloadRecord([
        entry({ filename: 'C:\\Users\\me\\Downloads\\Arhiva\\Primatelj d.o.o\\2026\\07\\Izdavatelj d.o.o\\2026-07-01_1-1-1.xml' }),
      ]);

      expect(record.has(DIR, '2026-07-01_1-1-1.xml')).toBe(true);
    });

    it('is false when no entry has that filename at all', () => {
      const record = new DownloadRecord([entry({ filename: '/downloads/other.xml' })]);

      expect(record.has(DIR, '2026-07-01_1-1-1.xml')).toBe(false);
    });

    it('is false when the filename matches but the directory does not (a same-named file elsewhere)', () => {
      const record = new DownloadRecord([
        entry({ filename: '/home/user/Downloads/Arhiva/Someone Else/2026/07/Other/2026-07-01_1-1-1.xml' }),
      ]);

      expect(record.has(DIR, '2026-07-01_1-1-1.xml')).toBe(false);
    });

    it('is false when the write never completed, even at the exact expected path', () => {
      const record = new DownloadRecord([
        entry({
          filename: '/home/user/Downloads/Arhiva/Primatelj d.o.o/2026/07/Izdavatelj d.o.o/2026-07-01_1-1-1.xml',
          complete: false,
        }),
      ]);

      expect(record.has(DIR, '2026-07-01_1-1-1.xml')).toBe(false);
    });

    it('is false when the recorded file no longer exists', () => {
      const record = new DownloadRecord([
        entry({
          filename: '/home/user/Downloads/Arhiva/Primatelj d.o.o/2026/07/Izdavatelj d.o.o/2026-07-01_1-1-1.xml',
          exists: false,
        }),
      ]);

      expect(record.has(DIR, '2026-07-01_1-1-1.xml')).toBe(false);
    });

    it('is false for an empty record', () => {
      const record = new DownloadRecord([]);

      expect(record.has(DIR, '2026-07-01_1-1-1.xml')).toBe(false);
    });
  });

  describe('countWithPrefix', () => {
    it('counts only completed, still-existing entries in the given directory whose filename starts with the prefix', () => {
      const record = new DownloadRecord([
        entry({ filename: `/dl/${DIR.join('/')}/2026-07-01_1-1-1_Prilog-A.pdf` }),
        entry({ filename: `/dl/${DIR.join('/')}/2026-07-01_1-1-1_Prilog-B.pdf` }),
        // Same prefix, different directory — must not count.
        entry({ filename: `/dl/Arhiva/Other/2026/07/Other/2026-07-01_1-1-1_Prilog-C.pdf` }),
        // Same directory, unrelated prefix — must not count.
        entry({ filename: `/dl/${DIR.join('/')}/2026-07-01_9-9-9_Prilog-D.pdf` }),
      ]);

      expect(record.countWithPrefix(DIR, '2026-07-01_1-1-1_')).toBe(2);
    });

    it('excludes a partial or vanished entry from the count', () => {
      const record = new DownloadRecord([
        entry({ filename: `/dl/${DIR.join('/')}/2026-07-01_1-1-1_Prilog-A.pdf` }),
        entry({ filename: `/dl/${DIR.join('/')}/2026-07-01_1-1-1_Prilog-B.pdf`, complete: false }),
        entry({ filename: `/dl/${DIR.join('/')}/2026-07-01_1-1-1_Prilog-C.pdf`, exists: false }),
      ]);

      expect(record.countWithPrefix(DIR, '2026-07-01_1-1-1_')).toBe(1);
    });

    it('is 0 when nothing in the directory matches the prefix', () => {
      const record = new DownloadRecord([entry({ filename: `/dl/${DIR.join('/')}/2026-07-01_1-1-1.xml` })]);

      expect(record.countWithPrefix(DIR, '2026-07-01_1-1-1_')).toBe(0);
    });
  });
});

describe('DownloadsRecordPort', () => {
  it("keeps only entries this extension itself downloaded, dropping another extension's or the user's own", async () => {
    const search = vi.fn().mockResolvedValue([
      { filename: '/dl/mine.xml', state: 'complete', exists: true, byExtensionId: fakeBrowser.runtime.id },
      { filename: '/dl/other-extension.xml', state: 'complete', exists: true, byExtensionId: 'some-other-id' },
      { filename: '/dl/user-saved.xml', state: 'complete', exists: true },
    ]);
    fakeBrowser.downloads.search = search;

    const record = await new DownloadsRecordPort().load();

    expect(search).toHaveBeenCalledWith({});
    expect(record.has([], 'mine.xml')).toBe(true);
    expect(record.has([], 'other-extension.xml')).toBe(false);
    expect(record.has([], 'user-saved.xml')).toBe(false);
  });

  it('carries state and exists through faithfully rather than assuming completion', async () => {
    fakeBrowser.downloads.search = vi.fn().mockResolvedValue([
      { filename: '/dl/in-progress.xml', state: 'in_progress', exists: true, byExtensionId: fakeBrowser.runtime.id },
    ]);

    const record = await new DownloadsRecordPort().load();

    expect(record.has([], 'in-progress.xml')).toBe(false);
  });
});
