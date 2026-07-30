// Shipped copy of docs/document-types.md — keep this table in sync with that file.

export type MarkedType = 'ODOBRENJE' | 'TERECENJE' | 'ISPRAVAK' | 'PREDUJAM' | 'PREDRACUN' | 'NEPOZNATO';

export const ORDINARY_INVOICE_CODES: readonly number[] = [380, 82];

const MARKED_TYPE_BY_CODE: Readonly<Record<number, MarkedType>> = {
  81: 'ODOBRENJE',
  83: 'ODOBRENJE',
  261: 'ODOBRENJE',
  262: 'ODOBRENJE',
  296: 'ODOBRENJE',
  308: 'ODOBRENJE',
  381: 'ODOBRENJE',
  396: 'ODOBRENJE',
  420: 'ODOBRENJE',
  532: 'ODOBRENJE',

  80: 'TERECENJE',
  84: 'TERECENJE',
  383: 'TERECENJE',
  527: 'TERECENJE',

  384: 'ISPRAVAK',

  386: 'PREDUJAM',

  325: 'PREDRACUN',

  130: 'NEPOZNATO',
  456: 'NEPOZNATO',
  457: 'NEPOZNATO',
  458: 'NEPOZNATO',
  71: 'NEPOZNATO',
  102: 'NEPOZNATO',
  202: 'NEPOZNATO',
  203: 'NEPOZNATO',
  204: 'NEPOZNATO',
  211: 'NEPOZNATO',
  218: 'NEPOZNATO',
  219: 'NEPOZNATO',
  295: 'NEPOZNATO',
  326: 'NEPOZNATO',
  331: 'NEPOZNATO',
  382: 'NEPOZNATO',
  385: 'NEPOZNATO',
  387: 'NEPOZNATO',
  388: 'NEPOZNATO',
  389: 'NEPOZNATO',
  390: 'NEPOZNATO',
  393: 'NEPOZNATO',
  394: 'NEPOZNATO',
  395: 'NEPOZNATO',
  533: 'NEPOZNATO',
  575: 'NEPOZNATO',
  623: 'NEPOZNATO',
  633: 'NEPOZNATO',
  751: 'NEPOZNATO',
  780: 'NEPOZNATO',
  817: 'NEPOZNATO',
  870: 'NEPOZNATO',
  875: 'NEPOZNATO',
  876: 'NEPOZNATO',
  877: 'NEPOZNATO',
  935: 'NEPOZNATO',
};

export function isOrdinaryInvoice(code: number): boolean {
  return ORDINARY_INVOICE_CODES.includes(code);
}

/** Every code this table knows about, Ordinary and Marked alike. */
export function knownDocumentTypeCodes(): readonly number[] {
  return [...ORDINARY_INVOICE_CODES, ...Object.keys(MARKED_TYPE_BY_CODE).map(Number)];
}

/** Null for an Ordinary invoice. A code absent from the table is drift and reads as NEPOZNATO. */
export function markedTypeForCode(code: number): MarkedType | null {
  if (isOrdinaryInvoice(code)) return null;
  return MARKED_TYPE_BY_CODE[code] ?? 'NEPOZNATO';
}
