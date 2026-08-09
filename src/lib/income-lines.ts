// ─────────────────────────────────────────────────────────────────────────────
// Ingresos operativos con detalle por concepto — contrato compartido.
//
// Espejo de los egresos: concepto, monto, cobrado, pendiente. Existe porque
// `operating_income` guarda tres números por período y eso no alcanza para una
// consultora, que factura a varios clientes y necesita saber quién le debe.
//
// LA REGLA QUE NO SE PUEDE ROMPER: lo que la cadena de socios reparte es lo
// COBRADO, no lo facturado. Una factura emitida y no cobrada no es plata que
// exista. Por eso `totals().received` es el número que se materializa en
// operating_income.other, y el pendiente vive aparte como cuentas por cobrar.
//
// Import-safe desde cliente y servidor: no toca Supabase.
// ─────────────────────────────────────────────────────────────────────────────

export interface IncomeLine {
  id: string;
  company_id: string;
  period_id: string;
  concept: string;
  client: string | null;
  amount: number;
  received: number;
  pending: number;
  category: string | null;
  reference: string | null;
  income_date: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** Lo que viaja al guardar: sin ids ni timestamps, que los pone el servidor. */
export interface IncomeLineInput {
  concept: string;
  client?: string | null;
  amount: number;
  received: number;
  pending?: number;
  category?: string | null;
  reference?: string | null;
  income_date?: string | null;
  sort_order?: number;
}

export interface IncomeTotals {
  /** Facturado. */
  amount: number;
  /** Cobrado — el único que entra en la cadena de distribución. */
  received: number;
  /** Por cobrar. */
  pending: number;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function computeIncomeTotals(lines: Array<Pick<IncomeLine, 'amount' | 'received' | 'pending'>>): IncomeTotals {
  let amount = 0, received = 0, pending = 0;
  for (const l of lines) {
    amount += Number(l.amount) || 0;
    received += Number(l.received) || 0;
    pending += Number(l.pending) || 0;
  }
  return { amount: round2(amount), received: round2(received), pending: round2(pending) };
}

/**
 * Pendiente de una línea. Si el usuario escribió uno explícito (>0) se
 * respeta; si no, se deriva de monto − cobrado.
 *
 * Misma semántica que computeExpensePending, a propósito: las dos pantallas
 * se ven iguales y tienen que comportarse igual. Un pendiente explícito de 0
 * NO se distingue de vacío — el caso "facturé 100, cobré 100" ya da 0 por la
 * resta.
 */
export function computeIncomePending(
  amountRaw: number | string | null | undefined,
  receivedRaw: number | string | null | undefined,
  pendingRaw?: number | string | null | undefined,
): number {
  const num = (v: number | string | null | undefined): number => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    const n = parseFloat(v ?? '');
    return Number.isFinite(n) ? n : 0;
  };
  const explicit = num(pendingRaw);
  return explicit || round2(num(amountRaw) - num(receivedRaw));
}

/** Devuelve el mensaje de error, o null si la línea es válida. */
export function validateIncomeLine(input: Partial<IncomeLineInput>): string | null {
  if (!input.concept || !input.concept.trim()) return 'El concepto es requerido';
  const amount = Number(input.amount);
  if (!Number.isFinite(amount)) return 'El monto es requerido';
  if (amount < 0) return 'El monto no puede ser negativo';
  const received = Number(input.received ?? 0);
  if (!Number.isFinite(received) || received < 0) return 'El cobrado no puede ser negativo';
  // Cobrar de más casi siempre es un tipeo (un dígito de más) y descuadra la
  // cadena en silencio, porque lo cobrado es lo que se reparte.
  if (received > amount + 0.01) return 'El cobrado no puede superar al monto facturado';
  return null;
}

/** Agrupa por cliente para el resumen. Sin cliente cae en "Sin asignar". */
export function groupByClient(lines: IncomeLine[]): Array<{ client: string; totals: IncomeTotals }> {
  const map = new Map<string, IncomeLine[]>();
  for (const l of lines) {
    const key = (l.client ?? '').trim() || 'Sin asignar';
    const arr = map.get(key);
    if (arr) arr.push(l);
    else map.set(key, [l]);
  }
  return [...map.entries()]
    .map(([client, rows]) => ({ client, totals: computeIncomeTotals(rows) }))
    .sort((a, b) => b.totals.amount - a.totals.amount);
}
