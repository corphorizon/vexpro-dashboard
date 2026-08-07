// ─────────────────────────────────────────────────────────────────────────────
// Libro de balances por canal — contrato compartido (UI + API + cron + PDF).
//
// Un canal deja de ser "un número por día" y pasa a ser un libro: un saldo
// inicial más asientos de ingreso y egreso, con saldo corrido. Igual que
// payment-orders/types.ts, este módulo es la ÚNICA definición del cálculo:
// si la UI y el PDF sumaran por su cuenta, terminarían mostrando cifras
// distintas del mismo libro.
//
// Import-safe desde cliente y servidor: no toca Supabase.
// ─────────────────────────────────────────────────────────────────────────────

export type LedgerKind = 'opening' | 'in' | 'out';
export type LedgerSource = 'manual' | 'api';

export interface LedgerEntry {
  id: string;
  company_id: string;
  channel_key: string;
  entry_date: string; // YYYY-MM-DD
  kind: LedgerKind;
  source: LedgerSource;
  concept: string;
  category: string | null;
  reference: string | null;
  amount: number;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Qué canales llevan libro
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `liquidez` e `inversiones` NO llevan libro acá: ya son libros en sus propios
 * módulos y su saldo se reconstruye desde sus movimientos. Duplicarlos sería
 * contar la misma plata dos veces.
 */
export const NON_LEDGER_CHANNELS = new Set(['liquidez', 'inversiones']);

/**
 * Canales cuyo libro escribe el cron y NADIE edita a mano. El saldo sale de
 * la API del proveedor, así que un asiento manual solo podría descuadrarlo.
 */
export const API_LEDGER_CHANNELS = new Set(['coinsbuy', 'unipayment']);

export function hasLedger(channelKey: string): boolean {
  return !NON_LEDGER_CHANNELS.has(channelKey);
}

/** true → el libro es automático (solo lectura para el usuario). */
export function isAutoLedger(channelKey: string): boolean {
  return API_LEDGER_CHANNELS.has(channelKey);
}

// ─────────────────────────────────────────────────────────────────────────────
// Categorías que escribe el cron
//
// `adjustment` existe porque el libro tiene que cerrar contra el saldo real
// del proveedor. En Coinsbuy son las comisiones de red (~$1-4/día); en
// UniPayment son las liquidaciones de salida, que su API no expone. Dejar la
// diferencia a la vista es preferible a un libro que no cuadra con la wallet.
// ─────────────────────────────────────────────────────────────────────────────

export const AUTO_CATEGORIES = {
  opening: 'opening',
  deposits: 'deposits',
  withdrawals: 'withdrawals',
  internal: 'internal',
  adjustment: 'adjustment',
} as const;

export type AutoCategory = (typeof AUTO_CATEGORIES)[keyof typeof AUTO_CATEGORIES];

const AUTO_LABELS: Record<string, { es: string; en: string }> = {
  opening:     { es: 'Saldo inicial',            en: 'Opening balance' },
  deposits:    { es: 'Depósitos del día',        en: 'Deposits for the day' },
  withdrawals: { es: 'Retiros del día',          en: 'Withdrawals for the day' },
  internal:    { es: 'Transferencias internas',  en: 'Internal transfers' },
  adjustment:  { es: 'Ajuste de conciliación',   en: 'Reconciliation adjustment' },
};

export function autoCategoryLabel(category: string | null, locale: 'es' | 'en' = 'es'): string | null {
  if (!category) return null;
  return AUTO_LABELS[category]?.[locale] ?? null;
}

/**
 * Las transferencias internas mueven el saldo del canal pero NO son un retiro
 * del negocio — se excluyen de "Retiros Totales" en todo el dashboard. Quien
 * quiera los retiros reales del libro tiene que filtrar por esto.
 */
export function isInternalTransfer(entry: LedgerEntry): boolean {
  return entry.category === AUTO_CATEGORIES.internal;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cálculo
// ─────────────────────────────────────────────────────────────────────────────

/** El signo lo da `kind`; `amount` en la DB es siempre positivo. */
export function signedAmount(entry: Pick<LedgerEntry, 'kind' | 'amount'>): number {
  return entry.kind === 'out' ? -entry.amount : entry.amount;
}

/**
 * Orden canónico del libro: por fecha, y dentro del día el saldo inicial
 * primero y las líneas automáticas en orden contable (entra, sale, se ajusta).
 * Sin esto el saldo corrido saltaría de forma distinta en la pantalla y en el
 * PDF según cómo viniera ordenada la query.
 */
const CATEGORY_RANK: Record<string, number> = {
  opening: 0, deposits: 1, withdrawals: 2, internal: 3, adjustment: 4,
};

export function sortEntries(entries: LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((a, b) => {
    if (a.entry_date !== b.entry_date) return a.entry_date < b.entry_date ? -1 : 1;
    if (a.kind === 'opening' && b.kind !== 'opening') return -1;
    if (b.kind === 'opening' && a.kind !== 'opening') return 1;
    const ra = CATEGORY_RANK[a.category ?? ''] ?? 90;
    const rb = CATEGORY_RANK[b.category ?? ''] ?? 90;
    if (ra !== rb) return ra - rb;
    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
  });
}

export interface LedgerRow extends LedgerEntry {
  /** Saldo del canal DESPUÉS de aplicar este asiento. */
  balance: number;
}

/** Asientos ordenados y con saldo corrido acumulado. */
export function withRunningBalance(entries: LedgerEntry[]): LedgerRow[] {
  let running = 0;
  return sortEntries(entries).map((e) => {
    running += signedAmount(e);
    return { ...e, balance: running };
  });
}

/** Saldo del canal al CIERRE de `asof` (YYYY-MM-DD), inclusive. */
export function balanceAsOf(entries: LedgerEntry[], asof: string): number {
  return entries
    .filter((e) => e.entry_date <= asof)
    .reduce((sum, e) => sum + signedAmount(e), 0);
}

export interface LedgerTotals {
  opening: number;
  inflows: number;
  /** Retiros reales — excluye transferencias internas. */
  outflows: number;
  internalTransfers: number;
  adjustments: number;
  closing: number;
}

/**
 * Totales del período para las tarjetas de resumen y el PDF.
 * `opening` es el saldo ANTES del primer asiento del rango, así que
 * opening + inflows − outflows − internalTransfers + adjustments = closing.
 */
export function computeTotals(
  entries: LedgerEntry[],
  from: string,
  to: string,
): LedgerTotals {
  const opening = balanceAsOf(entries, previousDay(from));
  const inRange = entries.filter((e) => e.entry_date >= from && e.entry_date <= to);

  let inflows = 0, outflows = 0, internalTransfers = 0, adjustments = 0;
  for (const e of inRange) {
    if (e.kind === 'opening') { inflows += e.amount; continue; }
    if (e.category === AUTO_CATEGORIES.adjustment) { adjustments += signedAmount(e); continue; }
    if (isInternalTransfer(e)) { internalTransfers += e.amount; continue; }
    if (e.kind === 'in') inflows += e.amount;
    else outflows += e.amount;
  }

  return {
    opening,
    inflows,
    outflows,
    internalTransfers,
    adjustments,
    closing: opening + inflows - outflows - internalTransfers + adjustments,
  };
}

/** YYYY-MM-DD del día anterior, sin depender de la zona horaria local. */
export function previousDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Validación de un asiento manual (usada por el endpoint y por el formulario)
// ─────────────────────────────────────────────────────────────────────────────

export interface LedgerEntryInput {
  channel_key: string;
  entry_date: string;
  kind: 'in' | 'out' | 'opening';
  concept: string;
  amount: number;
  category?: string | null;
  reference?: string | null;
  notes?: string | null;
}

/** Devuelve el mensaje de error, o null si el asiento es válido. */
export function validateEntry(input: Partial<LedgerEntryInput>): string | null {
  if (!input.channel_key) return 'Falta el canal';
  if (!hasLedger(input.channel_key)) {
    return 'Este canal no lleva libro: su saldo se calcula desde su propio módulo';
  }
  if (isAutoLedger(input.channel_key)) {
    return 'El libro de este canal lo escribe la sincronización automática y no admite asientos manuales';
  }
  if (!input.entry_date || !/^\d{4}-\d{2}-\d{2}$/.test(input.entry_date)) {
    return 'La fecha es requerida';
  }
  if (input.kind !== 'in' && input.kind !== 'out' && input.kind !== 'opening') {
    return 'El movimiento tiene que ser ingreso o egreso';
  }
  if (!input.concept || !input.concept.trim()) return 'El concepto es requerido';
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount)) {
    return 'El monto es requerido';
  }
  if (input.amount < 0) return 'El monto no puede ser negativo — usá ingreso o egreso para el signo';
  if (input.amount === 0) return 'El monto tiene que ser mayor que cero';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ¿La transferencia interna salió del agregado o se movió entre wallets
// fijadas?
//
// `internal = true` mezcla dos casos que el libro debe tratar distinto
// (auditoría 2026-08-06, integraciones):
//   · destino NO fijado → la plata SÍ salió del agregado ⇒ línea 'internal'.
//   · destino fijado    → la plata NUNCA salió ⇒ NINGUNA línea (asentarla y
//     revertirla con un ajuste gigante es ficción contable — pasó el 30/07
//     con $174.835/$169.999, y el 06/08 el guard abortó por esto).
//
// La API no persiste la wallet destino, pero no hace falta: el saldo REAL del
// custodio decide. Se calculan los dos candidatos y gana el que deja el
// ajuste chico. Si ninguno cierra (interna parcial, dato roto), se devuelve
// el de menor ajuste y el umbral del caller aborta el día — revisión humana.
// ─────────────────────────────────────────────────────────────────────────────
export function resolveInternalTransfers(params: {
  /** prior + manuales del día + depósitos − retiros (SIN tocar la interna). */
  baseWithoutInternal: number;
  internal: number;
  actualClose: number;
}): { internalLeftAggregate: boolean; adjustment: number } {
  const { baseWithoutInternal, internal, actualClose } = params;
  if (internal <= 0) {
    return { internalLeftAggregate: false, adjustment: actualClose - baseWithoutInternal };
  }
  const adjIfLeft = actualClose - (baseWithoutInternal - internal);
  const adjIfStayed = actualClose - baseWithoutInternal;
  return Math.abs(adjIfLeft) <= Math.abs(adjIfStayed)
    ? { internalLeftAggregate: true, adjustment: adjIfLeft }
    : { internalLeftAggregate: false, adjustment: adjIfStayed };
}
