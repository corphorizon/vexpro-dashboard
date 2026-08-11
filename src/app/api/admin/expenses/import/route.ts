// ---------------------------------------------------------------------------
// POST /api/admin/expenses/import — parsea un Excel/CSV de egresos.
//
// DECISIÓN CENTRAL: este endpoint NO escribe en la base. Devuelve las filas
// parseadas y validadas; el cliente las agrega al estado local de /upload y
// se guardan por el camino normal (replace_period_expenses). Así el import
// pasa por los MISMOS controles que el tipeo a mano: el trigger de período
// cerrado, el sync de plantillas y el payload completo de columnas — un
// pipeline de guardado paralelo habría divergido del real, que es el modo de
// falla número uno de este repo.
//
// Columnas esperadas (fila 1 = encabezados, orden libre, sin distinguir
// mayúsculas/tildes):
//   Concepto (obligatoria) | Categoría | Fecha | Monto (obligatoria) |
//   Pagado | Pendiente | Referencia
//
// Validación por fila con error explícito — nada de convertir basura a $0 en
// silencio (la lección de parseAmount, auditoría 2026-08-06 R1).
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';

export interface ImportedExpenseRow {
  concept: string;
  category: string | null;
  expense_date: string | null;
  amount: number;
  paid: number;
  pending: number;
  reference: string | null;
}

const MAX_ROWS = 500;
const MAX_SIZE = 5 * 1024 * 1024; // 5 MB

/** Normaliza un encabezado: minúsculas, sin tildes, sin espacios. */
function normHeader(h: string): string {
  return h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

const HEADER_MAP: Record<string, keyof ImportedExpenseRow> = {
  concepto: 'concept', concept: 'concept',
  categoria: 'category', category: 'category',
  fecha: 'expense_date', date: 'expense_date',
  monto: 'amount', amount: 'amount', importe: 'amount',
  pagado: 'paid', paid: 'paid',
  pendiente: 'pending', pending: 'pending',
  referencia: 'reference', reference: 'reference', ref: 'reference',
};

/** Número estricto: '' → null, basura → NaN (que el caller convierte en error). */
function parseStrictNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  // Acepta "1.234,56" y "1,234.56": se queda con el último separador decimal.
  const s = String(v).trim().replace(/[$\s]/g, '');
  const normalized = s.includes(',') && s.lastIndexOf(',') > s.lastIndexOf('.')
    ? s.replace(/\./g, '').replace(',', '.')
    : s.replace(/,/g, '');
  const n = Number(normalized);
  return normalized === '' ? null : n;
}

function parseDateCell(v: unknown): string | null | 'invalid' {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // dd/mm/yyyy — el formato que sale de Excel en español.
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return 'invalid';
}

/** CSV con comillas y separador , o ; (Excel en español exporta con ;). */
function parseCsv(text: string): string[][] {
  const firstLine = text.slice(0, text.indexOf('\n') + 1 || undefined);
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['expenses', 'upload'] });
    if (auth instanceof NextResponse) return auth;

    const formData = await request.formData();
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ success: false, error: 'Archivo requerido' }, { status: 400 });
    }
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ success: false, error: 'Archivo demasiado grande (máx 5 MB)' }, { status: 400 });
    }

    // ── Extraer la matriz de celdas (Excel o CSV) ─────────────────────────
    let matrix: unknown[][];
    const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
    if (isCsv) {
      matrix = parseCsv(await file.text());
    } else {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await file.arrayBuffer());
      const ws = wb.worksheets[0];
      if (!ws) {
        return NextResponse.json({ success: false, error: 'El archivo no tiene hojas' }, { status: 400 });
      }
      matrix = [];
      ws.eachRow((row) => {
        const cells: unknown[] = [];
        row.eachCell({ includeEmpty: true }, (cell) => {
          // .result para fórmulas; .text cubre rich text.
          const v = cell.value;
          cells.push(
            v && typeof v === 'object' && 'result' in v ? (v as { result: unknown }).result :
            v && typeof v === 'object' && 'richText' in v ? cell.text :
            v,
          );
        });
        matrix.push(cells);
      });
    }

    if (matrix.length < 2) {
      return NextResponse.json(
        { success: false, error: 'El archivo necesita una fila de encabezados y al menos una de datos' },
        { status: 400 },
      );
    }

    // ── Mapear encabezados ────────────────────────────────────────────────
    const headers = matrix[0].map((h) => HEADER_MAP[normHeader(String(h ?? ''))] ?? null);
    if (!headers.includes('concept') || !headers.includes('amount')) {
      return NextResponse.json(
        {
          success: false,
          error: 'Faltan las columnas obligatorias "Concepto" y "Monto". Columnas aceptadas: Concepto, Categoría, Fecha, Monto, Pagado, Pendiente, Referencia.',
        },
        { status: 400 },
      );
    }

    const dataRows = matrix.slice(1, MAX_ROWS + 1);
    const truncated = matrix.length - 1 > MAX_ROWS;

    const rows: ImportedExpenseRow[] = [];
    const errors: Array<{ row: number; error: string }> = [];

    dataRows.forEach((cells, idx) => {
      const rowNum = idx + 2; // 1-based + encabezado
      const rec: Partial<Record<keyof ImportedExpenseRow, unknown>> = {};
      headers.forEach((key, i) => { if (key) rec[key] = cells[i]; });

      const concept = String(rec.concept ?? '').trim();
      if (!concept) { errors.push({ row: rowNum, error: 'Concepto vacío' }); return; }

      const amount = parseStrictNumber(rec.amount);
      if (amount === null || Number.isNaN(amount)) {
        errors.push({ row: rowNum, error: `Monto inválido: "${String(rec.amount ?? '')}"` });
        return;
      }
      if (amount < 0) { errors.push({ row: rowNum, error: 'El monto no puede ser negativo' }); return; }

      const paid = parseStrictNumber(rec.paid) ?? 0;
      if (Number.isNaN(paid) || paid < 0) {
        errors.push({ row: rowNum, error: `Pagado inválido: "${String(rec.paid ?? '')}"` });
        return;
      }

      const pendingRaw = parseStrictNumber(rec.pending);
      if (pendingRaw !== null && Number.isNaN(pendingRaw)) {
        errors.push({ row: rowNum, error: `Pendiente inválido: "${String(rec.pending ?? '')}"` });
        return;
      }

      const date = parseDateCell(rec.expense_date);
      if (date === 'invalid') {
        errors.push({ row: rowNum, error: `Fecha inválida: "${String(rec.expense_date ?? '')}" (usar AAAA-MM-DD o DD/MM/AAAA)` });
        return;
      }

      rows.push({
        concept,
        category: String(rec.category ?? '').trim() || null,
        expense_date: date,
        amount,
        paid,
        // Pendiente explícito o el resto; nunca negativo por redondeos.
        pending: pendingRaw ?? Math.max(0, amount - paid),
        reference: String(rec.reference ?? '').trim() || null,
      });
    });

    return NextResponse.json({ success: true, rows, errors, truncated });
  } catch (err) {
    return apiError('admin/expenses/import', err, {
      status: 500,
      clientMessage: 'No se pudo leer el archivo. ¿Es un .xlsx o .csv válido?',
    });
  }
}
