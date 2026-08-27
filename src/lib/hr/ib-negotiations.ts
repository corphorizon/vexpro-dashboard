// ─────────────────────────────────────────────────────────────────────────────
// Negociaciones con IBs: los tipos que comparten la API y la pantalla.
//
// Kevin, 2026-08-27: «me gustaría crear en esa sección algo para también tener
// negociaciones de IB por aparte, normalmente son negociaciones de PNL o Net
// Deposit, necesitaría tener la info completa de ellos, el net deposit de ellos
// y su red, el PNL, la cantidad de lotes que se les pagaron y cuánto se les
// pagó».
//
// ── UN IB NO ES UN PERFIL COMERCIAL ───────────────────────────────────────
// `commercial_negotiations` (y su API en /api/admin/negotiations) es de la
// ESTRUCTURA: BDM, heads, sales managers, 126 filas con FK a
// commercial_profiles. Un IB es un CLIENTE del CRM que refiere gente: 702 con
// premios pagados, y sólo 114 de los 1.793 sponsors distintos del CRM tienen
// perfil comercial. Son dos módulos distintos a propósito; este archivo no
// toca aquel.
//
// ── SIN DATO NO ES CERO ───────────────────────────────────────────────────
// Las cuatro columnas del desglose forex/sintéticos son `number | null`. NULL
// significa "ese mes no está cubierto por el espejo de símbolos" — el bróker
// purga la colección de origen a los quince días, así que los meses anteriores
// a 2026-08-13 NO tienen desglose y nunca lo van a tener. Cero significa "no
// operó esa clase de activo". Confundirlos haría que un IB sin dato apareciera
// como si no hubiera tocado un sintético en todo el mes. Mismo criterio que
// src/lib/hr/ib-production.ts.
//
// ── EL PNL ES ATRIBUIDO ───────────────────────────────────────────────────
// El CRM repite el pnl de cada operación una vez por cada nivel de IB que
// cobra por ella (4,9 niveles de promedio, medido). Es una cifra legítima POR
// IB y NO es el PNL de la empresa: sumarla entre IBs cuenta la misma operación
// varias veces. La pantalla la rotula "PNL atribuido" por eso.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Las dos familias de trato que nombró Kevin. El resto de las condiciones vive
 * en `terms`, que es texto libre: modelar hoy un esquema de escalones sería
 * inventar una estructura que nadie describió.
 */
export const IB_DEAL_TYPES = ['pnl', 'net_deposit'] as const;
export type IbDealType = (typeof IB_DEAL_TYPES)[number];

export function isDealType(v: unknown): v is IbDealType {
  return typeof v === 'string' && (IB_DEAL_TYPES as readonly string[]).includes(v);
}

export const IB_NEGOTIATION_STATUSES = ['active', 'closed'] as const;
export type IbNegotiationStatus = (typeof IB_NEGOTIATION_STATUSES)[number];

/** Una fila de `ib_negotiations` (migración 099). */
export type IbNegotiationRow = {
  id: string;
  user_external_id: string;
  ib_email: string | null;
  ib_username: string | null;
  deal_type: IbDealType;
  terms: string | null;
  pct: number | string | null;
  target_amount: number | string | null;
  status: IbNegotiationStatus;
  starts_on: string | null;
  ends_on: string | null;
  notes: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
};

/** El perfil del IB tal como lo espeja el CRM. */
export type IbProfile = {
  user_external_id: string;
  username: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone_raw: string | null;
  phone_country_code: string | null;
  country: string | null;
  country_iso: string | null;
  status: string | null;
  kyc_status: string | null;
  user_type: string | null;
  rank: string | null;
  register_date: string | null;
  sponsor_username: string | null;
  sponsor_email: string | null;
  ib_program_name: string | null;
};

/**
 * Lo que el CRM le pagó a ESTE IB en el mes.
 *
 * NO se rolla sumando a los sub-IB: los premios de un IB ya son por las
 * operaciones de toda su estructura, y sumarle los de sus sub-IB contaría dos
 * veces la misma operación.
 */
export type IbNumbers = {
  /** Lotes estándar pagados (las cuentas cent ya vienen ÷100 del bróker). */
  lots: number;
  /** Comisión IB pagada, USD. */
  commission: number;
  /** PNL del trader en las operaciones por las que cobró. Ver cabecera. */
  pnl: number;
  /** Cantidad de pagos por lotes. */
  rewards: number;
  /** Días del mes con actividad — sirve para distinguir 0 de "no operó". */
  activeDays: number;
  /** null = el mes no está cubierto por el espejo de símbolos. */
  forexLots: number | null;
  forexCommission: number | null;
  syntheticLots: number | null;
  syntheticCommission: number | null;
};

export function emptyIbNumbers(): IbNumbers {
  return {
    lots: 0, commission: 0, pnl: 0, rewards: 0, activeDays: 0,
    forexLots: null, forexCommission: null, syntheticLots: null, syntheticCommission: null,
  };
}

/**
 * La red del IB: la cadena de sponsors HACIA ABAJO (RPC crm_ib_network_stats,
 * migración 099). `net` es el net deposit del mes de toda la red SIN el IB, y
 * `ownNet` el del IB solo — son dos números distintos a propósito: sumarlos
 * escondería que el IB personalmente retiró más de lo que depositó.
 */
export type IbNetwork = {
  size: number;
  depth: number;
  net: number;
  movers: number;
  ownNet: number;
};

export type IbNegotiationPackage = {
  negotiation: IbNegotiationRow;
  /** null = el IB ya no está en el espejo del CRM (lo dieron de baja). */
  profile: IbProfile | null;
  production: IbNumbers;
  /** null = no se pudo resolver la red (sin username congelado). No es cero. */
  network: IbNetwork | null;
};

export type IbNegotiationsResponse = {
  month: string;
  currency: string;
  packages: IbNegotiationPackage[];
  symbolCoverage: {
    days: number;
    daysInMonth: number;
    from: string | null;
    to: string | null;
  };
};

export type IbNetworkMember = {
  user_external_id: string;
  username: string | null;
  email: string | null;
  country: string | null;
  status: string | null;
  depth: number;
  deposits: number | string;
  withdrawals: number | string;
  net: number | string;
};

/** numeric de Postgres llega como string por JSON; null se preserva. */
export function toNumber(v: number | string | null | undefined): number {
  return Number(v) || 0;
}

/** El nombre para mostrar: el del CRM si está, el username congelado si no. */
export function ibDisplayName(pkg: IbNegotiationPackage): string {
  const p = pkg.profile;
  const full = [p?.first_name, p?.last_name].filter(Boolean).join(' ').trim();
  return full || p?.username || pkg.negotiation.ib_username || pkg.negotiation.user_external_id;
}
