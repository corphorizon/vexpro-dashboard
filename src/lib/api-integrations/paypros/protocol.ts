// ─────────────────────────────────────────────────────────────────────────────
// Pay-Pros — protocolo del webhook (funciones PURAS, sin I/O)
//
// Pay-Pros (https://developers.pay-pros.com/webhook) es PUSH puro: no expone
// endpoint de listado ni de consulta de transacciones. La ÚNICA forma de
// enterarse de un depósito es el webhook. Por eso todo lo que sigue es
// deliberadamente defensivo y está aislado en funciones puras testeables:
// si acá nos equivocamos, el dinero simplemente no existe para el dashboard.
//
// Formato "outgoing" (lo que Pay-Pros nos manda) — HTTP POST, body TEXTO PLANO
// (NO json), campos concatenados con "&" en este orden EXACTO:
//
//   datetime & notifyReference & uid & amount & currencyCode & status & signature
//
// Ejemplo literal de la doc:
//   2023-03-03T09:45:15&76&BAN0009876236&10&USD&4&0d15132a...0494d
//
// Formato "ingoing" (lo que tenemos que contestar en <20s, text/plain 200):
//
//   errorCode & notifyReference & uid & amount & currencyCode & signature
//
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, timingSafeEqual } from 'crypto';

// ── Tipos ────────────────────────────────────────────────────────────────

/**
 * Códigos de estado de Pay-Pros. Solo el 4 es un DEPÓSITO cobrado.
 *   1 approved (refund)
 *   2 declined (refund)
 *   4 PAID          (cash & bank)  → DEPÓSITO
 *   5 unpaid / timed-up (cash & bank)
 *   6 paid (payout)                → RETIRO
 *   7 declined (payout)
 */
export const PAYPROS_STATUS_CODES = [1, 2, 4, 5, 6, 7] as const;
export type PayprosStatusCode = (typeof PAYPROS_STATUS_CODES)[number];

export type PayprosStatusLabel =
  | 'refund_approved'
  | 'refund_declined'
  | 'paid'
  | 'unpaid'
  | 'payout_paid'
  | 'payout_declined';

const STATUS_LABELS: Record<PayprosStatusCode, PayprosStatusLabel> = {
  1: 'refund_approved',
  2: 'refund_declined',
  4: 'paid',
  5: 'unpaid',
  6: 'payout_paid',
  7: 'payout_declined',
};

/** El único status que suma como depósito cobrado. */
export const PAYPROS_DEPOSIT_STATUS: PayprosStatusCode = 4;

/** Notificación entrante ya parseada y validada estructuralmente. */
export interface PayprosOutgoing {
  /** Tal cual vino: 'YYYY-mm-ddTHH:i:s' en hora de LIMA (GMT-5). */
  datetime: string;
  /** Identificador único de la NOTIFICACIÓN (no de la transacción). */
  notifyReference: string;
  /** Identificador de la TRANSACCIÓN en Pay-Pros. */
  uid: string;
  /** String original del monto (se conserva porque la firma se calcula sobre él). */
  amountRaw: string;
  amount: number;
  currencyCode: string;
  status: PayprosStatusCode;
  /** Firma sha256 en hex, tal cual vino. */
  signature: string;
}

/**
 * Variantes de concatenación aceptadas al verificar la firma.
 *
 * La doc dice literalmente que la firma es "sha256 de la concatenación de los
 * parámetros previos en el orden mostrado, con la signature key", pero NO
 * aclara si los campos van pegados o separados por "&" (el body sí usa "&"),
 * ni si la key entra como un campo más de la concatenación. Como no tenemos
 * la sign key de prueba para reproducir el ejemplo de la doc, aceptamos las
 * tres lecturas razonables:
 *
 *   'concat'     → f1 + f2 + ... + fn + key            (lectura más literal)
 *   'amp'        → f1 & f2 & ... & fn & key            (key como campo extra)
 *   'amp-fields' → (f1 & f2 & ... & fn) + key          (mismo separador del body)
 *
 * NUNCA aceptamos un webhook cuya firma no coincida con NINGUNA variante.
 * `verifyOutgoingSignature` devuelve cuál coincidió, y la respuesta se firma
 * con ESA MISMA variante: si el merchant usa 'amp' para firmar, es la lectura
 * correcta de la doc y también es la que espera al validar nuestra respuesta.
 */
export type SignatureVariant = 'concat' | 'amp' | 'amp-fields';

export const SIGNATURE_VARIANTS: readonly SignatureVariant[] = [
  'concat',
  'amp',
  'amp-fields',
] as const;

/** Variante por defecto (la lectura más literal de la doc). */
export const DEFAULT_SIGNATURE_VARIANT: SignatureVariant = 'concat';

// ── Parseo ───────────────────────────────────────────────────────────────

/** 'YYYY-mm-ddTHH:i:s' — sin zona, sin milisegundos. */
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/**
 * true si el string cumple el formato Y representa una fecha/hora que
 * existe. Rechaza '2026-02-31T00:00:00' (JS lo desbordaría a marzo) y
 * '2026-01-01T25:00:00'.
 */
function isRealDatetime(datetime: string): boolean {
  if (!DATETIME_RE.test(datetime)) return false;
  const d = new Date(`${datetime}Z`);
  if (Number.isNaN(d.getTime())) return false;
  // Si hubo desbordamiento, el ISO reconstruido no coincide con el original.
  return d.toISOString().slice(0, 19) === datetime;
}

/**
 * Parsea el body crudo del webhook. Devuelve `null` ante cualquier
 * desviación del formato — preferimos rechazar (errorCode 2) antes que
 * adivinar y persistir plata mal atribuida.
 */
export function parseOutgoing(body: string): PayprosOutgoing | null {
  if (typeof body !== 'string') return null;
  // Algunos clientes HTTP agregan \r\n final; el resto de los espacios NO se
  // tocan porque la firma se calcula sobre los bytes exactos de cada campo.
  const trimmed = body.trim();
  if (!trimmed) return null;

  const parts = trimmed.split('&');
  if (parts.length !== 7) return null;

  const [datetime, notifyReference, uid, amountRaw, currencyCode, statusRaw, signature] = parts;

  // Formato + fecha REAL. `Date.parse` no sirve sola: '2026-02-31' no da NaN,
  // se desborda a marzo. Comparamos el roundtrip para rechazar imposibles.
  if (!isRealDatetime(datetime)) return null;

  if (!notifyReference || !uid || !currencyCode) return null;

  // El monto tiene que ser un decimal finito y no negativo.
  if (!/^\d+(\.\d+)?$/.test(amountRaw)) return null;
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount)) return null;

  if (!/^\d+$/.test(statusRaw)) return null;
  const status = Number(statusRaw) as PayprosStatusCode;
  if (!(PAYPROS_STATUS_CODES as readonly number[]).includes(status)) return null;

  // sha256 hex = 64 caracteres.
  if (!/^[0-9a-fA-F]{64}$/.test(signature)) return null;

  return {
    datetime,
    notifyReference,
    uid,
    amountRaw,
    amount,
    currencyCode,
    status,
    signature,
  };
}

// ── Firma ────────────────────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function concatenate(fields: string[], keys: string[], variant: SignatureVariant): string {
  switch (variant) {
    case 'concat':
      return fields.join('') + keys.join('');
    case 'amp':
      return [...fields, ...keys].join('&');
    case 'amp-fields':
      return fields.join('&') + keys.join('');
  }
}

/** Los 6 campos firmados de una notificación entrante, en orden. */
export function outgoingSignedFields(p: PayprosOutgoing): string[] {
  return [p.datetime, p.notifyReference, p.uid, p.amountRaw, p.currencyCode, String(p.status)];
}

/**
 * Calcula la firma esperada de una notificación entrante.
 * Función PURA: no toca red ni DB, se testea con vectores fijos.
 */
export function computeOutgoingSignature(
  fields: PayprosOutgoing | string[],
  signKey: string,
  variant: SignatureVariant = DEFAULT_SIGNATURE_VARIANT,
): string {
  const arr = Array.isArray(fields) ? fields : outgoingSignedFields(fields);
  return sha256Hex(concatenate(arr, [signKey], variant));
}

/** Comparación en tiempo constante de dos hex de igual longitud. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a.toLowerCase(), 'utf8');
  const bufB = Buffer.from(b.toLowerCase(), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface SignatureCheck {
  valid: boolean;
  /** Variante con la que coincidió; null si no coincidió ninguna. */
  variant: SignatureVariant | null;
}

/**
 * Verifica la firma probando TODAS las variantes documentadas arriba.
 * Comparación en tiempo constante (`crypto.timingSafeEqual`) para no
 * filtrar por timing cuánto prefijo acertó un atacante.
 */
export function verifyOutgoingSignature(
  parsed: PayprosOutgoing,
  signKey: string,
): SignatureCheck {
  if (!signKey) return { valid: false, variant: null };
  const fields = outgoingSignedFields(parsed);
  let matched: SignatureVariant | null = null;
  for (const variant of SIGNATURE_VARIANTS) {
    const expected = sha256Hex(concatenate(fields, [signKey], variant));
    // No cortamos el loop al primer match: mantener el costo constante
    // evita que el tiempo de respuesta revele qué variante usa el merchant.
    if (safeEqualHex(expected, parsed.signature) && matched === null) {
      matched = variant;
    }
  }
  return { valid: matched !== null, variant: matched };
}

// ── Respuesta (ingoing string) ───────────────────────────────────────────

/**
 * errorCode del ingoing string:
 *   0 → todo ok
 *   1 → error de firma
 *   2 → inconsistencia de datos
 */
export type PayprosErrorCode = 0 | 1 | 2;

/**
 * Construye el "ingoing string" que Pay-Pros espera como body de la
 * respuesta (text/plain, HTTP 200, en menos de 20 segundos):
 *
 *   errorCode & notifyReference & uid & amount & currencyCode & signature
 *
 * La firma de la respuesta es sha256 de la concatenación de esos 5 campos
 * "con la signature key AND THE API KEY" (en ese orden, según la doc).
 */
export function buildIngoingResponse(
  errorCode: PayprosErrorCode,
  parsed: Pick<PayprosOutgoing, 'notifyReference' | 'uid' | 'amountRaw' | 'currencyCode'>,
  signKey: string,
  apiKey: string,
  variant: SignatureVariant = DEFAULT_SIGNATURE_VARIANT,
): string {
  const fields = [
    String(errorCode),
    parsed.notifyReference,
    parsed.uid,
    parsed.amountRaw,
    parsed.currencyCode,
  ];
  const signature = sha256Hex(concatenate(fields, [signKey, apiKey], variant));
  return [...fields, signature].join('&');
}

/**
 * Respuesta de emergencia para cuando el body ni siquiera se pudo parsear
 * (no tenemos notifyReference/uid/amount que devolver). Mandamos errorCode 2
 * con los campos vacíos: Pay-Pros no puede correlacionarla, pero es mejor
 * que un 500 vacío — al menos cierra la entrega del lado de ellos y nos
 * queda el crudo guardado para reprocesar a mano.
 */
export function buildUnparseableResponse(signKey: string, apiKey: string): string {
  return buildIngoingResponse(
    2,
    { notifyReference: '', uid: '', amountRaw: '', currencyCode: '' },
    signKey,
    apiKey,
  );
}

// ── Fechas ───────────────────────────────────────────────────────────────

/**
 * Convierte el `datetime` de Pay-Pros (hora de LIMA, GMT-5) a ISO UTC.
 *
 * Perú NO tiene horario de verano desde 1994, así que el offset es fijo
 * -05:00 todo el año: no hace falta una tz database. Devuelve null si el
 * formato no es el documentado.
 */
export function limaToUtcIso(datetime: string): string | null {
  if (!isRealDatetime(datetime)) return null;
  const ms = Date.parse(`${datetime}-05:00`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

// ── Normalización a api_transactions ─────────────────────────────────────

/**
 * Fila lista para upsert en `api_transactions`. No usamos `ProviderDataset`
 * ni `ProviderSlug` porque esos tipos alimentan switches EXHAUSTIVOS en
 * totals.ts / persistence.ts: agregar 'paypros' ahí rompe la compilación de
 * archivos que no me corresponde tocar. Ver nota en README del reporte.
 */
export interface PayprosNormalizedTx {
  provider: 'paypros';
  /** uid de la transacción en Pay-Pros → api_transactions.external_id. */
  external_id: string;
  amount: number;
  /** Pay-Pros no informa comisión en el webhook. */
  fee: number;
  currency: string;
  status: PayprosStatusLabel;
  /** ISO UTC (convertido desde hora de Lima). */
  transaction_date: string;
  raw: Record<string, unknown>;
}

/** Slug con el que se guarda en api_transactions.provider. */
export const PAYPROS_PROVIDER = 'paypros' as const;

/**
 * Traduce una notificación validada a la fila canónica.
 *
 * CÓMO LO VAN A CONSUMIR LOS TOTALES: solo `status = 'paid'` (código 4) es un
 * depósito cobrado. El día que se sumen los Pay-Pros a los totales hay que
 * agregar `paypros: ['paid']` al mapa ACCEPTED de
 * `loadPersistedTotals` (persistence.ts) y `paypros: 'paid'` a
 * `ACCEPTED_STATUS` + un `case 'paypros'` en `computeProviderTotals`
 * (totals.ts), además de sumar 'paypros' a `ProviderSlug` en types.ts.
 * 'payout_paid' (6) es un RETIRO y debería restar, no sumar; los demás
 * estados quedan guardados como historial y no cuentan.
 */
export function toNormalizedTx(parsed: PayprosOutgoing): PayprosNormalizedTx | null {
  const transactionDate = limaToUtcIso(parsed.datetime);
  if (!transactionDate) return null;

  return {
    provider: PAYPROS_PROVIDER,
    external_id: parsed.uid,
    amount: parsed.amount,
    fee: 0,
    currency: parsed.currencyCode,
    status: STATUS_LABELS[parsed.status],
    transaction_date: transactionDate,
    raw: {
      datetime: parsed.datetime,
      datetimeTz: 'America/Lima (GMT-5)',
      notifyReference: parsed.notifyReference,
      uid: parsed.uid,
      amount: parsed.amountRaw,
      currencyCode: parsed.currencyCode,
      status: parsed.status,
      statusLabel: STATUS_LABELS[parsed.status],
    },
  };
}

/** Etiqueta legible de un código de estado. */
export function statusLabel(code: PayprosStatusCode): PayprosStatusLabel {
  return STATUS_LABELS[code];
}

/** true si la notificación representa un depósito cobrado (status 4). */
export function isDeposit(parsed: PayprosOutgoing): boolean {
  return parsed.status === PAYPROS_DEPOSIT_STATUS;
}
