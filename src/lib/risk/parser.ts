import ExcelJS from 'exceljs';
import type { Trade, ReportMetadata } from './types';

// NOTE: We migrated off `xlsx` (sheetJS) because it has two unpatched
// high-severity CVEs (prototype pollution + ReDoS) with no upstream fix.
// `exceljs` has no equivalent issues. The parser is now async because
// exceljs's load API returns a Promise; the only caller (the risk
// retiros-propfirm page) was already inside an async handler.

// ─── Parse MetaTrader 5 Trade History Excel ───

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = String(s).match(/(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function parseNumber(s: string | number | null | undefined): number {
  if (s === null || s === undefined) return 0;
  if (typeof s === 'number') return isNaN(s) ? 0 : s;

  let raw = String(s).trim();
  if (!raw) return 0;

  // Accounting-style negatives: "($1,234.56)" → "-1234.56"
  let negative = false;
  if (/^\(.*\)$/.test(raw)) {
    negative = true;
    raw = raw.slice(1, -1).trim();
  }
  // Explicit minus (including "- 1234" — MT5 style)
  if (/^[-−]\s*/.test(raw)) {
    negative = true;
    raw = raw.replace(/^[-−]\s*/, '');
  }

  // Strip currency symbols and common prefixes
  raw = raw.replace(/[$€£¥USD]/gi, '').trim();

  // Decide decimal separator: if the string has both "," and ".", the LAST one
  // is the decimal. If only "," is present, treat it as decimal (European).
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  let normalized: string;
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      // European: "1.234,56" → "1234.56"
      normalized = raw.replace(/\./g, '').replace(',', '.');
    } else {
      // US: "1,234.56" → "1234.56"
      normalized = raw.replace(/,/g, '');
    }
  } else if (lastComma > -1) {
    // Only comma — treat as decimal if followed by 1-2 digits; else thousands sep
    const afterComma = raw.length - lastComma - 1;
    normalized = afterComma <= 2
      ? raw.replace(',', '.')
      : raw.replace(/,/g, '');
  } else {
    // Only dot or neither — strip whitespace (MT5 uses spaces as thousands sep)
    normalized = raw.replace(/\s/g, '');
  }

  const n = parseFloat(normalized);
  if (isNaN(n)) return 0;
  return negative ? -n : n;
}

function parseNullableNumber(s: string | number | null | undefined): number | null {
  if (s === null || s === undefined || String(s).trim() === '') return null;
  return parseNumber(s);
}

export interface ParseResult {
  trades: Trade[];
  metadata: ReportMetadata;
}

/**
 * Reads every cell of a worksheet into a 0-indexed rectangular array of
 * display strings — mirrors what `XLSX.utils.sheet_to_json(ws, { header: 1,
 * raw: false })` produced, so the rest of the parser can stay byte-for-byte
 * identical.
 *
 * exceljs is 1-indexed (`row.getCell(1)` = column A) and `row.values[0]`
 * is always null. We normalise to 0-indexed arrays and coerce every cell
 * to its text representation via `cell.text` (handles rich text, formulas,
 * hyperlinks — parseNumber/parseDate below expect strings anyway).
 */
function sheetToMatrix(ws: ExcelJS.Worksheet): (string | null)[][] {
  const rows: (string | null)[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const arr: (string | null)[] = [];
    const last = row.cellCount;
    for (let c = 1; c <= last; c++) {
      const cell = row.getCell(c);
      // cell.text already applies number format / formula result / rich text.
      // Coerce defensively (rich-text cells can return non-string objects)
      // and normalise empty strings to null so `!row[0]` matches the old
      // xlsx behaviour.
      const t = cell.text;
      const s = t == null ? null : String(t);
      arr.push(s === '' ? null : s);
    }
    rows.push(arr);
  });
  return rows;
}

export async function parseTradeReport(buffer: ArrayBuffer): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) {
    throw new Error('El archivo no contiene hojas de cálculo');
  }
  const raw = sheetToMatrix(ws);

  // ─── Extract metadata ───
  let traderName = '';
  let accountNumber = '';
  let broker = '';
  let period = '';

  for (const row of raw) {
    if (!row || !row[0]) continue;
    const key = String(row[0]).trim();
    if (key === 'Name:') traderName = String(row[3] ?? '').trim();
    else if (key === 'Account:') accountNumber = String(row[3] ?? '').trim();
    else if (key === 'Broker:') broker = String(row[3] ?? '').trim();
    else if (key === 'Period:') period = String(row[3] ?? '').trim();
  }

  // ─── Find header row dynamically ───
  let headerRow = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] && String(raw[i][0]).trim() === 'Time' && String(raw[i][1]).trim() === 'Position') {
      headerRow = i;
      break;
    }
  }
  if (headerRow === -1) throw new Error('No se encontró la fila de headers (Time / Position)');

  // ─── Read trades until end of Positions section ───
  const trades: Trade[] = [];
  let idx = 0;
  for (let i = headerRow + 1; i < raw.length; i++) {
    const row = raw[i];
    if (!row || row[1] === null || row[1] === undefined || String(row[0]).trim() === 'Orders') break;

    const typeRaw = String(row[3] ?? '').toLowerCase().trim();
    if (typeRaw !== 'buy' && typeRaw !== 'sell') continue;

    const openTime = parseDate(row[0]);
    const closeTime = parseDate(row[8]);
    if (!openTime || !closeTime) continue;

    const durationMinutes = (closeTime.getTime() - openTime.getTime()) / 60000;

    trades.push({
      index: idx++,
      position: parseNumber(row[1]),
      symbol: String(row[2] ?? '').trim(),
      type: typeRaw as 'buy' | 'sell',
      volume: parseNumber(row[4]),
      openPrice: parseNumber(row[5]),
      closePrice: parseNumber(row[9]),
      sl: parseNullableNumber(row[6]),
      tp: parseNullableNumber(row[7]),
      openTime,
      closeTime,
      commission: parseNumber(row[10]),
      swap: parseNumber(row[11]),
      profit: parseNumber(row[12]),
      durationMinutes,
    });
  }

  // ─── Find Total Net Profit (search from end) ───
  let totalNetProfit = 0;
  for (let i = raw.length - 1; i >= 0; i--) {
    if (raw[i] && String(raw[i][0] ?? '').trim() === 'Total Net Profit:') {
      totalNetProfit = parseNumber(raw[i][3]);
      break;
    }
  }

  return {
    trades,
    metadata: { traderName, accountNumber, broker, period, totalNetProfit },
  };
}
