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
import { leerCuentaEnSesion, type Mt5AccountInfo } from '@/lib/liquidity/mt5-account';
import { analizarCuentaNueva } from '@/lib/liquidity/duplicate-account-detector';
import { pnlMensualEnSesion, type MonthlyPnl } from '@/lib/liquidity/monthly-pnl-calculator';
import { validarFechaConexion } from '@/lib/liquidity/connection-date';
import { saldoALaFechaEnSesion, type SaldoALaFecha } from '@/lib/liquidity/connection-snapshot';
import { withMt5Connection } from '@/lib/api-integrations/mt5-sql/client';

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

    // ── 1. MT5, TODO EN UNA SOLA CONEXIÓN ─────────────────────────────────
    //
    // Las tres lecturas —datos de la cuenta, saldo a la fecha de conexión y PnL
    // mes a mes— comparten sesión. Cada `withMt5Connection` levanta su propio
    // túnel SOCKS, y ahí está el costo real: medido contra la cuenta 146059,
    // 4.248 + 4.988 + 4.017 ms para consultas que no llegan al segundo. Con una
    // sola conexión eso baja a ~5 s.
    //
    // Ninguna de las tres depende del análisis de duplicados, así que Mongo
    // queda afuera de la sesión y corre después (246 ms medidos).
    // Los tres resultados se DEVUELVEN de la sesión en vez de asignarse a
    // variables de afuera: TypeScript no sigue las asignaciones hechas dentro
    // de un callback, y con `let` de afuera terminaba tipando todo como `never`.
    interface LecturaMt5 {
      cuenta: Mt5AccountInfo | null;
      saldo: SaldoALaFecha | null;
      pnl: MonthlyPnl[];
    }

    let lectura: LecturaMt5 | null = null;
    let syncError: string | null = null;

    try {
      lectura = await withMt5Connection<LecturaMt5>(companyId, async (s) => {
        const cuenta = await leerCuentaEnSesion(s, Number(mt5Account));
        // Sin cuenta no tiene sentido seguir consultando: se corta la lectura y
        // el 404 se arma afuera, con la conexión ya cerrada.
        if (!cuenta) return { cuenta: null, saldo: null, pnl: [] };
        return {
          cuenta,
          saldo: await saldoALaFechaEnSesion(s, mt5Account, fechaConexion),
          pnl: await pnlMensualEnSesion(s, mt5Account, fechaConexion),
        };
      });
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err);
      warnings.push(`No se pudo leer MT5: ${syncError}. La cuenta se guardó sin datos — refrescar a mano.`);
    }

    // `lectura && !lectura.cuenta` es «MT5 respondió y la cuenta no está».
    // Distinto de `lectura === null`, que es «MT5 no respondió» y sí se guarda.
    if (lectura && !lectura.cuenta) {
      return NextResponse.json(
        { success: false, error: `La cuenta ${mt5Account} no existe en MT5.` },
        { status: 404 },
      );
    }

    const mt5 = lectura?.cuenta ?? null;
    const saldoConexion = lectura?.saldo ?? null;
    const pnlMeses = lectura?.pnl ?? [];

    if (saldoConexion && !saldoConexion.exacto) {
      warnings.push(
        `Había ${saldoConexion.posicionesAbiertas} posición(es) abierta(s) al conectar: ` +
        `el equity de esa fecha era distinto del balance y MT5 no guarda el precio de ese ` +
        `momento. Se guardó el balance — editalo a mano si tenés el equity real.`,
      );
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

    // ── 5. Guardar el PnL mensual ─────────────────────────────────────────
    // Ya está calculado: salió de la misma sesión del paso 1. Acá sólo se
    // escribe, así que no hay ninguna vuelta más a MT5.
    let meses = 0;
    if (pnlMeses.length > 0) {
      const { error } = await admin.from('platform_liquidity_monthly_pnl').upsert(
        pnlMeses.map((m) => ({ account_id: creada.id, ...m })),
        { onConflict: 'account_id,year,month' },
      );
      if (error) warnings.push(`No se pudo guardar el PnL mensual: ${error.message}`);
      else meses = pnlMeses.length;
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
