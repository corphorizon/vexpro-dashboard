// ─────────────────────────────────────────────────────────────────────────────
// POST /api/superadmin/liquidity/accounts/[id]/refresh
//
// Refresca UNA cuenta contra MT5 y recalcula su PnL mensual.
//
// ── LO QUE EL REFRESH NO TOCA: `balance_liquidez` ──────────────────────────
// Y es la regla más importante de este módulo. El aporte al pool se fija UNA
// vez, al agregar la cuenta, después de analizar si ese dinero ya estaba
// contado. Si el refresh lo recalculara, una transferencia detectada hace un
// mes volvería a descontarse en cada corrida y el pool encogería solo hasta
// cero, sin que nadie lo note.
//
// Acá se actualiza lo que MT5 sabe hoy: balance, equity, grupo y correo.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';
import { leerCuentaEnSesion, type Mt5AccountInfo } from '@/lib/liquidity/mt5-account';
import { pnlMensualEnSesion, type MonthlyPnl } from '@/lib/liquidity/monthly-pnl-calculator';
import { saldoALaFechaEnSesion, type SaldoALaFecha } from '@/lib/liquidity/connection-snapshot';
import { withMt5Connection } from '@/lib/api-integrations/mt5-sql/client';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const admin = createAdminClient();
    const { data: cuenta, error: e1 } = await admin
      .from('platform_liquidity_accounts')
      .select('id, company_id, mt5_account, connection_date, balance_liquidez, equity_at_connection, connection_values_manual')
      .eq('id', id)
      .maybeSingle();
    if (e1) return apiError('superadmin/liquidity/refresh', e1, { status: 500 });
    if (!cuenta) {
      return NextResponse.json({ success: false, error: 'Cuenta no encontrada.' }, { status: 404 });
    }

    const warnings: string[] = [];
    // Los datos de la cuenta y el PnL comparten UNA conexión. Abrir dos túneles
    // SOCKS costaba ~8 s para consultas que no llegan al segundo, y en
    // serverless no hay pool que sobreviva entre invocaciones.
    //
    // El saldo a la conexión se calcula SÓLO si falta: es un dato del pasado y
    // no cambia. Recalcularlo en cada refresco sería gastar la consulta más
    // cara del módulo para volver a escribir lo mismo — y pisaría lo que
    // alguien haya cargado a mano, que es justo lo que `connection_values_manual`
    // existe para impedir.
    const faltaSaldo =
      !cuenta.connection_values_manual &&
      (cuenta.equity_at_connection === null || cuenta.equity_at_connection === undefined);

    let mt5: Mt5AccountInfo | null = null;
    let pnl: MonthlyPnl[] = [];
    let saldo: SaldoALaFecha | null = null;
    let syncError: string | null = null;
    try {
      const lectura = await withMt5Connection(cuenta.company_id, async (s) => {
        const c = await leerCuentaEnSesion(s, Number(cuenta.mt5_account));
        if (!c) return { cuenta: null, pnl: [] as MonthlyPnl[], saldo: null as SaldoALaFecha | null };
        const fecha = new Date(cuenta.connection_date);
        return {
          cuenta: c,
          pnl: await pnlMensualEnSesion(s, String(cuenta.mt5_account), fecha),
          saldo: faltaSaldo
            ? await saldoALaFechaEnSesion(s, String(cuenta.mt5_account), fecha)
            : null,
        };
      });
      mt5 = lectura.cuenta;
      pnl = lectura.pnl;
      saldo = lectura.saldo;
      if (!mt5) syncError = `La cuenta ${cuenta.mt5_account} ya no existe en MT5.`;
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err);
    }

    if (syncError) {
      // Se marca el error pero NO se ponen los saldos en cero: un fallo de
      // conexión no es «el cliente se quedó sin plata», y confundirlos vaciaría
      // el pool por un problema de red.
      await admin
        .from('platform_liquidity_accounts')
        .update({
          status: 'error',
          sync_error: syncError,
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', id);
      return NextResponse.json({ success: false, error: syncError, warnings }, { status: 502 });
    }

    const { error: e2 } = await admin
      .from('platform_liquidity_accounts')
      .update({
        // `balance_liquidez` NO está acá a propósito. Ver la cabecera.
        balance: mt5!.balance,
        equity: mt5!.equity,
        mt5_group: mt5!.group,
        mt5_email: mt5!.email,
        status: mt5!.balance > 0 ? 'active' : 'inactive',
        sync_error: null,
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        // Sólo cuando se calculó recién. Sin el spread, un refresco normal
        // escribiría `null` encima del saldo que ya estaba bien.
        ...(saldo
          ? {
              balance_at_connection: saldo.balance,
              equity_at_connection: saldo.balance,
              connection_open_positions: saldo.posicionesAbiertas,
            }
          : {}),
      })
      .eq('id', id);
    if (e2) return apiError('superadmin/liquidity/refresh', e2, { status: 500 });

    if (saldo && !saldo.exacto) {
      warnings.push(
        `Había ${saldo.posicionesAbiertas} posición(es) abierta(s) al conectar: el equity de esa ` +
        `fecha era distinto del balance y MT5 no guarda el precio de ese momento. Se guardó el ` +
        `balance — editalo a mano si tenés el equity real.`,
      );
    }

    // El PnL sí se recalcula: son hechos de MT5, no una decisión sobre el pool.
    // Ya vino de la misma sesión de arriba, así que acá sólo se escribe.
    let meses = 0;
    if (pnl.length > 0) {
      const { error } = await admin.from('platform_liquidity_monthly_pnl').upsert(
        pnl.map((m) => ({ account_id: id, ...m })),
        { onConflict: 'account_id,year,month' },
      );
      if (error) warnings.push(`No se pudo guardar el PnL: ${error.message}`);
      else meses = pnl.length;
    }

    return NextResponse.json({ success: true, monthsCalculated: meses, warnings });
  } catch (err) {
    return apiError('superadmin/liquidity/refresh', err, { status: 500 });
  }
}
