// ─────────────────────────────────────────────────────────────────────────────
// La lectura del cierre diario del CRM (`crm_daily_pnl`).
//
// UNA SOLA PUERTA: la consumen la pantalla (/api/admin/crm-daily-pnl) y los
// tres reportes por correo. El día que el criterio de "acumulado del rango"
// cambie, cambia acá y en ningún otro lado — dos sumas del mismo número que se
// separan en silencio son el modo de falla número uno de este repo.
//
// ── LOS HUECOS VIAJAN CON EL TOTAL ─────────────────────────────────────────
// `daysMissing` no es decoración: un acumulado de siete días construido con
// cinco es un número más chico y perfectamente creíble. Quien muestre el total
// tiene que poder decir sobre cuántos días se calculó.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { round2 } from '@/lib/utils';
import { missingDays, type CrmDailyPnlCategoryTotals } from './daily-pnl';

export interface CrmDailyPnlRow {
  utc_day: string;
  /** PNL del CLIENTE. Negativo = ganó el bróker. `null` = no se pudo calcular. */
  pnl_usd: number | null;
  volume_lots: number;
  deals_count: number;
  accounts_count: number;
  unmatched_accounts: number;
  unmatched_deals: number;
  unmatched_raw_pnl: number;
  detail: { by_category?: CrmDailyPnlCategoryTotals[] } | null;
  computed_at: string;
}

export interface CrmDailyPnlSeries {
  range: { from: string; to: string };
  rows: CrmDailyPnlRow[];
  /** Días del rango sin fila. Hueco ≠ cero. */
  daysMissing: string[];
  totals: {
    /** Suma del PNL del cliente en el rango. `null` si no hay ni un día. */
    clientsPnl: number | null;
    /** Lo mismo con el signo del bróker: positivo = ganó el bróker. */
    brokerPnl: number | null;
    volumeLots: number;
    dealsCount: number;
    daysWithData: number;
    /** Cuentas excluidas del dinero (sin factor de centavos conocido). */
    unmatchedAccounts: number;
  };
  /** La última fila del rango: "cómo cerró el último día que tenemos". */
  last: CrmDailyPnlRow | null;
}

const SELECT_COLS =
  'utc_day, pnl_usd, volume_lots, deals_count, accounts_count, unmatched_accounts, unmatched_deals, unmatched_raw_pnl, detail, computed_at';

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * La serie diaria del rango, con su acumulado.
 *
 * `.eq('company_id', …)` explícito y no opcional: con el admin client RLS no
 * aplica y esta es la única defensa multi-tenant que queda.
 */
export async function loadCrmDailyPnl(
  admin: SupabaseClient,
  companyId: string,
  from: string,
  to: string,
): Promise<CrmDailyPnlSeries> {
  const { data, error } = await admin
    .from('crm_daily_pnl')
    .select(SELECT_COLS)
    .eq('company_id', companyId)
    .gte('utc_day', from)
    .lte('utc_day', to)
    .order('utc_day', { ascending: true });
  if (error) throw new Error(`crm_daily_pnl: ${error.message}`);

  const rows: CrmDailyPnlRow[] = (data ?? []).map((r) => {
    const raw = r as Record<string, unknown>;
    return {
      utc_day: String(raw.utc_day),
      // null y 0 son datos distintos: un día que no se pudo calcular no es un
      // día que cerró plano. Se preserva el null hasta la pantalla.
      pnl_usd: raw.pnl_usd === null || raw.pnl_usd === undefined ? null : num(raw.pnl_usd),
      volume_lots: num(raw.volume_lots),
      deals_count: num(raw.deals_count),
      accounts_count: num(raw.accounts_count),
      unmatched_accounts: num(raw.unmatched_accounts),
      unmatched_deals: num(raw.unmatched_deals),
      unmatched_raw_pnl: num(raw.unmatched_raw_pnl),
      detail: (raw.detail as CrmDailyPnlRow['detail']) ?? null,
      computed_at: String(raw.computed_at ?? ''),
    };
  });

  return { ...summarizeCrmDailyPnl(rows, from, to) };
}

/**
 * El resumen de una serie ya cargada. Separado de la consulta para poder
 * testear la suma —y sobre todo el trato de los huecos— sin base de datos.
 */
export function summarizeCrmDailyPnl(
  rows: readonly CrmDailyPnlRow[],
  from: string,
  to: string,
): CrmDailyPnlSeries {
  const conPnl = rows.filter((r) => r.pnl_usd !== null);
  const clientsPnl =
    conPnl.length === 0 ? null : round2(conPnl.reduce((s, r) => s + (r.pnl_usd ?? 0), 0));

  return {
    range: { from, to },
    rows: [...rows],
    daysMissing: missingDays(from, to, rows.map((r) => r.utc_day)),
    totals: {
      clientsPnl,
      brokerPnl: clientsPnl === null ? null : round2(-clientsPnl),
      volumeLots: round2(rows.reduce((s, r) => s + r.volume_lots, 0)),
      dealsCount: rows.reduce((s, r) => s + r.deals_count, 0),
      daysWithData: conPnl.length,
      unmatchedAccounts: rows.reduce((s, r) => s + r.unmatched_accounts, 0),
    },
    last: rows.length === 0 ? null : rows[rows.length - 1],
  };
}
