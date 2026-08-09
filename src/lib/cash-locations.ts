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

export interface CashLocation {
  /** Clave del libro: la misma que usa channel_ledger_entries. */
  channel_key: string;
  label: string;
  location_type: LocationType;
  business_unit_id: string | null;
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
    if (!loc.business_unit_id || fundUnits.has(loc.business_unit_id)) fund += balance;
    else outsideFund += balance;
  }

  return {
    liquid: round2(liquid),
    lent: round2(lent),
    total: round2(liquid + lent),
    fund: round2(fund),
    outsideFund: round2(outsideFund),
  };
}

/** Agrupa por unidad de negocio para el desglose. Sin unidad va al final. */
export function groupByUnit(
  locations: CashLocation[],
  units: BusinessUnit[],
): Array<{ unit: BusinessUnit | null; locations: CashLocation[]; total: number }> {
  const byId = new Map(units.map((u) => [u.id, u]));
  const groups = new Map<string, CashLocation[]>();
  for (const loc of locations) {
    const key = loc.business_unit_id ?? '';
    const arr = groups.get(key);
    if (arr) arr.push(loc);
    else groups.set(key, [loc]);
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
