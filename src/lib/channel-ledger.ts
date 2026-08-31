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

import { BUILTIN_CHANNELS } from './channel-configs';

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
 *
 * ── POR QUÉ ENTRÓ `fairpay` (2026-08-31, Kevin: «fairpay sigue sin sumar en
 *    balances por canal») ────────────────────────────────────────────────────
 * El canal estaba en el peor de los mundos posibles: `hasLedger('fairpay')`
 * daba true (no está en NON_LEDGER_CHANNELS) pero NADIE escribía su libro. El
 * único asiento que existía en producción era una apertura MANUAL de $0,00
 * fechada el 2026-08-05, y como el libro le gana al snapshot en las dos
 * pantallas que muestran el saldo —`getChannelValue` en /balances y
 * `pickChannelAmount` en reports/balances-by-channel.ts (auditoría A1)— ese
 * cero de tres semanas atrás tapaba el snapshot diario real. Medido el
 * 2026-08-31: el libro decía $0,00 y la API del banking $7.163,47. El total
 * consolidado venía corto por esos $7.163,47 desde el 2026-08-05.
 *
 * La raíz no era la prioridad libro > snapshot (que es correcta: el libro
 * cierra exacto contra el saldo real del día). La raíz es la de la migración
 * 059: **un canal de API tiene libro AUTOMÁTICO**. FairPay tenía saldo por API
 * y libro huérfano. Acá se cierra esa contradicción.
 *
 * ⚠ FairPay tiene una particularidad que NINGÚN otro canal automático tiene, y
 * está resuelta en la migración 108 — no la deshagas sin leerla:
 * **el libro de FairPay no tiene fuente de movimientos**. Son DOS sistemas
 * distintos (ver src/lib/api-integrations/fairpay/balances.ts):
 *   · `banking.fairpay.online` → de acá sale el SALDO, y no expone extracto
 *     (barrido de ~150 rutas con credencial real: todas 404).
 *   · `portal.fairpay.online`  → de acá salen las filas
 *     `api_transactions.provider='fairpay'`, que son cobros del portal, NO
 *     movimientos de la cuenta bancaria. No liquidan 1:1: en agosto 2026 el
 *     portal registró depósitos casi todos los días y el banking se movió DOS
 *     veces (0 → 6.747,05 el 18/08 → 7.163,47 el 25/08).
 * Y encima esas filas del portal **suman monedas locales como si fueran USD**
 * (COP, CLP, CRC, MXN, BRL conviven en `amount`; el 2026-08-12 hay $145.714,40
 * de tres monedas distintas sumados como dólares). Eso es un hallazgo grave
 * aparte, pendiente de decisión de Kevin, y NO se arregla acá — pero es la
 * segunda razón por la que asentarlas como «Depósitos del día» del canal
 * habría sido plata inventada.
 *
 * ── DERIVADO, NO ESCRITO A MANO (2026-08-31, auditoría de finanzas) ─────────
 * Hasta hoy esta lista era un `new Set([...])` literal y `paypros` NUNCA estuvo
 * en ella, aunque su libro lo escribe el cron desde el 2026-08-24. El resultado
 * es el peor de los mundos, el mismo que tenía FairPay al revés: en producción
 * había **15 asientos `source='api'`** de Pay-Pros escritos por el cron y a la
 * vez `isAutoLedger('paypros')` daba false, así que la UI ofrecía el botón de
 * «Nuevo asiento» sobre un libro que el cron REESCRIBE cada noche
 * (`replace_channel_ledger_day` borra e inserta las líneas 'api' del día).
 * Coinsbuy, que sí estaba en la lista, tiene igualmente **un asiento manual
 * colado de +38.397,58 el 2026-08-06** — el alta de la wallet 1705, de cuando
 * la validación todavía no existía. Se reporta, no se borra: el saldo actual
 * del canal lo incluye y borrarlo sin reprocesar dejaría el libro corrido.
 *
 * La lista ahora se DERIVA de `BUILTIN_CHANNELS`: un canal built-in de tipo
 * `auto` que lleve libro ES un canal de libro automático. Eran dos listas que
 * decían lo mismo y ya habían divergido (§1.1 de docs/reglas-del-proyecto.md:
 * *listas duplicadas que se desincronizan en silencio son el modo de falla
 * número uno de este repo*). Con esto, dar de alta un built-in `auto` nuevo lo
 * marca de solo-lectura sin que nadie tenga que acordarse de esta línea.
 *
 * `inversiones` y `liquidez` son `auto` pero NO llevan libro acá
 * (NON_LEDGER_CHANNELS), así que quedan fuera por construcción.
 */
export const API_LEDGER_CHANNELS: ReadonlySet<string> = new Set(
  BUILTIN_CHANNELS.filter((c) => c.type === 'auto' && !NON_LEDGER_CHANNELS.has(c.key)).map(
    (c) => c.key,
  ),
);

export function hasLedger(channelKey: string): boolean {
  return !NON_LEDGER_CHANNELS.has(channelKey);
}

/**
 * true → el libro es automático (solo lectura para el usuario).
 *
 * `opts.onchain` existe porque una ubicación on-chain (migración 085) NO tiene
 * clave conocida: su `channel_key` es `wallet_externa` o un `custom_<uuid>`
 * distinto en cada empresa, así que no puede estar en el Set. Lo que la vuelve
 * automática es su NATURALEZA —tener direcciones cargadas en
 * `channel_configs.onchain_wallets`—, y eso lo sabe el caller, no la clave. Es
 * el mismo criterio que `maxAdjustmentFor` en channel-ledger-sync.ts.
 *
 * Sin esto, la wallet on-chain de Vex Pro quedaba en la misma trampa que tenía
 * Pay-Pros: el cron escribiendo su libro cada noche y la UI ofreciendo asientos
 * a mano encima.
 */
export function isAutoLedger(
  channelKey: string,
  opts: { onchain?: boolean } = {},
): boolean {
  return API_LEDGER_CHANNELS.has(channelKey) || opts.onchain === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Categorías que escribe el cron
//
// `adjustment` existe porque el libro tiene que cerrar contra el saldo real
// del proveedor. En Coinsbuy son las comisiones de red (~$1-4/día); en
// UniPayment son las liquidaciones de salida, que su API no expone. Dejar la
// diferencia a la vista es preferible a un libro que no cuadra con la wallet.
//
// `balance_delta` es la MISMA aritmética que `adjustment` con otro nombre, y el
// nombre es justamente el punto (2026-08-31, FairPay). Un canal sin extracto
// —el proveedor informa el saldo pero no los movimientos— cierra su día con una
// única línea que ES el movimiento del día, no la corrección de un desvío.
// Etiquetarla «Ajuste de conciliación» habría hecho que el libro de FairPay
// mostrara «Ajuste +6.747,05» el 18/08: un número correcto con el nombre de un
// error, que es la forma más rápida de que alguien lo "arregle".
//
// `regularization` es la TERCERA con la misma aritmética, y otra vez el nombre
// es el punto (2026-08-31, auditoría de finanzas). Cuando el guard abortó N
// noches seguidas, la diferencia que se asienta al recuperar NO es el
// movimiento de ese día: son N+1 días acumulados. UniPayment mostró
// exactamente por qué importa — tras varios días abortados asentó UN solo
// «Ajuste de conciliación» de −21.740,51 fechado en un día en el que no pasó
// eso: una historia falsa que además CUADRA, que es la peor clase de dato malo
// (§1.2: el enemigo es el fallo que no da error). La línea de regularización
// dice en el concepto cuántos días cubre y en la nota las fechas exactas.
// ─────────────────────────────────────────────────────────────────────────────

export const AUTO_CATEGORIES = {
  opening: 'opening',
  deposits: 'deposits',
  withdrawals: 'withdrawals',
  internal: 'internal',
  adjustment: 'adjustment',
  balanceDelta: 'balance_delta',
  regularization: 'regularization',
} as const;

export type AutoCategory = (typeof AUTO_CATEGORIES)[keyof typeof AUTO_CATEGORIES];

const AUTO_LABELS: Record<string, { es: string; en: string }> = {
  opening:     { es: 'Saldo inicial',            en: 'Opening balance' },
  deposits:    { es: 'Depósitos del día',        en: 'Deposits for the day' },
  withdrawals: { es: 'Retiros del día',          en: 'Withdrawals for the day' },
  internal:    { es: 'Transferencias internas',  en: 'Internal transfers' },
  adjustment:  { es: 'Ajuste de conciliación',   en: 'Reconciliation adjustment' },
  balance_delta: { es: 'Variación del saldo',    en: 'Balance change' },
  regularization: { es: 'Regularización de varios días', en: 'Multi-day catch-up' },
};

/**
 * `true` para las categorías que NO son un movimiento medido sino la diferencia
 * contra el saldo real del proveedor. Las dos se tratan igual en la aritmética
 * (`computeTotals` las suma como `adjustments`); lo que cambia es el nombre que
 * ve el usuario. Existe como función para que agregar una tercera no obligue a
 * buscar los `=== 'adjustment'` desperdigados.
 */
export function isBalanceReconciliation(category: string | null): boolean {
  return (
    category === AUTO_CATEGORIES.adjustment ||
    category === AUTO_CATEGORIES.balanceDelta ||
    category === AUTO_CATEGORIES.regularization
  );
}

/**
 * `true` si la línea cubre MÁS de un día. Existe para que la UI y el PDF puedan
 * marcarla: un importe grande fechado un martes que en realidad son seis días
 * no se puede leer como el movimiento de ese martes.
 */
export function isMultiDayCatchUp(category: string | null): boolean {
  return category === AUTO_CATEGORIES.regularization;
}

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
  balance_delta: 4, regularization: 4,
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
    if (isBalanceReconciliation(e.category)) { adjustments += signedAmount(e); continue; }
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

/**
 * Devuelve el mensaje de error, o null si el asiento es válido.
 *
 * `opts.onchain` lo pasa quien sabe si la ubicación tiene direcciones cargadas
 * (el endpoint lo lee de `channel_configs.onchain_wallets`). Ver `isAutoLedger`.
 */
export function validateEntry(
  input: Partial<LedgerEntryInput>,
  opts: { onchain?: boolean } = {},
): string | null {
  if (!input.channel_key) return 'Falta el canal';
  if (!hasLedger(input.channel_key)) {
    return 'Este canal no lleva libro: su saldo se calcula desde su propio módulo';
  }
  if (isAutoLedger(input.channel_key, opts)) {
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
