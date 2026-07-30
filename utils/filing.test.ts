import { describe, expect, it } from 'vitest';
import {
  archiveDirectory,
  documentStem,
  eracunFilename,
  isYearStraddle,
  planFiling,
  prilogFilename,
  resolvePartyName,
  sanitizeSegment,
  visualisationFilename,
  zagrebDate,
} from './filing';

describe('zagrebDate', () => {
  // Every millis value below is a verified Zagreb local midnight, independently computed via
  // Intl against Europe/Zagreb — the same convention the Portal's datumIzdavanja uses (trap 8).
  // Reading any of them with getUTCMonth()/getUTCFullYear() gives the wrong day.

  it('reads a month boundary correctly, not the UTC day before', () => {
    expect(zagrebDate(1772233200000)).toEqual({ year: 2026, month: 2, day: 28 });
    expect(zagrebDate(1772319600000)).toEqual({ year: 2026, month: 3, day: 1 });
  });

  it('never files the 1st of a month into the previous month', () => {
    const firstOfMarch = zagrebDate(1772319600000);
    expect(firstOfMarch.month).toBe(3);
    expect(firstOfMarch.day).toBe(1);
  });

  it('reads a year boundary correctly', () => {
    expect(zagrebDate(1767135600000)).toEqual({ year: 2025, month: 12, day: 31 });
    expect(zagrebDate(1767222000000)).toEqual({ year: 2026, month: 1, day: 1 });
  });

  it('reads dates either side of the spring DST transition correctly', () => {
    expect(zagrebDate(1774652400000)).toEqual({ year: 2026, month: 3, day: 28 }); // CET, before
    expect(zagrebDate(1774738800000)).toEqual({ year: 2026, month: 3, day: 29 }); // day of transition
    expect(zagrebDate(1774821600000)).toEqual({ year: 2026, month: 3, day: 30 }); // CEST, after
  });

  it('reads dates either side of the autumn DST transition correctly', () => {
    expect(zagrebDate(1792792800000)).toEqual({ year: 2026, month: 10, day: 24 }); // CEST, before
    expect(zagrebDate(1792879200000)).toEqual({ year: 2026, month: 10, day: 25 }); // day of transition
    expect(zagrebDate(1792969200000)).toEqual({ year: 2026, month: 10, day: 26 }); // CET, after
  });
});

describe('sanitizeSegment', () => {
  it('neutralises path separators so a slash-bearing broj dokumenta cannot create a directory (trap 2)', () => {
    const sanitized = sanitizeSegment('3343/1/1');
    expect(sanitized).not.toContain('/');
    expect(sanitized).not.toContain('\\');
  });

  it('strips trailing dots (trap 3)', () => {
    expect(sanitizeSegment('Recolo d.o.o.')).toBe('Recolo d.o.o');
    expect(sanitizeSegment('Recolo d.o.o.')).not.toMatch(/\.$/);
  });

  it('strips repeated trailing dots', () => {
    expect(sanitizeSegment('Recolo...')).toBe('Recolo');
  });

  it('replaces other filesystem-illegal characters', () => {
    const sanitized = sanitizeSegment('a:b*c?d"e<f>g|h');
    for (const illegal of [':', '*', '?', '"', '<', '>', '|']) {
      expect(sanitized).not.toContain(illegal);
    }
  });

  it('avoids a Windows-reserved device name', () => {
    expect(sanitizeSegment('CON')).not.toBe('CON');
    expect(sanitizeSegment('con')).not.toBe('con');
  });

  it('leaves an ordinary segment untouched', () => {
    expect(sanitizeSegment('Recolo')).toBe('Recolo');
  });

  it('is identical regardless of host platform or locale', () => {
    // The Turkish dotted/dotless İ/I pair is the classic case where a casing comparison drifts
    // by locale. Pinning the exact output (not just self-equality) proves the reserved-name
    // check's `toLocaleUpperCase('en-US')` isn't silently reading the host's locale.
    expect(sanitizeSegment('İstanbul/1.')).toBe('İstanbul-1');
  });
});

describe('the code → Marked type table', () => {
  it('380 and 82 produce no suffix', () => {
    expect(
      documentStem({ brojDokumenta: '1', datumIzdavanja: 1772319600000, vrstaDokumenta: { code: 380 } }),
    ).not.toMatch(/_[A-Z]+$/);
    expect(
      documentStem({ brojDokumenta: '1', datumIzdavanja: 1772319600000, vrstaDokumenta: { code: 82 } }),
    ).not.toMatch(/_[A-Z]+$/);
  });

  it('matches docs/document-types.md for a marked code', () => {
    expect(
      documentStem({ brojDokumenta: '1', datumIzdavanja: 1772319600000, vrstaDokumenta: { code: 381 } }),
    ).toMatch(/_ODOBRENJE$/);
  });

  it('resolves a code absent from the table to NEPOZNATO', () => {
    expect(
      documentStem({ brojDokumenta: '1', datumIzdavanja: 1772319600000, vrstaDokumenta: { code: 9999 } }),
    ).toMatch(/_NEPOZNATO$/);
  });
});

describe('documentStem', () => {
  it('sanitises a slash-bearing broj dokumenta into part of the filename', () => {
    const stem = documentStem({
      brojDokumenta: '3343/1/1',
      datumIzdavanja: 1772319600000,
      vrstaDokumenta: { code: 380 },
    });
    expect(stem).not.toContain('/');
  });
});

describe('eracunFilename and visualisationFilename', () => {
  it('share a stem, differing only by extension', () => {
    const row = { brojDokumenta: '3343/1/1', datumIzdavanja: 1772319600000, vrstaDokumenta: { code: 380 } };
    const stem = documentStem(row);
    expect(eracunFilename(stem)).toBe(`${stem}.xml`);
    expect(visualisationFilename(stem)).toBe(`${stem}.pdf`);
  });
});

describe('prilogFilename', () => {
  it('keeps the Issuer-given name, sanitised, alongside the stem', () => {
    expect(prilogFilename('2026-03-01_1', 'troskovnik.pdf')).toBe('2026-03-01_1_troskovnik.pdf');
  });

  it('sanitises a Prilog name that would otherwise be unsafe', () => {
    const name = prilogFilename('2026-03-01_1', 'trošak/troškovnik.');
    expect(name).not.toContain('/');
    expect(name).not.toMatch(/\.$/);
  });
});

describe('resolvePartyName', () => {
  it('picks the naziv of the lowest-id candidate', () => {
    const candidates = [
      { id: 12, naziv: 'Recolo d.o.o' },
      { id: 3, naziv: 'Recolo društvo s ograničenom odgovornošću' },
      { id: 40, naziv: 'Recolo d.o.o' },
    ];
    expect(resolvePartyName(candidates)).toBe('Recolo društvo s ograničenom odgovornošću');
  });

  it('is stable whichever order the candidates arrive in', () => {
    const forward = [
      { id: 3, naziv: 'Recolo društvo s ograničenom odgovornošću' },
      { id: 12, naziv: 'Recolo d.o.o' },
    ];
    const reversed = [...forward].reverse();
    expect(resolvePartyName(forward)).toBe(resolvePartyName(reversed));
  });
});

describe('archiveDirectory', () => {
  it('produces {Archive root}/{Recipient}/{YYYY}/{MM}/{Issuer}, MM as two digits', () => {
    expect(
      archiveDirectory({
        archiveRoot: 'Arhiva',
        recipientName: 'Moja tvrtka',
        issuerName: 'Recolo d.o.o',
        datumIzdavanja: 1772319600000, // 2026-03-01 Zagreb
      }),
    ).toEqual(['Arhiva', 'Moja tvrtka', '2026', '03', 'Recolo d.o.o']);
  });

  it('sanitises the Issuer and Recipient segments', () => {
    const directory = archiveDirectory({
      archiveRoot: 'Arhiva',
      recipientName: 'Moja tvrtka d.o.o.',
      issuerName: 'Recolo d.o.o.',
      datumIzdavanja: 1772319600000,
    });
    for (const segment of directory) {
      expect(segment).not.toMatch(/\.$/);
    }
  });
});

describe('isYearStraddle', () => {
  it('detects a Document issued 28.12 and received 06.01 as a straddle (ADR-0006)', () => {
    const issued28Dec = 1766876400000; // 2025-12-28 Zagreb midnight
    const received6Jan = 1767654000000; // 2026-01-06 Zagreb midnight
    expect(isYearStraddle({ datumIzdavanja: issued28Dec, datumZaprimanja: received6Jan })).toBe(true);
  });

  it('is false when both dates fall in the same Zagreb year', () => {
    const issued = 1772319600000; // 2026-03-01
    const received = 1772406000000; // 2026-03-02
    expect(isYearStraddle({ datumIzdavanja: issued, datumZaprimanja: received })).toBe(false);
  });
});

describe('planFiling', () => {
  it('never lets the id appear in the directory or any filename (ADR-0007)', () => {
    const row = {
      id: 123456,
      brojDokumenta: '3343/1/1',
      datumIzdavanja: 1772319600000,
      datumZaprimanja: 1772406000000,
      vrstaDokumenta: { code: 381 },
    };
    const plan = planFiling(row, {
      archiveRoot: 'Arhiva',
      recipientName: 'Moja tvrtka',
      issuerName: 'Recolo d.o.o',
    });
    const idString = row.id.toString();
    expect(plan.directory.join('/')).not.toContain(idString);
    expect(plan.eracun).not.toContain(idString);
    expect(plan.visualisation).not.toContain(idString);
    expect(plan.stem).not.toContain(idString);
  });

  it('detects and reports a Year straddle without changing the directory', () => {
    const row = {
      id: 1,
      brojDokumenta: '1',
      datumIzdavanja: 1767135600000, // 2025-12-31 Zagreb
      datumZaprimanja: 1767222000000, // 2026-01-01 Zagreb
      vrstaDokumenta: { code: 380 },
    };
    const plan = planFiling(row, {
      archiveRoot: 'Arhiva',
      recipientName: 'Moja tvrtka',
      issuerName: 'Recolo d.o.o',
    });
    expect(plan.yearStraddle).toBe(true);
    expect(plan.directory).toEqual(['Arhiva', 'Moja tvrtka', '2025', '12', 'Recolo d.o.o']);
  });
});
