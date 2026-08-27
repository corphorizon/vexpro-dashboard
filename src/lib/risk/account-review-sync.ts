// ─────────────────────────────────────────────────────────────────────────────
// Espejo del diagnóstico operativo por cuenta.
//
// ── EL ALCANCE: LAS CUENTAS DE QUIEN PIDIÓ UN RETIRO INSTANTÁNEO ───────────
// Arrancamos por ahí a pedido de Stiven (2026-08-27), y la razón es la misma
// que separa esa pestaña en la cola: en un instantáneo el dinero YA SALIÓ sin
// que nadie lo mirara. Saber cómo opera ese cliente es lo único que queda por
// hacer, y hoy no se ve en ningún lado.
//
// Se miran las cuentas de tipo BROKER (trading) y SOCIAL. Las FUNDING quedan
// fuera a propósito: son prop firm y ya tienen su propia revisión, con su
// reglamento y su ciclo — pasarles ADEMÁS estas señales sería contar dos veces
// lo mismo con dos vocabularios distintos.
//
// ── POR QUÉ NO SE HACE AL ABRIR LA FICHA ───────────────────────────────────
// Porque abrir el túnel a MT5 cuesta ~3,5 s y emparejar posiciones por
// `PositionID` —que NO está en el índice— cuesta ~0,28 s por cuenta (medido:
// 60 cuentas en 16,7 s, ver mt5-sync/behavior.ts). Con 595 cuentas serían ~166
// s. La regla del repo es explícita: nunca se consulta MT5 en vivo desde una
// pantalla. Se espeja y la ficha lee del espejo.
//
// ── LA ROTACIÓN ────────────────────────────────────────────────────────────
// No entran todas en una corrida, así que cada una toma un lote ordenado por
// antigüedad del cálculo, las nunca-calculadas primero. Con MAX_POR_CORRIDA =
// 200 y el cron cada 30 minutos, las ~600 cuentas convergen en hora y media y
// después se mantienen solas.
//
// El techo NO es silencioso: `skipped` viaja en el resultado. Un recorte que no
// se cuenta es indistinguible de «ya estaban todas al día».
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  loadTradesByLogin,
  evaluateAccount,
  MAX_POSICIONES,
  type AccountReview,
} from '@/lib/risk/account-review';
import type { Trade } from '@/lib/risk/types';

/** Cuántos logins van en cada consulta a MT5. */
export const LOGIN_BATCH = 40;
/** Techo por corrida. Ver la cabecera: el costo es lineal en cuentas. */
export const MAX_POR_CORRIDA = 200;
/** Tipos de cuenta que entran. FUNDING queda fuera (tiene su propio módulo). */
export const TIPOS = ['BROKER', 'SOCIAL'] as const;

export interface AccountReviewSyncResult {
  candidates: number;
  reviewed: number;
  skipped: number;
  failed: number;
  elapsedMs: number;
  warnings: string[];
}

interface CuentaCandidata {
  login: number;
  user_external_id: string | null;
  email: string | null;
  account_type: string | null;
  group_name: string | null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Lee todas las páginas de una consulta.
 *
 * PostgREST corta en 1.000 filas EN SILENCIO. Sin esto se miraría siempre el
 * mismo primer millar de cuentas y la rotación no rotaría nada.
 */
async function fetchAll<T>(
  // El builder de PostgREST es un thenable, no una Promise: PromiseLike es lo
  // que acepta a los dos sin castear en cada call site.
  run: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let desde = 0; ; desde += PAGE) {
    const { data, error } = await run(desde, desde + PAGE - 1);
    if (error) throw new Error(error.message);
    const filas = data ?? [];
    out.push(...filas);
    if (filas.length < PAGE) break;
  }
  return out;
}

/**
 * Calcula (o recalcula) el diagnóstico de las cuentas de los clientes que
 * pidieron retiros instantáneos.
 *
 * `noticias` es opcional y se pasa entera: la señal de calendario se resuelve
 * por cuenta contra la misma lista. Sin ella, esa señal queda «no comprobada»
 * en vez de darse por cumplida.
 */
export async function syncAccountReviews(
  admin: SupabaseClient,
  companyId: string,
  opts: {
    noticias?: Array<{ at: number; name: string; currency: string | null }> | null;
    instantFee?: number;
  } = {},
): Promise<AccountReviewSyncResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const instantFee = opts.instantFee ?? 5;

  // ── 1. Los clientes con retiro instantáneo ──────────────────────────────
  const retiros = await fetchAll<{ user_external_id: string | null }>((d, h) =>
    admin
      .from('crm_withdrawals')
      .select('user_external_id')
      .eq('company_id', companyId)
      .eq('fee', instantFee)
      .not('user_external_id', 'is', null)
      .order('requested_at', { ascending: false })
      .range(d, h),
  );
  const usuarios = [...new Set(retiros.map((r) => r.user_external_id).filter(Boolean))] as string[];
  if (usuarios.length === 0) {
    return { candidates: 0, reviewed: 0, skipped: 0, failed: 0, elapsedMs: Date.now() - started, warnings };
  }

  // ── 2. Sus cuentas de trading y sociales ────────────────────────────────
  // El `in(...)` de PostgREST viaja en la URL, así que va por lotes.
  const cuentas: CuentaCandidata[] = [];
  for (const lote of chunk(usuarios, 300)) {
    const filas = await fetchAll<CuentaCandidata>((d, h) =>
      admin
        .from('crm_trading_accounts')
        .select('login, user_external_id, email, account_type, group_name')
        .eq('company_id', companyId)
        .in('user_external_id', lote)
        .in('account_type', TIPOS as unknown as string[])
        .range(d, h),
    );
    cuentas.push(...filas);
  }
  const porLogin = new Map<number, CuentaCandidata>();
  for (const c of cuentas) {
    const n = Number(c.login);
    if (Number.isFinite(n) && n > 0) porLogin.set(n, c);
  }
  if (porLogin.size === 0) {
    return { candidates: 0, reviewed: 0, skipped: 0, failed: 0, elapsedMs: Date.now() - started, warnings };
  }

  // ── 3. Rotación: las nunca calculadas primero, después las más viejas ───
  const yaCalculadas = await fetchAll<{ login: number; computed_at: string }>((d, h) =>
    admin
      .from('mt5_account_review')
      .select('login, computed_at')
      .eq('company_id', companyId)
      .range(d, h),
  );
  const calculadoEn = new Map<number, string>();
  for (const r of yaCalculadas) calculadoEn.set(Number(r.login), r.computed_at);

  const orden = [...porLogin.keys()].sort((a, b) => {
    // La cadena vacía ordena antes que cualquier fecha: nunca-calculada primero.
    const ca = calculadoEn.get(a) ?? '';
    const cb = calculadoEn.get(b) ?? '';
    return ca.localeCompare(cb);
  });
  const tanda = orden.slice(0, MAX_POR_CORRIDA);
  const skipped = orden.length - tanda.length;
  if (skipped > 0) {
    warnings.push(
      `Quedaron ${skipped} cuenta(s) para la próxima corrida (techo de ${MAX_POR_CORRIDA}).`,
    );
  }

  // ── 4. Traer operaciones y evaluar ──────────────────────────────────────
  let reviewed = 0;
  let failed = 0;
  const ahora = new Date().toISOString();

  for (const lote of chunk(tanda, LOGIN_BATCH)) {
    let porCuenta: Map<number, Trade[]>;
    try {
      porCuenta = await loadTradesByLogin(companyId, lote);
    } catch (err) {
      // Un lote que falla no tira la corrida entera: las demás cuentas siguen.
      failed += lote.length;
      warnings.push(`Lote de ${lote.length} cuenta(s) falló: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const filas = lote.map((login) => {
      const meta = porLogin.get(login)!;
      const trades = porCuenta.get(login) ?? [];
      const truncated = trades.length >= MAX_POSICIONES;
      const rev: AccountReview = evaluateAccount(login, trades, {
        noticias: opts.noticias ?? null,
        // La detección de copia necesita las aperturas de TODAS las cuentas del
        // período y hoy vive en el módulo de prop firm. Se deja sin comprobar
        // a propósito en vez de darla por limpia.
        sincronizadas: null,
        truncated,
      });
      return {
        company_id: companyId,
        login,
        user_external_id: meta.user_external_id,
        email: meta.email,
        account_type: meta.account_type,
        group_name: meta.group_name,
        positions: rev.facts.positions,
        first_trade_at: rev.facts.firstTradeAt?.toISOString() ?? null,
        last_trade_at: rev.facts.lastTradeAt?.toISOString() ?? null,
        net_result: rev.facts.netResult,
        avg_duration_sec: rev.facts.avgDurationSec,
        under_1min: rev.facts.under1min,
        under_5min: rev.facts.under5min,
        won: rev.facts.won,
        lost: rev.facts.lost,
        lots_total: rev.facts.lotsTotal,
        max_drawdown: rev.facts.maxDrawdown,
        top_symbols: rev.facts.topSymbols,
        checks: rev.signals,
        violations: rev.flagged,
        unverifiable: rev.unverifiable,
        risk: rev.risk,
        computed_at: ahora,
        truncated: rev.truncated,
        warnings: rev.warnings,
      };
    });

    const { error } = await admin
      .from('mt5_account_review')
      .upsert(filas, { onConflict: 'company_id,login' });
    if (error) {
      failed += filas.length;
      warnings.push(`mt5_account_review: ${error.message}`);
      continue;
    }
    reviewed += filas.length;
  }

  return {
    candidates: orden.length,
    reviewed,
    skipped,
    failed,
    elapsedMs: Date.now() - started,
    warnings,
  };
}
