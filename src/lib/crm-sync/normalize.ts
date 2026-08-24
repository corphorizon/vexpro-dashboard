// ─────────────────────────────────────────────────────────────────────────────
// Normalizadores del espejo CRM (Orion Mongo) → filas de la migración 088.
//
// TODO lo de este archivo es PURO: cero red, cero Supabase, cero Mongo. Es lo
// único del sync que se puede testear de verdad, así que acá vive toda la
// decisión sobre datos sucios y cada trampa queda documentada con su porqué.
//
// Las trampas confirmadas contra la data real (13.524 retiros / 39.413
// depósitos de Vex Pro, analítica 2026-08-24) están en la cabecera de
// supabase/migration-088-withdrawal-review.sql. Acá se implementan:
//
//   1. `deposits.depositValue` está CORRUPTO en parte del histórico (máx
//      1,4e16): es la INTENCIÓN del usuario, no dinero. El dinero real es
//      `amountPaid`. Guardamos amountPaid en amount_paid y depositValue en
//      deposit_value sólo como informativo — y si supera el umbral absurdo lo
//      guardamos como null para que nadie lo sume por accidente.
//   2. `totalDepositLifetime` / `totalWithdrawLifetime` NO son confiables
//      (sólo se acumulan en los completados). Se copian a las columnas crm_*
//      para poder comparar, y no se usan para nada más.
//   3. `walletType` NO es el método de pago (todo 'BALANCE'). Por eso NO se
//      mapea a `processor` en depósitos: processor sólo existe en retiros,
//      donde el CRM sí trae COINSBUY / PAYPROS_SPEI / vacío.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  CrmDepositRow,
  CrmUserRow,
  CrmWithdrawalRow,
  DepositStatusNorm,
  MongoDoc,
  WithdrawalStatusNorm,
} from './types';

// ── Helpers de tipos sucios ──────────────────────────────────────────────────

/**
 * Fecha de Mongo → ISO. Acepta Date, string, epoch en ms y el `{$date: …}` del
 * BSON extendido. Cualquier cosa que no sea una fecha válida devuelve null:
 * preferimos un hueco visible a un 1970-01-01 que se cuela en los filtros.
 */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'object') {
    const inner = (value as { $date?: unknown }).$date;
    if (inner !== undefined) return toIso(inner);
  }
  return null;
}

/**
 * Número defensivo: null si no es finito. Los importes del CRM llegan a veces
 * como string ("125.50") y a veces como Decimal128, así que se acepta todo lo
 * que se pueda leer sin inventar. `true`/`false` NO son 1/0: eso sería tragar
 * un error de esquema en silencio.
 */
export function toNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return null;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'object') {
    // Decimal128 / Long del driver: `{$numberDecimal: "…"}` o un _bsontype con
    // toString() útil.
    const dec = (value as { $numberDecimal?: unknown }).$numberDecimal;
    if (dec !== undefined) return toNum(dec);
    if (typeof (value as { _bsontype?: unknown })._bsontype === 'string') {
      return toNum(String(value));
    }
  }
  return null;
}

/** Texto defensivo: null si viene vacío. Nunca devuelve "undefined"/"null". */
export function toStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const s = value.trim();
    return s === '' ? null : s;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    // ObjectId y compañía: su toString() es el hex, que es exactamente lo que
    // queremos como identificador externo.
    if (typeof (value as { _bsontype?: unknown })._bsontype === 'string') {
      const s = String(value).trim();
      return s === '' ? null : s;
    }
    return null;
  }
  return null;
}

// ── Estados ──────────────────────────────────────────────────────────────────

/**
 * Vocabulario REAL medido en prod (13.524 retiros):
 *   COMPLETED 12006 · REJECTED 915 · CANCELLED 570 · CANCELED 6 (sic, con una
 *   sola L) · ON_HOLD 24 · REQUESTED 2 · IN_PROCESS 1.
 *
 * CANCELLED lo cancela el CLIENTE: no es una decisión nuestra y por eso tiene
 * un estado propio, distinto de 'rejected'.
 */
const WITHDRAWAL_STATUS_MAP: Record<string, WithdrawalStatusNorm> = {
  COMPLETED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  CANCELED: 'cancelled', // typo del CRM, 6 casos reales. Mismo significado.
  ON_HOLD: 'pending',
  REQUESTED: 'pending',
  IN_PROCESS: 'pending',
};

/** Vocabulario REAL medido en prod (39.413 depósitos). */
const DEPOSIT_STATUS_MAP: Record<string, DepositStatusNorm> = {
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  CANCELED: 'cancelled', // mismo typo que en retiros: lo cubrimos por las dudas.
  REQUESTED: 'pending',
  IN_REVIEW: 'in_review',
};

/**
 * Canoniza el string antes de mapear: espacios y guiones a `_`, mayúsculas.
 * No es para inventar equivalencias, es para que un 'in process' o un
 * 'ON-HOLD' no se convierta en un 'unknown' que dispare una alarma falsa.
 */
function canonStatus(value: unknown): string | null {
  const s = toStr(value);
  if (s === null) return null;
  return s.toUpperCase().replace(/[\s-]+/g, '_');
}

/**
 * Un estado que no está en el mapa devuelve 'unknown' A PROPÓSITO: si el CRM
 * agrega uno nuevo tenemos que enterarnos (el sync lo reporta en
 * `unknownStatuses`), no tragarlo asumiendo que es pendiente o aprobado.
 */
export function normalizeWithdrawalStatus(value: unknown): WithdrawalStatusNorm {
  const key = canonStatus(value);
  if (key === null) return 'unknown';
  return WITHDRAWAL_STATUS_MAP[key] ?? 'unknown';
}

export function normalizeDepositStatus(value: unknown): DepositStatusNorm {
  const key = canonStatus(value);
  if (key === null) return 'unknown';
  return DEPOSIT_STATUS_MAP[key] ?? 'unknown';
}

// ── Trampa 1: depositValue corrupto ──────────────────────────────────────────

/**
 * Umbral de lo absurdo. El máximo real medido es 1,4e16 y la suma de los
 * cancelados da 5,7e16; ningún depósito legítimo de un broker retail se acerca
 * a 1e12 (un billón). Por encima de eso el valor es basura del CRM, no dinero.
 */
export const ABSURD_DEPOSIT_VALUE = 1e12;

/** true si `depositValue` es un número legible PERO absurdo (basura). */
export function isAbsurdDepositValue(value: unknown): boolean {
  const n = toNum(value);
  return n !== null && Math.abs(n) >= ABSURD_DEPOSIT_VALUE;
}

/** depositValue saneado: null si es basura, para que nadie lo sume por error. */
export function sanitizeDepositValue(value: unknown): number | null {
  const n = toNum(value);
  if (n === null) return null;
  return Math.abs(n) >= ABSURD_DEPOSIT_VALUE ? null : n;
}

// ── raw jsonb ────────────────────────────────────────────────────────────────

const RAW_MAX_DEPTH = 6;

/**
 * Convierte el documento de Mongo a algo que jsonb acepte: ObjectId/Decimal128
 * a string, Date a ISO, NaN/Infinity a null (jsonb no los admite y revientan
 * el INSERT entero). Corta a profundidad 6: si algún día aparece un documento
 * ciclado o absurdamente anidado, guardamos su representación textual en vez
 * de colgar el sync.
 */
function jsonSafe(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;

  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') return Number.isFinite(value as number) ? value : null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (t !== 'object') return String(value);
  if (typeof (value as { _bsontype?: unknown })._bsontype === 'string') {
    return String(value);
  }
  if (depth <= 0) return String(value);
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v, depth - 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = jsonSafe(v, depth - 1);
  }
  return out;
}

/**
 * `raw` = el documento entero, menos lo inútil o pesado. Guardamos el doc
 * completo porque el módulo de revisión va a querer campos que hoy no tienen
 * columna (hash, payoutId, internalConcept…) sin tener que volver al CRM.
 */
export function toRaw(doc: MongoDoc, dropKeys: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (dropKeys.includes(k)) continue;
    out[k] = jsonSafe(v, RAW_MAX_DEPTH);
  }
  return out;
}

/** `__v` es ruido de Mongoose: no aporta nada y aparece en todos los docs. */
const DROP_ALWAYS = ['__v'] as const;

/**
 * En `users` además se descarta `hierarchy`: es el árbol de patrocinadores
 * completo (array que crece sin techo con la red del cliente) y multiplica el
 * peso del jsonb sin que el módulo de revisión lo use. El vínculo directo que
 * sí importa queda en sponsor_username / sponsorClientId.
 */
const DROP_USERS = [...DROP_ALWAYS, 'hierarchy'] as const;

// ── Mapeos a filas ───────────────────────────────────────────────────────────

/**
 * `withdrawId` es la llave de negocio; si faltara caemos a `_id`. Si no hay
 * ninguna de las dos devolvemos null: una fila sin external_id rompería el
 * UNIQUE (company_id, external_id) y no se podría re-sincronizar nunca.
 */
export function toWithdrawalRow(
  doc: MongoDoc,
  companyId: string,
  syncedAt: string = new Date().toISOString(),
): CrmWithdrawalRow | null {
  const externalId = toStr(doc.withdrawId) ?? toStr(doc._id);
  if (!externalId) return null;

  return {
    company_id: companyId,
    external_id: externalId,
    user_external_id: toStr(doc.userId),
    username: toStr(doc.username),
    email: toStr(doc.email),
    requested_amount: toNum(doc.requestedAmount),
    transaction_amount: toNum(doc.transactionAmount),
    fee: toNum(doc.fee),
    coin: toStr(doc.coin),
    network: toStr(doc.network),
    // Sólo los retiros traen procesador real (COINSBUY / PAYPROS_SPEI / vacío).
    processor: toStr(doc.processor),
    status_raw: toStr(doc.status),
    status_norm: normalizeWithdrawalStatus(doc.status),
    type: toStr(doc.type),
    requested_at: toIso(doc.requestedDate),
    authorized_at: toIso(doc.authorizedDate),
    processed_at: toIso(doc.processedDate),
    target_address: toStr(doc.targetAddress),
    // Trampa 2: se copian pero NO se usan para el score.
    crm_total_deposit_lifetime: toNum(doc.totalDepositLifetime),
    crm_total_withdraw_lifetime: toNum(doc.totalWithdrawLifetime),
    raw: toRaw(doc, DROP_ALWAYS),
    synced_at: syncedAt,
  };
}

export function toDepositRow(
  doc: MongoDoc,
  companyId: string,
  syncedAt: string = new Date().toISOString(),
): CrmDepositRow | null {
  const externalId = toStr(doc.depositId) ?? toStr(doc._id);
  if (!externalId) return null;

  return {
    company_id: companyId,
    external_id: externalId,
    user_external_id: toStr(doc.userId),
    // Trampa 1: amountPaid es EL dinero.
    amount_paid: toNum(doc.amountPaid),
    // Trampa 1: depositValue es intención, y encima corrupta. Se sanea.
    deposit_value: sanitizeDepositValue(doc.depositValue),
    coin: toStr(doc.coin),
    network: toStr(doc.network),
    external_payment_id: toStr(doc.externalPaymentId),
    is_fiat: typeof doc.isFIATPayment === 'boolean' ? doc.isFIATPayment : null,
    status_raw: toStr(doc.depositStatus),
    status_norm: normalizeDepositStatus(doc.depositStatus),
    type: toStr(doc.depositType),
    deposit_at: toIso(doc.depositDate),
    // Trampa 3: `walletType` es 'BALANCE' en todos los depósitos — NO es el
    // método de pago. No se mapea a nada; queda en `raw` por si sirve de dato.
    raw: toRaw(doc, DROP_ALWAYS),
    synced_at: syncedAt,
  };
}

export function toUserRow(
  doc: MongoDoc,
  companyId: string,
  syncedAt: string = new Date().toISOString(),
): CrmUserRow | null {
  const userExternalId = toStr(doc.userId) ?? toStr(doc.clientId) ?? toStr(doc._id);
  if (!userExternalId) return null;

  // `pendingFeeDebt` es un objeto {amount, concept}: nos quedamos con el monto.
  const debt = doc.pendingFeeDebt;
  const pendingFeeDebt =
    debt && typeof debt === 'object'
      ? toNum((debt as { amount?: unknown }).amount)
      : toNum(debt);

  return {
    company_id: companyId,
    user_external_id: userExternalId,
    username: toStr(doc.username),
    email: toStr(doc.email),
    // `countryCode` NO es el país: es el prefijo telefónico. Se usa el nombre
    // del país y, si no está, el ISO.
    country: toStr(doc.country) ?? toStr(doc.countryISOCode),
    status: toStr(doc.status),
    kyc_status: toStr(doc.kycStatus),
    user_type: toStr(doc.userType),
    register_date: toIso(doc.registerDate) ?? toIso(doc.createdAt),
    sponsor_username: toStr(doc.sponsorUsername),
    // `rank` puede venir número o string según el broker: la columna es text.
    rank: toStr(doc.rank),
    pending_fee_debt: pendingFeeDebt,

    // ── Campos que consume Atlas (cotejados el 2026-08-25) ────────────────
    // `updatedAt` de Orion. Es EL CURSOR de quien consuma: sin esto, un
    // consumidor no puede sostener su avance incremental y reescribe las
    // 20.918 filas en cada pasada.
    source_updated_at: toIso(doc.updatedAt),
    first_name: toStr(doc.name),
    last_name: toStr(doc.lastName),
    // SIN normalizar a propósito: es la cuarta llave del cruce con el CRM de
    // Atlas, y se muestra crudo para que el agente vea qué había cuando la
    // normalización falló. La normalización se queda de su lado, que ya la
    // tiene: duplicarla acá es cómo se divergen dos implementaciones.
    phone_raw: toStr(doc.phone),
    // `countryCode` NO es el país: es el prefijo telefónico. Va aparte
    // justamente para poder normalizar el teléfono.
    phone_country_code: toStr(doc.countryCode),
    // `country` es el nombre largo ("Colombia") y no sirve para agrupar.
    country_iso: toStr(doc.countryISOCode),
    language: toStr(doc.preferredLanguage),
    // NO es lo mismo que sponsor_username, y no se puede derivar uno del otro.
    sponsor_email: toStr(doc.sponsorEmail),
    ib_program_name: toStr(doc.ibProgramName),
    ib_program_broker_name: toStr(doc.ibProgramBrokerName),
    raw: toRaw(doc, DROP_USERS),
    synced_at: syncedAt,
  };
}

/**
 * Marca temporal del documento para el cursor incremental. `updatedAt` es la
 * buena; `createdAt` es el respaldo para los docs viejos que nunca se tocaron
 * y no tienen updatedAt.
 */
export function docWatermark(doc: MongoDoc): string | null {
  return toIso(doc.updatedAt) ?? toIso(doc.createdAt);
}
