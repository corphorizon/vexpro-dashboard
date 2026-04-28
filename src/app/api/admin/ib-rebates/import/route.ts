import { NextRequest, NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';

// ---------------------------------------------------------------------------
// POST /api/admin/ib-rebates/import — bulk insert/update desde Excel.
//
// Columnas esperadas (1-based):
//   1 Archivo | 2 Fecha | 3 Username | 4 STP | 5 ECN | 6 CENT | 7 PRO
//   8 VIP | 9 ELITE | 10 Sintéticos | 11 PropFirm
//
// Mode 'skip' deja las filas existentes intactas; 'update' las sobreescribe.
// ---------------------------------------------------------------------------

interface ImportRow {
  archivo: string | null;
  config_date: string;
  username: string;
  stp: number;
  ecn: number;
  cent: number;
  pro: number;
  vip: number;
  elite: number;
  syntheticos_level: number;
  propfirm_level: number;
}

function parseDate(s: string | Date | number | null | undefined): string | null {
  if (s === null || s === undefined || s === '') return null;
  if (s instanceof Date) return s.toISOString().slice(0, 10);
  const d = new Date(String(s));
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function parseNumOrZero(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v).replace(/,/g, '.'));
  return isNaN(n) ? 0 : n;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const mode = (formData.get('mode') as string) || 'skip'; // 'skip' | 'update'

    if (!file) {
      return NextResponse.json({ success: false, error: 'Archivo requerido' }, { status: 400 });
    }

    const buffer = await file.arrayBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) {
      return NextResponse.json({ success: false, error: 'Excel sin hojas' }, { status: 400 });
    }

    const rows: ImportRow[] = [];
    let isHeader = true;
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (isHeader) { isHeader = false; return; }
      const archivo = String(row.getCell(1).text || '').trim() || null;
      const config_date = parseDate(row.getCell(2).value as string | Date | number | null);
      const username = String(row.getCell(3).text || '').trim();
      if (!username || !config_date) return;
      rows.push({
        archivo,
        config_date,
        username,
        stp: parseNumOrZero(row.getCell(4).value),
        ecn: parseNumOrZero(row.getCell(5).value),
        cent: parseNumOrZero(row.getCell(6).value),
        pro: parseNumOrZero(row.getCell(7).value),
        vip: parseNumOrZero(row.getCell(8).value),
        elite: parseNumOrZero(row.getCell(9).value),
        syntheticos_level: parseNumOrZero(row.getCell(10).value),
        propfirm_level: parseNumOrZero(row.getCell(11).value),
      });
    });

    const admin = createAdminClient();

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const { data: existing } = await admin
        .from('ib_rebate_configs')
        .select('id')
        .eq('company_id', auth.companyId)
        .ilike('username', row.username)
        .maybeSingle();

      if (existing) {
        if (mode === 'skip') { skipped++; continue; }
        // Update preserva `original_config_date` (no se incluye). La fecha
        // del Excel pasa a ser la nueva `last_update_date` (y la legacy
        // `config_date`).
        const { error } = await admin
          .from('ib_rebate_configs')
          .update({
            archivo: row.archivo,
            config_date: row.config_date,
            last_update_date: row.config_date,
            stp: row.stp, ecn: row.ecn, cent: row.cent,
            pro: row.pro, vip: row.vip, elite: row.elite,
            syntheticos_level: row.syntheticos_level,
            propfirm_level: row.propfirm_level,
            updated_at: new Date().toISOString(),
            updated_by: auth.userId,
          })
          .eq('id', existing.id);
        if (error) errors.push(`${row.username}: ${error.message}`);
        else updated++;
      } else {
        const { error } = await admin
          .from('ib_rebate_configs')
          .insert({
            company_id: auth.companyId,
            username: row.username,
            archivo: row.archivo,
            // Primera vez: las 3 fechas arrancan iguales (la del Excel).
            config_date: row.config_date,
            original_config_date: row.config_date,
            last_update_date: row.config_date,
            stp: row.stp, ecn: row.ecn, cent: row.cent,
            pro: row.pro, vip: row.vip, elite: row.elite,
            syntheticos_level: row.syntheticos_level,
            propfirm_level: row.propfirm_level,
            goals_met: false,
            last_change_type: null,
            created_by: auth.userId,
            updated_by: auth.userId,
          });
        if (error) errors.push(`${row.username}: ${error.message}`);
        else inserted++;
      }
    }

    return NextResponse.json({
      success: true,
      inserted, updated, skipped, errors,
      total: rows.length,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Error' },
      { status: 500 },
    );
  }
}
