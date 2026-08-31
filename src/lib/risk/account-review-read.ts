// ─────────────────────────────────────────────────────────────────────────────
// Lectura del diagnóstico operativo para la ficha de un retiro.
//
// Lee del espejo (`mt5_account_review`) — nunca de MT5. La ficha es una
// pantalla, y abrir el túnel al broker desde una pantalla es exactamente lo que
// el repo prohíbe: cuesta ~3,5 s y sería una conexión por visita.
//
// ── LO ÚNICO QUE SE CALCULA AL LEER ────────────────────────────────────────
// «¿Operó DESPUÉS de pedir el retiro?». Depende del retiro, no de la cuenta, y
// se resuelve comparando `last_trade_at` contra `requested_at`. Es exacto y
// gratis; guardarlo por (cuenta × retiro) multiplicaría las filas sin agregar
// información.
//
// ── EL RIESGO DEL CONJUNTO ES EL PEOR DE SUS CUENTAS ───────────────────────
// Y no el promedio: un cliente con cinco cuentas limpias y una que opera con un
// robot sincronizado tiene un problema en esa una. Promediar lo escondería —
// que es justo lo contrario de para qué existe esta pantalla.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { tradedAfterRequest, type AccountRisk, type AccountSignal } from '@/lib/risk/account-review';
import type { Origen, Ejecucion, SenalToxica, NivelToxico } from '@/lib/risk/broker-toxicity';

export interface AccountReviewRow {
  login: number;
  accountType: string | null;
  groupName: string | null;
  positions: number;
  firstTradeAt: string | null;
  lastTradeAt: string | null;
  netResult: number | null;
  avgDurationSec: number | null;
  under1min: number;
  under5min: number;
  won: number;
  lost: number;
  lotsTotal: number | null;
  maxDrawdown: number | null;
  topSymbols: Array<{ symbol: string; positions: number; profit: number }>;
  /** Reparto por tramo de duracion. Separa "hace scalping" de "gana scalpeando". */
  durations: Array<{ label: string; count: number; profit: number }>;
  signals: AccountSignal[];
  flagged: number;
  unverifiable: number;
  risk: AccountRisk;
  truncated: boolean;
  warnings: string[];
  computedAt: string | null;
  /**
   * `true` = abrió operaciones después de pedir el retiro.
   * `null` = no se sabe (falta la fecha de la última operación o la del retiro).
   * «No lo sabemos» y «no operó» son cosas distintas.
   */
  tradedAfterRequest: boolean | null;

  // ── Toxicidad hacia el bróker ─────────────────────────────────────────────
  // Eje SEPARADO de `risk`. Aquél dice cómo opera el cliente —martingala, grid,
  // duraciones—; éste dice cuánto le cuesta la operativa a la casa. Una cuenta
  // puede ser riesgo alto para el cliente y cero tóxica para el bróker, y al
  // revés. Todo `null` si el diagnóstico se calculó antes de la migración 107.
  origen: Origen | null;
  ejecucion: Ejecucion | null;
  toxicSignals: SenalToxica[];
  toxicLevel: NivelToxico | null;
  toxicFlagged: number;
}

export interface AccountsOverview {
  accounts: AccountReviewRow[];
  /** El peor riesgo entre las cuentas. Ver la cabecera. */
  risk: AccountRisk;
  /** Cuántas cuentas están en `alto`. */
  highRiskAccounts: number;
  /** Suma de señales disparadas en todas las cuentas. */
  totalFlagged: number;
  /** Cuántas cuentas operaron después de la solicitud. */
  tradedAfterRequestCount: number;
  /** Cuenta con diagnóstico más viejo — la ficha lo muestra como «datos de». */
  oldestComputedAt: string | null;
  /**
   * `true` cuando el cliente tiene cuentas pero ninguna fue calculada todavía.
   * La ficha tiene que decirlo: «sin señales» y «sin calcular» se ven iguales
   * en una pantalla vacía y significan cosas opuestas.
   */
  pending: boolean;
}

const ORDEN: Record<AccountRisk, number> = { ok: 0, medio: 1, alto: 2 };

/**
 * Diagnóstico de todas las cuentas del cliente de un retiro.
 *
 * `requestedAt` se usa sólo para resolver «operó después de solicitar».
 */
export async function loadAccountsOverview(
  admin: SupabaseClient,
  companyId: string,
  userExternalId: string | null,
  requestedAt: string | null,
): Promise<AccountsOverview> {
  const vacio: AccountsOverview = {
    accounts: [], risk: 'ok', highRiskAccounts: 0, totalFlagged: 0,
    tradedAfterRequestCount: 0, oldestComputedAt: null, pending: false,
  };
  if (!userExternalId) return vacio;

  // El filtro por company_id va SIEMPRE: con el admin client no hay RLS que
  // cubra, y nunca se confía en que el id externo sea único entre empresas.
  const { data, error } = await admin
    .from('mt5_account_review')
    .select('*')
    .eq('company_id', companyId)
    .eq('user_external_id', userExternalId)
    .order('risk', { ascending: false })
    .order('positions', { ascending: false });
  if (error) throw new Error(`mt5_account_review: ${error.message}`);

  const filas = data ?? [];
  if (filas.length === 0) {
    // No distinguimos acá si el cliente no tiene cuentas o si el cron todavía
    // no llegó: eso lo resuelve el llamador, que sí sabe cuántas cuentas hay.
    return vacio;
  }

  const accounts: AccountReviewRow[] = filas.map((r) => ({
    login: Number(r.login),
    accountType: r.account_type ?? null,
    groupName: r.group_name ?? null,
    positions: Number(r.positions ?? 0),
    firstTradeAt: r.first_trade_at ?? null,
    lastTradeAt: r.last_trade_at ?? null,
    netResult: r.net_result === null || r.net_result === undefined ? null : Number(r.net_result),
    avgDurationSec: r.avg_duration_sec === null || r.avg_duration_sec === undefined ? null : Number(r.avg_duration_sec),
    under1min: Number(r.under_1min ?? 0),
    under5min: Number(r.under_5min ?? 0),
    won: Number(r.won ?? 0),
    lost: Number(r.lost ?? 0),
    lotsTotal: r.lots_total === null || r.lots_total === undefined ? null : Number(r.lots_total),
    maxDrawdown: r.max_drawdown === null || r.max_drawdown === undefined ? null : Number(r.max_drawdown),
    topSymbols: Array.isArray(r.top_symbols) ? r.top_symbols : [],
    durations: Array.isArray(r.durations) ? r.durations : [],
    signals: Array.isArray(r.checks) ? r.checks : [],
    flagged: Number(r.violations ?? 0),
    unverifiable: Number(r.unverifiable ?? 0),
    risk: (r.risk ?? 'ok') as AccountRisk,
    truncated: Boolean(r.truncated),
    warnings: Array.isArray(r.warnings) ? r.warnings : [],
    computedAt: r.computed_at ?? null,
    tradedAfterRequest: tradedAfterRequest(r.last_trade_at ?? null, requestedAt),
    // Los diagnósticos anteriores a la migración 107 no traen nada de esto.
    // Quedan en `null` —«no se calculó»— y la pantalla lo dice, en vez de
    // mostrar ceros que se leerían como «no hay toxicidad».
    origen: (r.origen ?? null) as Origen | null,
    ejecucion: (r.ejecucion ?? null) as Ejecucion | null,
    toxicSignals: Array.isArray(r.toxic_signals) ? r.toxic_signals : [],
    toxicLevel: (r.toxic_level ?? null) as NivelToxico | null,
    toxicFlagged: Number(r.toxic_flagged ?? 0),
  }));

  // El peor manda. Ver la cabecera.
  const risk = accounts.reduce<AccountRisk>(
    (peor, a) => (ORDEN[a.risk] > ORDEN[peor] ? a.risk : peor),
    'ok',
  );
  const computados = accounts.map((a) => a.computedAt).filter((v): v is string => Boolean(v)).sort();

  return {
    accounts,
    risk,
    highRiskAccounts: accounts.filter((a) => a.risk === 'alto').length,
    totalFlagged: accounts.reduce((s, a) => s + a.flagged, 0),
    tradedAfterRequestCount: accounts.filter((a) => a.tradedAfterRequest === true).length,
    oldestComputedAt: computados[0] ?? null,
    pending: false,
  };
}
