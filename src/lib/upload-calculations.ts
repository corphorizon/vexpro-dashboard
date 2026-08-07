// ─────────────────────────────────────────────────────────────────────────────
// Helpers puros de la pantalla de carga (/upload).
//
// Extraídos desde upload/page.tsx (era un componente de 2,854 líneas con esta
// matemática de dinero repetida inline en addExpense/editExpense,
// add/editLiquidity y add/editInvestment). Acá son funciones puras testeables —
// el JSX del componente NO cambió, solo llama a estos helpers en vez de
// reimplementar la misma cuenta en cada handler.
//
// IMPORTANTE: la semántica debe ser IDÉNTICA a la inline original, incluida la
// precedencia de operadores. `parseFloat(pending) || amount - paid` es
// `parseFloat(pending) || (amount - paid)` porque `-` liga más fuerte que `||`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parsea un valor de input numérico igual que el original `parseFloat(x) || 0`:
 * vacío, no-numérico, o NaN → 0. Acepta number directo (lo pasa tal cual salvo
 * NaN). No redondea — el redondeo es responsabilidad de quien muestra/guarda.
 */
export function parseAmount(raw: string | number | null | undefined): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  const n = parseFloat(raw ?? '');
  return Number.isFinite(n) ? n : 0;
}

/**
 * Detecta el caso que parseAmount se traga en silencio: el usuario ESCRIBIÓ
 * algo pero no parsea a número ("abc", "12..5", ","), y guardarlo lo
 * convertiría en un 0 que nadie pidió (auditoría 2026-08-06 R1). Vacío o solo
 * espacios NO es inválido: significa "sin valor" a propósito.
 *
 * Devuelve el primer texto inválido, o null si todos los campos están bien.
 */
export function findInvalidAmount(
  ...values: Array<string | number | null | undefined>
): string | null {
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    if (s !== '' && !Number.isFinite(parseFloat(s))) return s;
  }
  return null;
}

/**
 * Pendiente de un gasto. Si el usuario escribió un pendiente explícito (>0) se
 * respeta; si lo dejó vacío/0 se deriva como `amount - paid`.
 *
 * Replica exactamente `parseFloat(newExpense.pending) || amt - pd` del original:
 * un pendiente explícito de 0 NO se distingue de vacío (ambos caen al fallback),
 * que es el comportamiento que la pantalla ya tenía.
 */
export function computeExpensePending(
  amountRaw: string | number | null | undefined,
  paidRaw: string | number | null | undefined,
  pendingRaw?: string | number | null | undefined,
): number {
  const amount = parseAmount(amountRaw);
  const paid = parseAmount(paidRaw);
  const explicit = parseAmount(pendingRaw);
  return explicit || amount - paid;
}
