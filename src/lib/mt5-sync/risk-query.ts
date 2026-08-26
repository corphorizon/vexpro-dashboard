// ─────────────────────────────────────────────────────────────────────────────
// Lectura del riesgo vivo para la pantalla.
//
// Lee SIEMPRE la foto más reciente del espejo, nunca MT5 en vivo: abrir el
// túnel tarda ~3,5 s y le costaría una conexión al broker por cada visita.
//
// ── EL DINERO NO SE SUMA ENTRE FAMILIAS ────────────────────────────────────
// Las cuentas Cent están en centavos y las PropFirm llevan capital virtual.
// Acá no se agrega nada de dinero: se devuelve por familia con su unidad y la
// pantalla lo muestra separado. Es la misma regla que en el resto del módulo.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ExposureRow {
  family: string;
  symbol: string;
  positions: number;
  accounts: number;
  long_lots: number | null;
  short_lots: number | null;
  net_lots: number | null;
  floating: number | null;
  storage: number | null;
  unit: 'cents' | 'account_currency';
  is_virtual: boolean;
}

export interface MarginRow {
  login: number;
  email: string | null;
  family: string;
  group_name: string | null;
  equity: number | null;
  balance: number | null;
  margin: number | null;
  margin_free: number | null;
  margin_level: number | null;
  floating: number | null;
  unit: 'cents' | 'account_currency';
  is_virtual: boolean;
}

/** Un símbolo con su peso dentro de la exposición total, para ver concentración. */
export interface SymbolConcentration {
  symbol: string;
  positions: number;
  /** Porcentaje de las posiciones abiertas totales. */
  share: number;
  netLots: number;
  /** Flotante desglosado por familia: NO se puede sumar entre ellas. */
  byFamily: Array<{ family: string; floating: number; unit: string; isVirtual: boolean }>;
}

export interface RiskSnapshot {
  snapshotAt: string | null;
  totalPositions: number;
  /** Cuentas reales con margen usado. */
  accountsWithMargin: number;
  /** Por debajo del 100%: ya no cubren su propio margen. */
  critical: MarginRow[];
  /** Entre 100% y 200%: un movimiento adverso las pone en crítico. */
  watch: MarginRow[];
  exposure: ExposureRow[];
  concentration: SymbolConcentration[];
}

const EXPOSURE_COLS =
  'family, symbol, positions, accounts, long_lots, short_lots, net_lots, floating, storage, unit, is_virtual';
const MARGIN_COLS =
  'login, email, family, group_name, equity, balance, margin, margin_free, margin_level, floating, unit, is_virtual';

/** Debajo de esto la cuenta ya no cubre su margen. */
const CRITICAL_LEVEL = 100;
/** Entre este y el crítico, vale la pena mirarla antes de que baje. */
const WATCH_LEVEL = 200;
/** Cuántos símbolos se muestran en la concentración. */
const TOP_SYMBOLS = 8;

export async function loadRiskSnapshot(
  admin: SupabaseClient,
  companyId: string,
): Promise<RiskSnapshot> {
  // La foto más reciente. Se busca primero su marca para no traer dos fotos
  // mezcladas si una corrida cae justo en medio de la lectura.
  const { data: last, error: lastErr } = await admin
    .from('mt5_exposure_snapshots')
    .select('snapshot_at')
    .eq('company_id', companyId)
    .order('snapshot_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastErr) throw new Error(lastErr.message);

  const snapshotAt = last?.snapshot_at ? String(last.snapshot_at) : null;
  if (!snapshotAt) {
    return {
      snapshotAt: null,
      totalPositions: 0,
      accountsWithMargin: 0,
      critical: [],
      watch: [],
      exposure: [],
      concentration: [],
    };
  }

  const [exp, mar] = await Promise.all([
    admin
      .from('mt5_exposure_snapshots')
      .select(EXPOSURE_COLS)
      .eq('company_id', companyId)
      .eq('snapshot_at', snapshotAt)
      .order('positions', { ascending: false }),
    admin
      .from('mt5_margin_risk_snapshots')
      .select(MARGIN_COLS)
      .eq('company_id', companyId)
      .eq('snapshot_at', snapshotAt)
      .order('margin_level', { ascending: true }),
  ]);
  if (exp.error) throw new Error(exp.error.message);
  if (mar.error) throw new Error(mar.error.message);

  const exposure = (exp.data ?? []) as unknown as ExposureRow[];
  const margins = (mar.data ?? []) as unknown as MarginRow[];

  const totalPositions = exposure.reduce((s, r) => s + r.positions, 0);

  // ── Concentración por símbolo ────────────────────────────────────────────
  // Las POSICIONES sí se pueden sumar entre familias: son conteos. El dinero
  // no, así que va desglosado.
  const bySymbol = new Map<string, SymbolConcentration>();
  for (const r of exposure) {
    const cur =
      bySymbol.get(r.symbol) ??
      { symbol: r.symbol, positions: 0, share: 0, netLots: 0, byFamily: [] };
    cur.positions += r.positions;
    cur.netLots += r.net_lots ?? 0;
    cur.byFamily.push({
      family: r.family,
      floating: r.floating ?? 0,
      unit: r.unit,
      isVirtual: r.is_virtual,
    });
    bySymbol.set(r.symbol, cur);
  }

  const concentration = [...bySymbol.values()]
    .map((c) => ({
      ...c,
      netLots: Math.round(c.netLots * 100) / 100,
      share: totalPositions > 0 ? Math.round((1000 * c.positions) / totalPositions) / 10 : 0,
    }))
    .sort((a, b) => b.positions - a.positions)
    .slice(0, TOP_SYMBOLS);

  // `margin_level = 0` significa "sin margen usado", no "en riesgo": se
  // excluye o la lista se llenaría de cuentas que no pueden liquidarse.
  const conNivel = margins.filter((m) => (m.margin_level ?? 0) > 0);

  return {
    snapshotAt,
    totalPositions,
    accountsWithMargin: margins.length,
    critical: conNivel.filter((m) => (m.margin_level ?? 0) < CRITICAL_LEVEL),
    watch: conNivel.filter(
      (m) => (m.margin_level ?? 0) >= CRITICAL_LEVEL && (m.margin_level ?? 0) < WATCH_LEVEL,
    ),
    exposure,
    concentration,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PNL por categoría de cuenta.
//
// ── POR QUÉ ESTO NO SE MEZCLA CON LA EXPOSICIÓN DE ARRIBA ──────────────────
// La exposición agrupa por FAMILIA (el segundo tramo del Group) y el PNL por
// CATEGORÍA (USD / CENT / PROPFIRM / BOOST), que no son lo mismo: `Copy` y
// `Broker` son familias distintas y las dos son USD. Son dos cortes del mismo
// universo y unificarlos obligaría a elegir uno, perdiendo el otro.
//
// Y hay una diferencia que importa más: el PNL sólo cuenta cuentas que están
// en el CRM, la exposición cuenta todas. Un total de PNL y uno de exposición
// NO tienen por qué cuadrar, y eso es correcto, no un error.
// ─────────────────────────────────────────────────────────────────────────────

export interface PnlRow {
  category: string;
  currency: string;
  snapshot_at: string;
  utc_day: string;
  open_positions: number;
  open_accounts: number;
  open_pnl: number | null;
  open_swap: number | null;
  closed_deals: number;
  closed_accounts: number;
  closed_pnl: number | null;
  closed_swap: number | null;
  closed_commission: number | null;
  accounts_outside_crm: number;
}

const PNL_COLS =
  'category, currency, snapshot_at, utc_day, open_positions, open_accounts, open_pnl, ' +
  'open_swap, closed_deals, closed_accounts, closed_pnl, closed_swap, closed_commission, ' +
  'accounts_outside_crm';

/** El PNL vivo: la foto más reciente, sea del día que sea. */
export async function loadPnlLive(
  admin: SupabaseClient,
  companyId: string,
): Promise<{ snapshotAt: string | null; rows: PnlRow[] }> {
  const { data: last, error: lastErr } = await admin
    .from('mt5_pnl_snapshots')
    .select('snapshot_at')
    .eq('company_id', companyId)
    .order('snapshot_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastErr) throw new Error(lastErr.message);

  const snapshotAt = last?.snapshot_at ? String(last.snapshot_at) : null;
  if (!snapshotAt) return { snapshotAt: null, rows: [] };

  // Se filtra por la marca exacta y no por "las últimas N filas": si una
  // corrida cae justo mientras se lee, un LIMIT devolvería categorías de dos
  // fotos distintas y el total sería de un instante que nunca existió.
  const { data, error } = await admin
    .from('mt5_pnl_snapshots')
    .select(PNL_COLS)
    .eq('company_id', companyId)
    .eq('snapshot_at', snapshotAt)
    .order('category', { ascending: true });
  if (error) throw new Error(error.message);

  return { snapshotAt, rows: (data ?? []) as unknown as PnlRow[] };
}

/**
 * El cierre de cada día en un rango, por categoría.
 *
 * `from` y `to` son días UTC inclusive (`YYYY-MM-DD`). El día en curso también
 * aparece, pero su cifra es "hasta ahora" y no un cierre: quien lo muestre
 * tiene que decirlo.
 */
export async function loadPnlHistory(
  admin: SupabaseClient,
  companyId: string,
  from: string,
  to: string,
): Promise<PnlRow[]> {
  const { data, error } = await admin
    .from('mt5_pnl_daily')
    .select(PNL_COLS)
    .eq('company_id', companyId)
    .gte('utc_day', from)
    .lte('utc_day', to)
    .order('utc_day', { ascending: false })
    .order('category', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as PnlRow[];
}
