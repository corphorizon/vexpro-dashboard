// ─────────────────────────────────────────────────────────────────────────────
// /api/superadmin/liquidity/accounts
//
//   GET  → cuentas del pool (filtro opcional ?status=active|inactive|error|all)
//   POST → agrega una cuenta: lee MT5, analiza duplicados y calcula el PnL.
//
// Sólo superadmin: un pool de liquidez es información de plataforma, no de una
// empresa. Por eso `verifySuperadminAuth()` y no el guard de módulos.
//
// ── EL POST ES DONDE PASA TODO ─────────────────────────────────────────────
// Agregar una cuenta dispara cuatro cosas en orden, y el orden importa:
//   1. leer la cuenta en MT5 (si no existe, se corta antes de escribir nada)
//   2. analizar si su dinero YA está contado en el pool
//   3. escribir la cuenta con el aporte que corresponda
//   4. aplicar los efectos sobre las cuentas viejas y calcular el PnL
//
// Los pasos 1 y 2 pueden fallar por causas externas (MT5 o Mongo caídos). En
// ese caso la cuenta se guarda igual, en estado `error` y con el motivo escrito
// en `sync_error`: perder el alta porque el broker no respondió obligaría a
// reintentar a ciegas, y una cuenta sin diagnóstico se ve, se explica y se
// refresca.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';
import { fetchMt5Account } from '@/lib/liquidity/mt5-account';
import { analizarCuentaNueva } from '@/lib/liquidity/duplicate-account-detector';
import { calculateMonthlyPnL } from '@/lib/liquidity/monthly-pnl-calculator';
import { validarFechaConexion } from '@/lib/liquidity/connection-date';
import { calcularSaldoALaFecha } from '@/lib/liquidity/connection-snapshot';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const companyId = request.nextUrl.searchParams.get('company_id');
    const status = request.nextUrl.searchParams.get('status') ?? 'all';

    let q = admin
      .from('platform_liquidity_accounts')
      .select('*')
      .order('created_at', { ascending: false });
    if (companyId) q = q.eq('company_id', companyId);
    if (status !== 'all') q = q.eq('status', status);

    const { data, error } = await q;
    if (error) return apiError('superadmin/liquidity/accounts', error, { status: 500 });

    return NextResponse.json({ success: true, accounts: data ?? [] });
  } catch (err) {
    return apiError('superadmin/liquidity/accounts', err, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;

    const body = (await request.json().catch(() => ({}))) as {
      mt5_account?: unknown;
      company_id?: unknown;
      connection_date?: unknown;
    };
    const mt5Account = String(body.mt5_account ?? '').trim();
    const companyId = String(body.company_id ?? '').trim();

    // Sin fecha explícita, hoy: el caso normal es conectar una cuenta ahora.
    // Con fecha, sirve para dar de alta una cuenta que ya venía operando y
    // recuperarle la historia.
    let fechaConexion = new Date();
    if (body.connection_date !== undefined && body.connection_date !== null && body.connection_date !== '') {
      const v = validarFechaConexion(body.connection_date);
      if (!v.ok) return NextResponse.json({ success: false, error: v.error }, { status: 400 });
      fechaConexion = v.fecha;
    }

    if (!mt5Account || !/^\d+$/.test(mt5Account)) {
      return NextResponse.json(
        { success: false, error: 'El número de cuenta MT5 debe ser numérico.' },
        { status: 400 },
      );
    }
    if (!companyId) {
      return NextResponse.json({ success: false, error: 'Falta company_id.' }, { status: 400 });
    }

    const admin = createAdminClient();

    // Duplicado explícito: el UNIQUE lo cubre, pero un 409 con mensaje es más
    // útil que un error de constraint.
    const { data: yaEsta } = await admin
      .from('platform_liquidity_accounts')
      .select('id')
      .eq('company_id', companyId)
      .eq('mt5_account', mt5Account)
      .maybeSingle();
    if (yaEsta) {
      return NextResponse.json(
        { success: false, error: `La cuenta ${mt5Account} ya está en el pool.` },
        { status: 409 },
      );
    }

    const warnings: string[] = [];

    // ── 1. MT5 ────────────────────────────────────────────────────────────
    let mt5: Awaited<ReturnType<typeof fetchMt5Account>> = null;
    let syncError: string | null = null;
    try {
      mt5 = await fetchMt5Account(companyId, Number(mt5Account));
      if (!mt5) {
        return NextResponse.json(
          { success: false, error: `La cuenta ${mt5Account} no existe en MT5.` },
          { status: 404 },
        );
      }
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err);
      warnings.push(`No se pudo leer MT5: ${syncError}. La cuenta se guardó sin datos — refrescar a mano.`);
    }

    // ── 2. ¿Su dinero ya está contado? ────────────────────────────────────
    let analisis: Awaited<ReturnType<typeof analizarCuentaNueva>> | null = null;
    if (mt5) {
      try {
        analisis = await analizarCuentaNueva(admin, companyId, {
          mt5Account,
          email: mt5.email,
          balance: mt5.balance,
        });
        warnings.push(...analisis.warnings);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        warnings.push(`No se pudo analizar duplicados: ${m}. El balance se contó completo.`);
      }
    }

    // ── 2b. El saldo QUE TENÍA en la fecha de conexión ────────────────────
    // No es el balance de hoy. En un alta retroactiva son números distintos, y
    // guardar el de hoy en un campo que dice "a la conexión" es exactamente el
    // fallo que no da error: un dato plausible en el lugar equivocado.
    let saldoConexion: Awaited<ReturnType<typeof calcularSaldoALaFecha>> = null;
    if (mt5) {
      try {
        saldoConexion = await calcularSaldoALaFecha(companyId, mt5Account, fechaConexion);
        if (saldoConexion && !saldoConexion.exacto) {
          warnings.push(
            `Había ${saldoConexion.posicionesAbiertas} posición(es) abierta(s) al conectar: ` +
            `el equity de esa fecha era distinto del balance y MT5 no guarda el precio de ese ` +
            `momento. Se guardó el balance — editalo a mano si tenés el equity real.`,
          );
        }
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        warnings.push(`No se pudo reconstruir el saldo de la fecha de conexión: ${m}`);
      }
    }

    // ── 3. Guardar la cuenta ──────────────────────────────────────────────
    const { data: creada, error: insErr } = await admin
      .from('platform_liquidity_accounts')
      .insert({
        company_id: companyId,
        mt5_account: mt5Account,
        mt5_email: mt5?.email ?? null,
        mt5_group: mt5?.group ?? null,
        balance: mt5?.balance ?? 0,
        equity: mt5?.equity ?? 0,
        // Sin análisis se cuenta completo: para el pool, reservar de más es
        // seguro y reservar de menos no.
        balance_liquidez: analisis ? analisis.balanceLiquidez : (mt5?.balance ?? 0),
        // Reconstruido para la fecha de conexión. Si el cálculo falló queda
        // `null` —«no lo sabemos»— y no el balance de hoy, que sería mentira.
        balance_at_connection: saldoConexion ? saldoConexion.balance : null,
        // Sin posiciones abiertas, el equity de ese instante ES el balance. Con
        // posiciones abiertas no se puede reconstruir, así que se guarda el
        // balance y `connection_open_positions` deja constancia de por qué es
        // una aproximación.
        equity_at_connection: saldoConexion ? saldoConexion.balance : null,
        connection_open_positions: saldoConexion?.posicionesAbiertas ?? null,
        connection_values_manual: false,
        // El PnL se mide desde que la cuenta entró al pool, no desde que existe
        // en MT5. Por defecto eso es hoy; se puede fechar antes para dar de
        // alta una cuenta que ya venía operando.
        connection_date: fechaConexion.toISOString(),
        status: syncError ? 'error' : (mt5 && mt5.balance > 0 ? 'active' : 'inactive'),
        has_multiple_accounts_warning: analisis?.warning ?? false,
        related_account_ids: analisis?.previas.map((p) => p.id) ?? null,
        last_synced_at: new Date().toISOString(),
        sync_error: syncError,
        note: warnings.length > 0 ? warnings.join(' · ') : null,
        created_by: auth.userId,
      })
      .select('*')
      .single();
    if (insErr) return apiError('superadmin/liquidity/accounts POST', insErr, { status: 500 });

    // ── 4. Efectos sobre las cuentas viejas ───────────────────────────────
    // Best-effort: la cuenta nueva ya quedó guardada. Si algo de acá falla se
    // reporta, pero no se pierde el alta.
    if (analisis) {
      for (const d of analisis.aDesactivar) {
        const { error } = await admin
          .from('platform_liquidity_accounts')
          .update({
            status: 'inactive',
            deactivated_reason: d.reason,
            deactivated_at: new Date().toISOString(),
            superseded_by: creada.id,
            updated_at: new Date().toISOString(),
          })
          .eq('id', d.id);
        if (error) warnings.push(`No se pudo desactivar la cuenta previa: ${error.message}`);
      }
      for (const d of analisis.aDescontar) {
        const { error } = await admin
          .from('platform_liquidity_accounts')
          .update({ balance_liquidez: d.nuevoBalanceLiquidez, updated_at: new Date().toISOString() })
          .eq('id', d.id);
        if (error) warnings.push(`No se pudo descontar de la cuenta previa: ${error.message}`);
      }
      for (const t of analisis.transferencias) {
        const { error } = await admin.from('platform_liquidity_transfers').insert({
          from_account_id: t.fromAccountId,
          to_account_id: creada.id,
          amount: t.amount,
          detection_method: t.detectionMethod,
          detection_evidence: t.evidence,
        });
        if (error) warnings.push(`No se pudo registrar la transferencia: ${error.message}`);
      }
      // Escenario 4: las previas también quedan marcadas, para que el aviso se
      // vea desde cualquiera de las dos cuentas y no sólo desde la nueva.
      if (analisis.warning && analisis.previas.length > 0) {
        for (const p of analisis.previas) {
          await admin
            .from('platform_liquidity_accounts')
            .update({ has_multiple_accounts_warning: true, updated_at: new Date().toISOString() })
            .eq('id', p.id);
        }
      }
    }

    // ── 5. PnL mensual ────────────────────────────────────────────────────
    let meses = 0;
    if (mt5) {
      try {
        const pnl = await calculateMonthlyPnL(companyId, mt5Account, new Date(creada.connection_date));
        if (pnl.length > 0) {
          const { error } = await admin.from('platform_liquidity_monthly_pnl').upsert(
            pnl.map((m) => ({ account_id: creada.id, ...m })),
            { onConflict: 'account_id,year,month' },
          );
          if (error) warnings.push(`No se pudo guardar el PnL mensual: ${error.message}`);
          else meses = pnl.length;
        }
      } catch (err) {
        warnings.push(`No se pudo calcular el PnL: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return NextResponse.json({
      success: true,
      account: creada,
      escenario: analisis?.escenario ?? 'sin_analisis',
      monthsCalculated: meses,
      warnings,
    });
  } catch (err) {
    return apiError('superadmin/liquidity/accounts POST', err, { status: 500 });
  }
}
