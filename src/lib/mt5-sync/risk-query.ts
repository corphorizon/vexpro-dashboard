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
