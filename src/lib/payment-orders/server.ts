// ─────────────────────────────────────────────────────────────────────────────
// Órdenes de Pago — helpers SERVER-SIDE compartidos por los endpoints.
//
// Vive acá (y no dentro de cada route) porque las cuatro rutas del módulo
// comparten exactamente las mismas reglas: validación del payload, normalización
// de la fila de DB al contrato de types.ts, libreta de beneficiarios y el egreso
// que se genera al marcar pagada. Duplicar eso en cuatro archivos es la forma
// más segura de que una regla de tesorería quede desincronizada.
//
// IMPORTANTE: este módulo importa el admin client (service_role) — NUNCA debe
// ser importado desde un componente de cliente.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeTotals,
  type PaymentBeneficiary,
  type PaymentOrder,
  type PaymentOrderInput,
  type PaymentOrderLine,
  type PaymentOrderProof,
} from './types';

/** Columnas de payment_orders — el contrato expone la fila completa. */
export const ORDER_COLUMNS = '*';

// ── Comprobantes de pago (migración 086) ────────────────────────────────────
// Viven en payment_order_proofs, una fila por archivo (antes: cinco columnas en
// payment_orders = un solo archivo). El PATH del bucket NUNCA sale al cliente:
// se expone el id y la lectura pasa por /proof?proof_id=…, que firma la URL.

/** Lo único que la UI necesita ver de un comprobante. `storage_path` queda adentro. */
export const PROOF_CLIENT_COLUMNS = 'id, file_name, mime, size, uploaded_at';

/** Comprobantes de una orden, en el orden en que se muestran. */
export async function loadOrderProofs(
  admin: SupabaseClient,
  orderId: string,
): Promise<PaymentOrderProof[]> {
  const { data, error } = await admin
    .from('payment_order_proofs')
    .select(PROOF_CLIENT_COLUMNS)
    .eq('payment_order_id', orderId)
    .order('sort_order', { ascending: true })
    .order('uploaded_at', { ascending: true });
  if (error) {
    // No es fatal: la orden se muestra igual, sin la lista de comprobantes.
    console.error('[payment-orders] comprobantes:', error.message);
    return [];
  }
  return (data ?? []) as unknown as PaymentOrderProof[];
}

/** La orden con su array `proofs` — lo que consume el detalle del cliente. */
export async function withProofs(
  admin: SupabaseClient,
  order: PaymentOrder,
): Promise<PaymentOrder> {
  return { ...order, proofs: await loadOrderProofs(admin, order.id) };
}

/**
 * Archivo que hereda el egreso generado al pagar. El egreso apunta a UN adjunto
 * (columnas attachment_* de expenses), así que con varios comprobantes se lleva
 * el PRIMERO; el resto sigue accesible desde la orden.
 *
 * Fallback a las columnas legadas de payment_orders para las órdenes previas a
 * la migración 086 cuyo backfill todavía no corrió.
 */
export async function primaryProofForExpense(
  admin: SupabaseClient,
  order: {
    id: string;
    payment_proof_path?: string | null;
    payment_proof_name?: string | null;
    payment_proof_mime?: string | null;
    payment_proof_size?: number | null;
    payment_proof_uploaded_at?: string | null;
  },
): Promise<{
  path: string | null;
  name: string | null;
  mime: string | null;
  size: number | null;
  uploadedAt: string | null;
}> {
  const { data } = await admin
    .from('payment_order_proofs')
    .select('storage_path, file_name, mime, size, uploaded_at')
    .eq('payment_order_id', order.id)
    .order('sort_order', { ascending: true })
    .order('uploaded_at', { ascending: true })
    .limit(1);

  const first = (data ?? [])[0] as
    | { storage_path: string; file_name: string | null; mime: string | null; size: number | null; uploaded_at: string }
    | undefined;

  if (first) {
    return {
      path: first.storage_path,
      name: first.file_name,
      mime: first.mime,
      size: first.size,
      uploadedAt: first.uploaded_at,
    };
  }
  return {
    path: order.payment_proof_path ?? null,
    name: order.payment_proof_name ?? null,
    mime: order.payment_proof_mime ?? null,
    size: order.payment_proof_size ?? null,
    uploadedAt: order.payment_proof_uploaded_at ?? null,
  };
}

// ── Normalización DB → contrato ─────────────────────────────────────────────
// numeric llega como string desde PostgREST en algunos casos y jsonb como
// unknown: normalizamos una sola vez para que la UI y el PDF reciban siempre
// los tipos que declara types.ts.

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function normalizeLines(raw: unknown): PaymentOrderLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((l) => {
    const line = (l ?? {}) as Partial<PaymentOrderLine>;
    return {
      description: String(line.description ?? ''),
      unitValue: num(line.unitValue),
      quantity: num(line.quantity),
      amount: num(line.amount),
    };
  });
}

export function normalizeOrder(row: Record<string, unknown>): PaymentOrder {
  return {
    ...(row as unknown as PaymentOrder),
    lines: normalizeLines(row.lines),
    subtotal: num(row.subtotal),
    fees: num(row.fees),
    total: num(row.total),
  };
}

export function normalizeOrders(rows: unknown[] | null): PaymentOrder[] {
  return (rows ?? []).map((r) => normalizeOrder(r as Record<string, unknown>));
}

// ── Validación del payload ──────────────────────────────────────────────────
// Devuelve el mensaje de error (en castellano, mostrable al usuario) o null si
// el payload es válido. El servidor es la autoridad: la UI valida lo mismo para
// dar feedback inmediato, pero nunca alcanza con eso.

export interface ValidatedInput {
  input: PaymentOrderInput;
  lines: PaymentOrderLine[];
  subtotal: number;
  fees: number;
  total: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const nullable = (v: unknown): string | null => {
  const s = str(v);
  return s === '' ? null : s;
};

export function validateOrderInput(body: unknown): { error: string } | ValidatedInput {
  const input = (body ?? {}) as PaymentOrderInput;

  if (input.locale !== 'es' && input.locale !== 'en') {
    return { error: 'El idioma del documento debe ser "es" o "en".' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str(input.issue_date))) {
    return { error: 'La fecha de emisión es obligatoria (formato YYYY-MM-DD).' };
  }
  if (input.payment_date != null && str(input.payment_date) !== '' &&
      !/^\d{4}-\d{2}-\d{2}$/.test(str(input.payment_date))) {
    return { error: 'La fecha de pago debe tener formato YYYY-MM-DD.' };
  }
  if (!str(input.beneficiary_name)) {
    return { error: 'El nombre del beneficiario es obligatorio.' };
  }
  if (!str(input.currency)) {
    return { error: 'La moneda es obligatoria.' };
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    return { error: 'La orden debe tener al menos una línea de detalle.' };
  }

  // Totales SIEMPRE recalculados server-side: lo que mande el cliente en
  // subtotal/total se ignora por completo.
  const { lines, subtotal, fees, total } = computeTotals(input.lines, Number(input.fees) || 0);

  const invalid = lines.find((l) => !l.description || l.amount <= 0);
  if (invalid) {
    return {
      error: !invalid.description
        ? 'Cada línea de detalle debe tener una descripción.'
        : `La línea "${invalid.description}" debe tener un importe mayor a cero.`,
    };
  }
  if (total <= 0) {
    return { error: 'El total de la orden debe ser mayor a cero.' };
  }

  if (input.payment_method !== 'crypto' && input.payment_method !== 'bank') {
    return { error: 'El medio de pago debe ser "crypto" o "bank".' };
  }
  if (input.payment_method === 'crypto') {
    if (!str(input.crypto_wallet)) {
      return { error: 'Para un pago en cripto se requiere la wallet del beneficiario.' };
    }
    if (!str(input.crypto_network)) {
      return { error: 'Para un pago en cripto se requiere la red (TRC20, ERC20, …).' };
    }
  } else {
    if (!str(input.bank_name)) {
      return { error: 'Para una transferencia bancaria se requiere el nombre del banco.' };
    }
    if (!str(input.bank_account_number)) {
      return { error: 'Para una transferencia bancaria se requiere el número de cuenta / IBAN.' };
    }
    if (!str(input.bank_account_holder)) {
      return { error: 'Para una transferencia bancaria se requiere el titular de la cuenta.' };
    }
  }

  return { input, lines, subtotal, fees, total };
}

/**
 * Verifica que un beneficiary_id pertenezca a la empresa del caller.
 *
 * Era el ÚNICO FK del payload que se aceptaba sin verificar (auditoría
 * 2026-08-06): con el admin client (sin RLS), un id ajeno vinculaba la orden
 * al beneficiario de otro tenant. Devuelve true si es null (beneficiario
 * escrito a mano, sin fila en payment_beneficiaries).
 */
export async function beneficiaryBelongsToCompany(
  admin: SupabaseClient,
  companyId: string,
  beneficiaryId: string | null | undefined,
): Promise<boolean> {
  if (!beneficiaryId) return true;
  const { data } = await admin
    .from('payment_beneficiaries')
    .select('id')
    .eq('id', beneficiaryId)
    .eq('company_id', companyId)
    .maybeSingle();
  return !!data;
}

/**
 * Columnas de payment_orders derivadas del payload validado. No incluye
 * company_id, order_number, status ni el bloque de auditoría — esos los pone
 * el endpoint desde el token / la RPC, nunca el cliente.
 */
export function orderFieldsFromInput(v: ValidatedInput): Record<string, unknown> {
  const { input, lines, subtotal, fees, total } = v;
  const isCrypto = input.payment_method === 'crypto';
  return {
    locale: input.locale,
    issue_date: str(input.issue_date),
    payment_date: nullable(input.payment_date),
    beneficiary_id: nullable(input.beneficiary_id),
    beneficiary_name: str(input.beneficiary_name),
    beneficiary_tax_id: nullable(input.beneficiary_tax_id),
    beneficiary_email: nullable(input.beneficiary_email),
    beneficiary_country: nullable(input.beneficiary_country),
    lines,
    currency: str(input.currency).toUpperCase(),
    subtotal,
    fees,
    total,
    payment_method: input.payment_method,
    // Solo se persisten los datos del medio elegido: guardar los dos deja
    // datos bancarios viejos colgados en una orden que se paga en cripto.
    crypto_network: isCrypto ? nullable(input.crypto_network) : null,
    crypto_wallet: isCrypto ? nullable(input.crypto_wallet) : null,
    crypto_memo: isCrypto ? nullable(input.crypto_memo) : null,
    bank_name: isCrypto ? null : nullable(input.bank_name),
    bank_account_holder: isCrypto ? null : nullable(input.bank_account_holder),
    bank_account_number: isCrypto ? null : nullable(input.bank_account_number),
    bank_swift: isCrypto ? null : nullable(input.bank_swift),
    bank_account_type: isCrypto ? null : nullable(input.bank_account_type),
    notes: nullable(input.notes),
  };
}

// ── Libreta de beneficiarios ────────────────────────────────────────────────

/** Escapa los comodines de LIKE para que un nombre con % o _ no matchee de más. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Busca un beneficiario de la empresa por nombre (case-insensitive).
 */
export async function findBeneficiaryByName(
  admin: SupabaseClient,
  companyId: string,
  name: string,
): Promise<PaymentBeneficiary | null> {
  const { data } = await admin
    .from('payment_beneficiaries')
    .select('*')
    .eq('company_id', companyId)
    .ilike('name', escapeLike(name))
    .limit(1)
    .maybeSingle();
  return (data as PaymentBeneficiary | null) ?? null;
}

export interface BeneficiaryPayload {
  name: string;
  tax_id?: string | null;
  email?: string | null;
  country?: string | null;
  default_payment_method?: 'crypto' | 'bank' | null;
  crypto_network?: string | null;
  crypto_wallet?: string | null;
  crypto_memo?: string | null;
  bank_name?: string | null;
  bank_account_holder?: string | null;
  bank_account_number?: string | null;
  bank_swift?: string | null;
  bank_account_type?: string | null;
  notes?: string | null;
}

/**
 * Alta o actualización de un beneficiario en la libreta, matcheando por
 * (company_id, name) case-insensitive. Devuelve la fila resultante o null si
 * la escritura falló (el caller decide si eso es fatal — al guardar una orden
 * NO lo es: la orden ya tiene su propia foto de los datos).
 */
export async function upsertBeneficiary(
  admin: SupabaseClient,
  companyId: string,
  payload: BeneficiaryPayload,
): Promise<PaymentBeneficiary | null> {
  const name = str(payload.name);
  if (!name) return null;

  const fields = {
    name,
    tax_id: nullable(payload.tax_id),
    email: nullable(payload.email),
    country: nullable(payload.country),
    default_payment_method:
      payload.default_payment_method === 'crypto' || payload.default_payment_method === 'bank'
        ? payload.default_payment_method
        : null,
    crypto_network: nullable(payload.crypto_network),
    crypto_wallet: nullable(payload.crypto_wallet),
    crypto_memo: nullable(payload.crypto_memo),
    bank_name: nullable(payload.bank_name),
    bank_account_holder: nullable(payload.bank_account_holder),
    bank_account_number: nullable(payload.bank_account_number),
    bank_swift: nullable(payload.bank_swift),
    bank_account_type: nullable(payload.bank_account_type),
    notes: nullable(payload.notes),
    updated_at: new Date().toISOString(),
  };

  const existing = await findBeneficiaryByName(admin, companyId, name);

  if (existing) {
    const { data, error } = await admin
      .from('payment_beneficiaries')
      .update(fields)
      .eq('id', existing.id)
      .eq('company_id', companyId)
      .select('*')
      .maybeSingle();
    if (error) {
      console.error('[payment-orders] upsertBeneficiary update:', error.message);
      return null;
    }
    return (data as PaymentBeneficiary | null) ?? null;
  }

  const { data, error } = await admin
    .from('payment_beneficiaries')
    .insert({ company_id: companyId, ...fields })
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[payment-orders] upsertBeneficiary insert:', error.message);
    return null;
  }
  return (data as PaymentBeneficiary | null) ?? null;
}

/** Datos de pago de la orden → payload de libreta (para save_beneficiary). */
export function beneficiaryPayloadFromOrder(v: ValidatedInput): BeneficiaryPayload {
  const { input } = v;
  const isCrypto = input.payment_method === 'crypto';
  return {
    name: str(input.beneficiary_name),
    tax_id: nullable(input.beneficiary_tax_id),
    email: nullable(input.beneficiary_email),
    country: nullable(input.beneficiary_country),
    default_payment_method: input.payment_method,
    crypto_network: isCrypto ? nullable(input.crypto_network) : null,
    crypto_wallet: isCrypto ? nullable(input.crypto_wallet) : null,
    crypto_memo: isCrypto ? nullable(input.crypto_memo) : null,
    bank_name: isCrypto ? null : nullable(input.bank_name),
    bank_account_holder: isCrypto ? null : nullable(input.bank_account_holder),
    bank_account_number: isCrypto ? null : nullable(input.bank_account_number),
    bank_swift: isCrypto ? null : nullable(input.bank_swift),
    bank_account_type: isCrypto ? null : nullable(input.bank_account_type),
    notes: nullable(input.notes),
  };
}

// ── Egreso generado al marcar pagada ────────────────────────────────────────

/** Concepto del egreso: "OP-2026-0001 · Proveedor SA", acotado a 120 chars. */
export function expenseConcept(orderNumber: string, beneficiaryName: string): string {
  const full = `${orderNumber} · ${beneficiaryName}`.trim();
  return full.length <= 120 ? full : `${full.slice(0, 117)}…`;
}

// ── ¿En qué período entra el egreso? ────────────────────────────────────────

export interface ExpensePeriodRow {
  id: string;
  year: number;
  month: number;
  is_closed: boolean;
}

const MONTHS_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function periodLabel(year: number, month: number): string {
  return `${MONTHS_ES[month - 1] ?? month} ${year}`;
}

/** El período abierto más reciente — el fallback histórico. */
function latestOpen(periods: ExpensePeriodRow[]): ExpensePeriodRow | null {
  return periods
    .filter((p) => !p.is_closed)
    .sort((a, b) => (b.year - a.year) || (b.month - a.month))[0] ?? null;
}

/**
 * Período contable del egreso de una orden pagada.
 *
 * POR QUÉ NO "el último período abierto" (auditoría 2026-08, A3): una orden
 * marcada pagada con atraso —o cargada a principio de mes por un pago del mes
 * anterior— mandaba su egreso al último período abierto, o sea al MES
 * EQUIVOCADO. El egreso ya se fecha con `payment_date` (expense_date), así que
 * el período tenía que salir de ahí también: si no, la fecha del egreso y el
 * mes que lo contabiliza dicen cosas distintas y la cadena de socios reparte
 * sobre un mes que no gastó esa plata.
 *
 * Si el período del pago no existe o está cerrado se cae al último abierto —
 * bloquear el pago sería peor — pero SIEMPRE con warning: ese desvío tiene que
 * llegar al usuario, que es el único que puede decidir si reabre el mes.
 *
 * Pura a propósito: es una regla de dinero y se testea sin Supabase.
 */
export function pickExpensePeriod(
  periods: ExpensePeriodRow[],
  paymentDate: string | null | undefined,
): { periodId: string | null; warning: string | null } {
  const fallback = latestOpen(periods);
  const noOpenWarning =
    'La orden quedó marcada como pagada, pero no hay un período abierto: el egreso no se registró automáticamente.';

  const match = /^(\d{4})-(\d{2})/.exec(String(paymentDate ?? ''));
  if (!match) {
    // Sin fecha de pago no hay mes que respetar: se mantiene el comportamiento
    // histórico (último abierto).
    if (!fallback) return { periodId: null, warning: noOpenWarning };
    return { periodId: fallback.id, warning: null };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const exact = periods.find((p) => p.year === year && p.month === month) ?? null;

  if (exact && !exact.is_closed) return { periodId: exact.id, warning: null };

  if (!fallback) return { periodId: null, warning: noOpenWarning };

  const reason = exact
    ? `el período ${periodLabel(year, month)} está cerrado`
    : `no existe el período ${periodLabel(year, month)}`;
  return {
    periodId: fallback.id,
    warning:
      `El egreso se registró en ${periodLabel(fallback.year, fallback.month)} porque ${reason}. ` +
      'Revisalo: la fecha del pago corresponde a otro mes.',
  };
}

/**
 * Crea el egreso correspondiente a una orden pagada, en el período de la FECHA
 * DE PAGO (ver pickExpensePeriod). Si ese período no existe o está cerrado cae
 * al último abierto con un warning; si no hay ninguno abierto NO es un error:
 * la orden se marca pagada igual y se devuelve el warning para que la UI se lo
 * diga al usuario (cargarlo a mano es preferible a bloquear el pago).
 */
export async function createExpenseForPaidOrder(
  admin: SupabaseClient,
  companyId: string,
  order: {
    id: string;
    order_number: string;
    beneficiary_name: string;
    total: number;
    /** Traza del pago: se copia al egreso para no cargarla dos veces. */
    payment_reference?: string | null;
    payment_date?: string | null;
    payment_proof_path?: string | null;
    payment_proof_name?: string | null;
    payment_proof_mime?: string | null;
    payment_proof_size?: number | null;
    payment_proof_uploaded_at?: string | null;
  },
  /** Categoría del egreso a registrar. Opcional: null = sin categoría, igual
   *  que un egreso cargado a mano sin elegirla. */
  category?: string | null,
): Promise<{ expenseId: string | null; warning: string | null }> {
  // Se traen TODOS los períodos (no solo los abiertos): para saber si el mes
  // del pago existe-pero-está-cerrado hay que poder verlo.
  const { data: periodRows, error: periodErr } = await admin
    .from('periods')
    .select('id, year, month, is_closed')
    .eq('company_id', companyId);

  if (periodErr) {
    console.error('[payment-orders] períodos:', periodErr.message);
  }

  const { periodId, warning: periodWarning } = pickExpensePeriod(
    (periodRows ?? []) as ExpensePeriodRow[],
    order.payment_date,
  );
  if (!periodId) {
    return { expenseId: null, warning: periodWarning };
  }

  // Candado anti-duplicado por payment_order_id (migración 079): NO se depende
  // sólo de payment_orders.expense_id, que se pierde si /upload borra el egreso
  // (on delete set null). Si YA existe un egreso para esta orden, se reutiliza
  // —re-vinculando el puntero desde el caller— en vez de crear un segundo.
  const { data: existing } = await admin
    .from('expenses')
    .select('id')
    .eq('company_id', companyId)
    .eq('payment_order_id', order.id)
    .maybeSingle();
  if (existing?.id) {
    return { expenseId: existing.id as string, warning: periodWarning };
  }

  const total = num(order.total);
  const { data: expense, error } = await admin
    .from('expenses')
    .insert({
      company_id: companyId,
      period_id: periodId,
      concept: expenseConcept(order.order_number, order.beneficiary_name),
      amount: total,
      paid: total,
      pending: 0,
      is_fixed: false,
      category: str(category) || null,
      // Vínculo egreso → orden, para que Egresos pueda linkear al detalle de la
      // OP. La orden guarda además expense_id (vínculo inverso) desde el caller.
      payment_order_id: order.id,

      // La fecha del egreso es la del PAGO, no la de hoy: si la orden se marca
      // pagada con unos días de atraso, fecharla hoy la manda al período
      // equivocado.
      expense_date: str(order.payment_date) || null,

      // Traza heredada de la orden (migración 060). Es la misma plata, así
      // que duplicar la carga a mano solo abriría la puerta a que difieran.
      reference: str(order.payment_reference) || null,
      // El archivo NO se copia: el egreso apunta al comprobante original en
      // el bucket de la orden. Por eso hace falta guardar cuál es.
      attachment_bucket: order.payment_proof_path ? 'payment-proofs' : null,
      attachment_path: str(order.payment_proof_path) || null,
      attachment_name: str(order.payment_proof_name) || null,
      attachment_mime: str(order.payment_proof_mime) || null,
      attachment_size: order.payment_proof_size ?? null,
      attachment_uploaded_at: str(order.payment_proof_uploaded_at) || null,
    })
    .select('id')
    .maybeSingle();

  if (error || !expense?.id) {
    // Backstop de carrera: si dos "marcar pagada" corren a la vez, el índice
    // único parcial (migración 079) rechaza el segundo insert con 23505. Eso NO
    // es un fallo: significa que el otro ya creó el egreso. Se recupera su id.
    if (error?.code === '23505') {
      const { data: raced } = await admin
        .from('expenses')
        .select('id')
        .eq('company_id', companyId)
        .eq('payment_order_id', order.id)
        .maybeSingle();
      if (raced?.id) {
        return { expenseId: raced.id as string, warning: periodWarning };
      }
    }
    console.error('[payment-orders] alta de egreso:', error?.message);
    return {
      expenseId: null,
      warning:
        'La orden quedó marcada como pagada, pero el egreso no se pudo registrar automáticamente. Cargalo a mano en Egresos.',
    };
  }

  // El warning del período (mes cerrado / inexistente) viaja aunque el egreso
  // se haya creado bien: el usuario tiene que enterarse de que fue a otro mes.
  return { expenseId: expense.id as string, warning: periodWarning };
}

// ── Nombre del actor ────────────────────────────────────────────────────────

/**
 * Nombre a desnormalizar en los campos *_name. verifyAdminAuth ya lo trae del
 * perfil (company_users.name / platform_users.name); el fallback al email evita
 * dejar un sello de auditoría vacío si el perfil no tiene nombre cargado.
 */
export function actorName(auth: { name?: string; email?: string }): string {
  return str(auth.name) || str(auth.email) || 'Usuario';
}
