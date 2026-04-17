import * as XLSX from 'xlsx';
import type { Trade, ReportMetadata } from './types';

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

export function parseTradeReport(buffer: ArrayBuffer): ParseResult {
  const wb = XLSX.read(buffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });

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
