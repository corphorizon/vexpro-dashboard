// ─────────────────────────────────────────────────────────────────────────────
// Dónde está el dinero — contrato compartido.
//
// Balances dejó de ser "cuánto tengo" para responder también "dónde está y de
// quién es". Cada ubicación es un lugar con plata de la empresa: una wallet,
// un banco, efectivo, una cuenta de trading, una pasarela con API, o alguien
// a quien se le prestó.
//
// LA DISTINCIÓN QUE IMPORTA: LÍQUIDO vs PRESTADO.
// Lo prestado ES plata de la empresa, pero no se puede usar mañana. Sumarlo al
// disponible haría creer que hay caja donde no la hay; ignorarlo haría creer
// que la empresa vale menos de lo que vale. Por eso se cuenta aparte y se
// muestra aparte.
//
// Import-safe desde cliente y servidor: no toca Supabase ni React.
// ─────────────────────────────────────────────────────────────────────────────

export const LOCATION_TYPES = ['gateway', 'wallet', 'bank', 'cash', 'trading', 'loan'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const DEFAULT_LOCATION_TYPE: LocationType = 'wallet';

export function isLocationType(v: unknown): v is LocationType {
  return typeof v === 'string' && (LOCATION_TYPES as readonly string[]).includes(v);
}

export function normalizeLocationType(v: unknown): LocationType {
  return isLocationType(v) ? v : DEFAULT_LOCATION_TYPE;
}

export const LOCATION_TYPE_LABELS: Record<LocationType, { es: string; en: string }> = {
  gateway: { es: 'Pasarela de pago', en: 'Payment gateway' },
  wallet:  { es: 'Wallet',            en: 'Wallet' },
  bank:    { es: 'Cuenta bancaria',   en: 'Bank account' },
  cash:    { es: 'Efectivo',          en: 'Cash' },
  trading: { es: 'Cuenta de trading', en: 'Trading account' },
  loan:    { es: 'Prestado a',        en: 'Lent to' },
};

/**
 * Plata que se puede usar mañana. Un préstamo es patrimonio, no liquidez: la
 * cuenta de trading tampoco (hay que cerrar posiciones y esperar el retiro),
 * pero se cuenta como líquida porque es dinero propio disponible a la vista
 * — la diferencia con un préstamo es que no depende de que un tercero pague.
 */
export function isLiquid(type: unknown): boolean {
  return normalizeLocationType(type) !== 'loan';
}

/** Solo estas ubicaciones se sincronizan solas; el resto se carga a mano. */
export function isAutomatic(type: unknown): boolean {
  return normalizeLocationType(type) === 'gateway';
}

export interface BusinessUnit {
  id: string;
  company_id: string;
  name: string;
  /** Su saldo entra en el fondo general (el "ahorro real"). */
  counts_to_fund: boolean;
  is_active: boolean;
  sort_order: number;
}

/** Una unidad dueña de una ubicación y en qué proporción (0..1). */
export interface UnitShare {
  business_unit_id: string;
  share: number;
}

export interface CashLocation {
  /** Clave del libro: la misma que usa channel_ledger_entries. */
  channel_key: string;
  label: string;
  location_type: LocationType;
  business_unit_id: string | null;
  /**
   * Reparto entre varias unidades (migración 071). Vacío o ausente = manda
   * `business_unit_id`, que es como quedaron todas las ubicaciones viejas.
   */
  unit_shares?: UnitShare[] | null;
  /** Para 'loan', a quién se le prestó; para 'bank', el banco. */
  holder: string | null;
  is_visible: boolean;
  /** Propia del usuario: solo estas se pueden eliminar (las base se archivan). */
  is_custom?: boolean;
  sort_order: number;
  /** Saldo actual del libro de esa ubicación. */
  balance: number;
}

export interface CashSummary {
  /** Disponible: todo menos lo prestado. */
  liquid: number;
  /** Plata de la empresa en manos de terceros. */
  lent: number;
  /** liquid + lent — el patrimonio en efectivo. */
  total: number;
  /** Saldo de las unidades marcadas como parte del fondo (el ahorro real). */
  fund: number;
  /** Saldo de las unidades que se llevan aparte. */
  outsideFund: number;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Cómo se reparte una ubicación entre sus unidades dueñas. Siempre devuelve
 * partes que suman exactamente 1, porque de eso depende que el desglose por
 * unidad cierre contra el total.
 *
 * · Sin filas de reparto manda `business_unit_id` (compatibilidad).
 * · Si las partes se pasan del 100% se normalizan: si no, el desglose sumaría
 *   más plata de la que hay.
 * · Si les falta para el 100%, el resto queda sin unidad en vez de repartirse
 *   solo — durante una reasignación hay estados intermedios y esa plata tiene
 *   que seguir viéndose en algún lado.
 */
export function allocateShares(loc: CashLocation): Array<{ unitId: string | null; share: number }> {
  const rows = (loc.unit_shares ?? [])
    .filter((r) => r && r.business_unit_id && Number(r.share) > 0)
    .map((r) => ({ unitId: r.business_unit_id as string | null, share: Number(r.share) }));

  if (rows.length === 0) return [{ unitId: loc.business_unit_id ?? null, share: 1 }];

  const sum = rows.reduce((s, r) => s + r.share, 0);
  if (sum > 1) return rows.map((r) => ({ unitId: r.unitId, share: r.share / sum }));

  const rest = 1 - sum;
  return rest > 1e-9 ? [...rows, { unitId: null, share: rest }] : rows;
}

/** Suma cruda de las partes cargadas — la UI avisa cuando no da 1. */
export function sharesTotal(shares: UnitShare[] | null | undefined): number {
  return (shares ?? []).reduce((s, r) => s + (Number(r.share) || 0), 0);
}

/**
 * Unidad PRINCIPAL de una ubicación = la de MAYOR parte.
 *
 * `channel_configs.business_unit_id` sigue siendo el fallback que leen las
 * pantallas que no saben del reparto (migración 071), así que cuál se guarda
 * ahí no es cosmético. Tomar la primera del array (auditoría 2026-08, A5) hacía
 * que una wallet 30/70 quedara registrada bajo la unidad del 30% solo porque
 * era la fila que el usuario había cargado primero.
 *
 * Empate → la primera, que es un orden estable y tan bueno como cualquiera.
 */
export function primaryUnitId(shares: UnitShare[] | null | undefined): string | null {
  let best: UnitShare | null = null;
  for (const s of shares ?? []) {
    if (!s?.business_unit_id) continue;
    if (!best || (Number(s.share) || 0) > (Number(best.share) || 0)) best = s;
  }
  return best?.business_unit_id ?? null;
}

/**
 * Qué proporción (0..1) de una ubicación le corresponde a una unidad.
 *
 * Misma normalización que `allocateShares` —si las partes cargadas suman más
 * de 1 se prorratean— para que el libro por unidad y el desglose de /balances
 * no puedan discrepar. Sin filas de reparto manda `channel_configs`.
 */
export function unitShareOfLocation(
  businessUnitId: string,
  shares: Array<{ business_unit_id: string; share: number }> | null | undefined,
  fallbackUnitId: string | null,
): number {
  const rows = (shares ?? [])
    .filter((r) => r && r.business_unit_id && Number(r.share) > 0)
    .map((r) => ({ business_unit_id: r.business_unit_id, share: Number(r.share) }));

  if (rows.length === 0) return fallbackUnitId === businessUnitId ? 1 : 0;

  const sum = rows.reduce((s, r) => s + r.share, 0);
  const mine = rows.find((r) => r.business_unit_id === businessUnitId);
  if (!mine) return 0;
  return sum > 1 ? mine.share / sum : mine.share;
}

/**
 * Ubicaciones de una unidad de negocio, con la parte que le toca de cada una.
 *
 * POR QUÉ (auditoría 2026-08, A5): el libro por unidad resolvía sus canales
 * SOLO por `channel_configs.business_unit_id`. Con una wallet repartida 50/50
 * la unidad "principal" veía el 100% del saldo y la otra no la veía en
 * absoluto: dos pantallas mintiendo en direcciones opuestas sobre la misma
 * plata. Acá se unen las dos fuentes (dedup por channel_key) y se devuelve la
 * proporción, que es lo que faltaba para poder mostrar la verdad.
 */
export function unitLocationShares(
  businessUnitId: string,
  configRows: Array<{ channel_key: string; business_unit_id: string | null }>,
  shareRows: Array<{ channel_key: string; business_unit_id: string; share: number }>,
): Map<string, number> {
  const sharesByKey = new Map<string, Array<{ business_unit_id: string; share: number }>>();
  for (const r of shareRows) {
    if (!r?.channel_key || !r.business_unit_id) continue;
    const arr = sharesByKey.get(r.channel_key);
    const entry = { business_unit_id: r.business_unit_id, share: Number(r.share) || 0 };
    if (arr) arr.push(entry);
    else sharesByKey.set(r.channel_key, [entry]);
  }

  const fallbackByKey = new Map<string, string | null>();
  for (const r of configRows) {
    if (r?.channel_key) fallbackByKey.set(r.channel_key, r.business_unit_id ?? null);
  }

  const out = new Map<string, number>();
  for (const key of new Set([...sharesByKey.keys(), ...fallbackByKey.keys()])) {
    const share = unitShareOfLocation(
      businessUnitId,
      sharesByKey.get(key),
      fallbackByKey.get(key) ?? null,
    );
    if (share > 0) out.set(key, share);
  }
  return out;
}

export function summarize(locations: CashLocation[], units: BusinessUnit[]): CashSummary {
  const fundUnits = new Set(units.filter((u) => u.counts_to_fund).map((u) => u.id));
  let liquid = 0, lent = 0, fund = 0, outsideFund = 0;

  for (const loc of locations) {
    const balance = Number(loc.balance) || 0;
    if (isLiquid(loc.location_type)) liquid += balance;
    else lent += balance;

    // Sin unidad asignada la plata igual existe: entra al fondo, que es el
    // saldo general de la empresa. Dejarla afuera la haría desaparecer del
    // ahorro real sin que nadie lo note.
    for (const part of allocateShares(loc)) {
      const amount = balance * part.share;
      if (!part.unitId || fundUnits.has(part.unitId)) fund += amount;
      else outsideFund += amount;
    }
  }

  return {
    liquid: round2(liquid),
    lent: round2(lent),
    total: round2(liquid + lent),
    fund: round2(fund),
    outsideFund: round2(outsideFund),
  };
}

/**
 * Una ubicación vista desde una de sus unidades dueñas: `balance` es ya la
 * parte que le toca, no el saldo entero.
 */
export interface AllocatedLocation extends CashLocation {
  share: number;
  /** Saldo completo de la ubicación, del que `balance` es una porción. */
  fullBalance: number;
}

/** Agrupa por unidad de negocio para el desglose. Sin unidad va al final. */
export function groupByUnit(
  locations: CashLocation[],
  units: BusinessUnit[],
): Array<{ unit: BusinessUnit | null; locations: AllocatedLocation[]; total: number }> {
  const byId = new Map(units.map((u) => [u.id, u]));
  const groups = new Map<string, AllocatedLocation[]>();
  for (const loc of locations) {
    const full = Number(loc.balance) || 0;
    for (const part of allocateShares(loc)) {
      const key = part.unitId ?? '';
      const entry: AllocatedLocation = {
        ...loc,
        share: part.share,
        fullBalance: full,
        balance: full * part.share,
      };
      const arr = groups.get(key);
      if (arr) arr.push(entry);
      else groups.set(key, [entry]);
    }
  }
  return [...groups.entries()]
    .map(([id, locs]) => ({
      unit: id ? byId.get(id) ?? null : null,
      locations: locs,
      total: round2(locs.reduce((s, l) => s + (Number(l.balance) || 0), 0)),
    }))
    .sort((a, b) => {
      if (!a.unit) return 1;
      if (!b.unit) return -1;
      return a.unit.sort_order - b.unit.sort_order;
    });
}

/** Agrupa por tipo de ubicación, en el orden del catálogo. */
export function groupByType(locations: CashLocation[]): Array<{ type: LocationType; total: number; count: number }> {
  const totals = new Map<LocationType, { total: number; count: number }>();
  for (const loc of locations) {
    const type = normalizeLocationType(loc.location_type);
    const cur = totals.get(type) ?? { total: 0, count: 0 };
    cur.total += Number(loc.balance) || 0;
    cur.count += 1;
    totals.set(type, cur);
  }
  return LOCATION_TYPES
    .filter((t) => totals.has(t))
    .map((t) => ({ type: t, total: round2(totals.get(t)!.total), count: totals.get(t)!.count }));
}
