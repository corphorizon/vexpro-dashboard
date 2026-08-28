// ─────────────────────────────────────────────────────────────────────────────
// GET /api/superadmin/liquidity/monthly-summary?company_id=...[&year=&month=]
//
// Dos modos, un solo lugar donde se cruzan cuentas con su PnL:
//
//   · sin year/month → una fila por MES: total del pool, operaciones y cuántas
//     cuentas aportaron. Responde «cuánto rindió el pool en julio», que mirando
//     cuenta por cuenta no se ve.
//   · con year/month → una fila por CUENTA de ese mes.
//
// Están juntos porque comparten el cruce. Separarlos en dos endpoints dejaría
// dos versiones de la misma regla —qué cuenta entra en qué mes— y el día que
// una cambie, la otra queda mintiendo.
//
// ── QUÉ CUENTAS ENTRAN EN UN MES ───────────────────────────────────────────
// Sólo las que tienen fila de PnL de ese mes, y esas filas existen desde la
// fecha de conexión de cada cuenta en adelante. Una cuenta conectada en agosto
// no «aportó cero» en julio: no estaba. Pero una que SÍ estaba y no operó
// aparece con cero, porque estar en el pool sin operar es un dato.
//
// ── POR QUÉ SE PAGINA ──────────────────────────────────────────────────────
// PostgREST corta en 1.000 filas sin avisar. `platform_liquidity_monthly_pnl`
// tiene una fila por cuenta y por mes: con 100 cuentas y dos años ya son 2.400.
// Sin paginar, el resumen de los meses viejos saldría incompleto y con cara de
// completo.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows';
import { apiError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';

interface FilaCuenta {
  id: string;
  mt5_account: string;
  mt5_email: string | null;
  mt5_group: string | null;
  balance: number | string | null;
  balance_liquidez: number | string | null;
  connection_date: string;
  status: string;
}

interface FilaPnl {
  account_id: string;
  year: number;
  month: number;
  pnl: number | string | null;
  operations_count: number | string | null;
  is_partial: boolean | null;
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const redondear = (n: number) => Math.round(n * 100) / 100;

export async function GET(request: NextRequest) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;

    const sp = request.nextUrl.searchParams;
    const companyId = sp.get('company_id');
    if (!companyId) {
      return NextResponse.json({ success: false, error: 'Falta company_id.' }, { status: 400 });
    }

    // year/month juntos o ninguno. Aceptar uno solo llevaría a «el mes 7 de
    // ningún año», que no significa nada.
    const crudoY = sp.get('year');
    const crudoM = sp.get('month');
    const detalle = crudoY !== null || crudoM !== null;
    let year = 0;
    let month = 0;
    if (detalle) {
      year = Number(crudoY);
      month = Number(crudoM);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        return NextResponse.json({ success: false, error: 'Año inválido.' }, { status: 400 });
      }
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        return NextResponse.json({ success: false, error: 'Mes inválido.' }, { status: 400 });
      }
    }

    const admin = createAdminClient();

    // `.order('id')` no es cosmético: sin un orden por columna única las
    // páginas se solapan y se pierden filas, sin dar error.
    const cuentas = await fetchAllRows<FilaCuenta>((from, to) =>
      admin
        .from('platform_liquidity_accounts')
        .select('id, mt5_account, mt5_email, mt5_group, balance, balance_liquidez, connection_date, status')
        .eq('company_id', companyId)
        .order('id')
        .range(from, to),
    );

    if (cuentas.length === 0) {
      return detalle
        ? NextResponse.json({ success: true, year, month, rows: [], total: 0, operations: 0 })
        : NextResponse.json({ success: true, months: [] });
    }

    const ids = cuentas.map((c) => String(c.id));
    const porCuenta = new Map(cuentas.map((c) => [String(c.id), c]));

    const pnl = await fetchAllRows<FilaPnl>((from, to) => {
      let q = admin
        .from('platform_liquidity_monthly_pnl')
        .select('account_id, year, month, pnl, operations_count, is_partial')
        .in('account_id', ids);
      if (detalle) q = q.eq('year', year).eq('month', month);
      // `account_id` sola no es única acá (hay una fila por mes): el orden
      // tiene que incluir el mes para que las páginas no se pisen.
      return q.order('year').order('month').order('account_id').range(from, to);
    });

    // ── Modo detalle: una fila por cuenta ────────────────────────────────
    if (detalle) {
      const rows = pnl
        .filter((p) => porCuenta.has(String(p.account_id)))
        .map((p) => {
          const c = porCuenta.get(String(p.account_id))!;
          return {
            account_id: c.id,
            mt5_account: c.mt5_account,
            mt5_email: c.mt5_email,
            mt5_group: c.mt5_group,
            balance: num(c.balance),
            balance_liquidez: num(c.balance_liquidez),
            connection_date: c.connection_date,
            status: c.status,
            pnl: num(p.pnl),
            operations_count: num(p.operations_count),
            is_partial: Boolean(p.is_partial),
          };
        })
        .sort((a, b) => a.pnl - b.pnl); // el peor arriba: es lo que se mira

      return NextResponse.json({
        success: true,
        year,
        month,
        rows,
        total: redondear(rows.reduce((s, r) => s + r.pnl, 0)),
        operations: rows.reduce((s, r) => s + r.operations_count, 0),
      });
    }

    // ── Modo meses: una fila por mes ─────────────────────────────────────
    const porMes = new Map<string, {
      year: number; month: number; total: number; operations: number;
      accounts: number; accounts_with_activity: number; is_partial: boolean;
    }>();

    for (const p of pnl) {
      if (!porCuenta.has(String(p.account_id))) continue;
      const y = num(p.year);
      const m = num(p.month);
      if (!y || !m) continue;
      const k = `${y}-${m}`;
      const acc = porMes.get(k) ?? {
        year: y, month: m, total: 0, operations: 0,
        accounts: 0, accounts_with_activity: 0, is_partial: false,
      };
      const ops = num(p.operations_count);
      acc.total += num(p.pnl);
      acc.operations += ops;
      // `accounts` es cuántas ESTABAN en el pool; `accounts_with_activity`,
      // cuántas operaron. Mostrar sólo la segunda haría parecer que el pool
      // se vació en los meses tranquilos.
      acc.accounts += 1;
      if (ops > 0) acc.accounts_with_activity += 1;
      if (p.is_partial) acc.is_partial = true;
      porMes.set(k, acc);
    }

    const months = [...porMes.values()]
      .map((m) => ({ ...m, total: redondear(m.total) }))
      .sort((a, b) => (b.year - a.year) || (b.month - a.month)); // más reciente arriba

    return NextResponse.json({
      success: true,
      months,
      // Totales de todo el rango, para no obligar a sumar la columna a ojo.
      grand_total: redondear(months.reduce((s, m) => s + m.total, 0)),
      grand_operations: months.reduce((s, m) => s + m.operations, 0),
    });
  } catch (err) {
    return apiError('superadmin/liquidity/monthly-summary', err, { status: 500 });
  }
}
