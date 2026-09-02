// ─────────────────────────────────────────────────────────────────────────────
// Normalizadores y cálculos PUROS del hedge fund.
//
// Todo lo de este archivo es puro: cero red, cero Mongo, cero Supabase. Es lo
// único del módulo que se puede testear de verdad, así que acá vive cada
// decisión sobre datos sucios con su porqué. Mismo reparto que
// `crm-sync/normalize.ts` (lo puro) contra `crm-sync/sync.ts` (lo que toca la
// red).
//
// Los helpers de tipos sucios —`toIso`, `toNum`, `toStr`, `toRaw`— se IMPORTAN
// de `crm-sync/normalize.ts` y no se reescriben: son exactamente el mismo
// problema (Decimal128, ObjectId, `{$date}`) y una segunda copia es el modo de
// falla número uno del repo (§1.1).
//
// ── LAS TRAMPAS DE ESTE DOMINIO, MEDIDAS EL 2026-09-02 ─────────────────────
//
//  1. `hedgefunds.expectedReturn` es TEXTO LIBRE ('22-26%'). No es un número y
//     no se puede sumar. Se guarda crudo Y parseado; el parseo puede fallar y
//     cuando falla vale `null`, nunca 0 (§1.3: «no lo sabemos» ≠ «no rinde»).
//
//  2. `users.totalAmountByHedge` está en CERO para todos los usuarios de las
//     dos empresas. Es la fuente que parecía obvia y es la que miente. El
//     capital sale de `hedgefundinvestments.balance`. DESCARTADA a propósito.
//
//  3. Los cinco fondos de Vex Pro tienen `enabled = false` y la empresa SÍ
//     ofrece el producto (marca «Vex Capital», Kevin 2026-09-02). Un
//     `enabled=false` NO es motivo de exclusión: es un badge.
//
//  4. La configuración de comisiones trae `updatedAt`. Comparar el documento
//     entero entre corridas dispararía una alerta cada vez que alguien abre y
//     guarda la pantalla sin tocar nada. Se compara el FINGERPRINT: sólo los
//     niveles y sus porcentajes, ordenados.
// ─────────────────────────────────────────────────────────────────────────────

import { toIso, toNum, toStr, toRaw } from '@/lib/crm-sync/normalize';
import type {
  HfCertificateRow,
  HfCommissionConfig,
  HfCommissionLevel,
  HfCommissionRow,
  HfFundRow,
  HfInvestmentRow,
  HfLedgerRow,
  HfMonthlyReturnRow,
  HfPayoutRow,
  HfWithdrawalRequestRow,
  MongoDoc,
} from './types';

export { toIso, toNum, toStr, toRaw };

/** Booleano defensivo: `null` si no es un booleano de verdad. */
export function toBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  return null;
}

/** Entero defensivo. Un `12.5` de meses de permanencia es un dato roto: null. */
export function toInt(value: unknown): number | null {
  const n = toNum(value);
  if (n === null) return null;
  return Number.isInteger(n) ? n : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// El retorno esperado: un texto escrito a mano → un rango numérico
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpectedReturnRange {
  /** % ANUAL mínimo. */
  minPct: number;
  /** % ANUAL máximo. Igual al mínimo cuando el texto trae un solo número. */
  maxPct: number;
}

/**
 * Parsea `expectedReturn` a un rango de porcentaje ANUAL.
 *
 * Formatos vistos y contemplados:
 *   '22-26%'   → 22 · 26      (el que trae AP Markets hoy)
 *   '8–12%'    → 8 · 12       (guion LARGO: el CRM lo escribe a mano y ya pasó)
 *   '8—12 %'   → 8 · 12       (raya de diálogo, mismo origen)
 *   '12'       → 12 · 12      (un solo número sigue siendo un porcentaje)
 *   '2-3'      → 2 · 3        (sin el símbolo: también son porcentajes)
 *   '22,5%'    → 22,5 · 22,5  (coma decimal — el CRM es de habla hispana)
 *
 * Devuelve `null` —y NO un 0— cuando:
 *   · no hay ningún número ('a definir', '', 'variable');
 *   · hay TRES o más números: '10-12-15' es ambiguo y adivinar sería inventar
 *     una proyección de dinero a partir de una suposición;
 *   · el mínimo es mayor que el máximo: el texto está mal escrito y ordenarlo
 *     en silencio escondería el error.
 *
 * `null` es lo correcto: la pantalla de vencimientos dibuja «—» y dice que no
 * hay proyección, en vez de proyectar cero rendimiento.
 */
export function parseExpectedReturn(raw: unknown): ExpectedReturnRange | null {
  const texto = toStr(raw);
  if (texto === null) return null;

  // Coma decimal → punto. Se hace ANTES de extraer para no partir '22,5' en dos.
  const normalizado = texto.replace(/(\d),(\d)/g, '$1.$2');
  const numeros = normalizado.match(/\d+(?:\.\d+)?/g);
  if (!numeros || numeros.length === 0 || numeros.length > 2) return null;

  const valores = numeros.map(Number);
  if (valores.some((v) => !Number.isFinite(v))) return null;

  const minPct = valores[0];
  const maxPct = valores.length === 2 ? valores[1] : valores[0];
  if (minPct > maxPct) return null;
  return { minPct, maxPct };
}

// ─────────────────────────────────────────────────────────────────────────────
// La proyección de rendimiento
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectedReturn {
  min: number;
  max: number;
}

/**
 * Rendimiento PROYECTADO de un capital al retorno esperado del fondo,
 * prorrateado por la permanencia.
 *
 *     proyección = principal × (pct / 100) × (mesesDePermanencia / 12)
 *
 * ── POR QUÉ SIMPLE Y NO COMPUESTO ──────────────────────────────────────────
 * Porque el dato de origen es un texto que dice «22-26%» sin decir si es
 * simple, compuesto, neto o bruto. Componer sobre una suposición produce un
 * número MÁS grande y no más cierto. El interés simple es la lectura más
 * conservadora del texto, y de las dos equivocadas posibles es la que no
 * promete de más.
 *
 * ── ESTO NO ES UN DATO ─────────────────────────────────────────────────────
 * Es una derivación de un texto libre. Toda pantalla que lo muestre tiene que
 * rotularlo «proyección al retorno esperado, no es dato» — y por eso la
 * función devuelve `null` en vez de ceros cuando falta cualquier insumo: un 0
 * se leería como «este fondo no rinde».
 */
export function projectReturn(
  principal: number | null | undefined,
  range: ExpectedReturnRange | null,
  holdingMonths: number | null | undefined,
): ProjectedReturn | null {
  if (range === null) return null;
  if (principal === null || principal === undefined || !Number.isFinite(principal)) return null;
  if (holdingMonths === null || holdingMonths === undefined || !Number.isFinite(holdingMonths)) {
    return null;
  }
  if (holdingMonths <= 0) return null;
  const factor = holdingMonths / 12;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    min: round2(principal * (range.minPct / 100) * factor),
    max: round2(principal * (range.maxPct / 100) * factor),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// El vigilante de la configuración de comisiones
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Un array de niveles del CRM → niveles normalizados y ORDENADOS por nivel.
 *
 * El orden es parte del fingerprint: si dependiera del orden en que Mongo
 * devuelve el array, reordenarlo sin cambiar un solo porcentaje dispararía una
 * alerta falsa. Y una alerta que grita sin motivo se deja de leer, que es como
 * se pierde la que importaba.
 *
 * Un nivel sin `level` numérico o sin `percent` numérico se DESCARTA: meterlo
 * con 0 diría «este nivel no paga», que es una afirmación que el documento no
 * hizo.
 */
export function normalizeCommissionLevels(value: unknown): HfCommissionLevel[] {
  if (!Array.isArray(value)) return [];
  const out: HfCommissionLevel[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const level = toInt(obj.level);
    const percent = toNum(obj.percent);
    if (level === null || percent === null) continue;
    out.push({ level, percent, months: toInt(obj.months) });
  }
  return out.sort((a, b) => a.level - b.level);
}

/**
 * El texto canónico que se compara entre corridas.
 *
 * Deja AFUERA `updatedAt` y `updatedBy` a propósito: guardar la pantalla sin
 * cambiar nada mueve esos dos campos y no cambia lo que se le paga a nadie.
 * Deja ADENTRO `maxLevels`, porque bajarlo de 5 a 3 apaga dos niveles enteros
 * de pago sin tocar un solo porcentaje.
 */
export function commissionConfigFingerprint(cfg: {
  directLevels: HfCommissionLevel[];
  recurringLevels: HfCommissionLevel[];
  maxLevels: number | null;
}): string {
  const nivel = (l: HfCommissionLevel) => `${l.level}:${l.percent}:${l.months ?? '-'}`;
  return [
    `max=${cfg.maxLevels ?? '-'}`,
    `direct=${cfg.directLevels.map(nivel).join(',')}`,
    `recurring=${cfg.recurringLevels.map(nivel).join(',')}`,
  ].join('|');
}

/** El documento singleton del CRM → la config normalizada con su fingerprint. */
export function toCommissionConfig(doc: MongoDoc): HfCommissionConfig {
  const directLevels = normalizeCommissionLevels(doc.directLevels);
  const recurringLevels = normalizeCommissionLevels(doc.recurringLevels);
  const maxLevels = toInt(doc.maxLevels);
  return {
    fingerprint: commissionConfigFingerprint({ directLevels, recurringLevels, maxLevels }),
    directLevels,
    recurringLevels,
    maxLevels,
    sourceUpdatedAt: toIso(doc.updatedAt),
    updatedBy: toStr(doc.updatedBy),
    raw: toRaw(doc, ['__v']),
  };
}

/**
 * ¿Cambió la configuración?
 *
 * `before === null` (nunca vimos ninguna) cuenta como CAMBIO: es el primer
 * snapshot y hay que guardarlo. Que además dispare aviso lo decide el
 * llamador — avisar del primero sería avisar de que el módulo se encendió.
 */
export function commissionConfigChanged(
  before: HfCommissionConfig | null,
  after: HfCommissionConfig,
): boolean {
  if (before === null) return true;
  return before.fingerprint !== after.fingerprint;
}

// ─────────────────────────────────────────────────────────────────────────────
// Documentos del CRM → filas del espejo (migración 125)
//
// Todas devuelven `null` cuando falta la llave natural: una fila sin llave
// rompe la PK y no se podría re-sincronizar nunca. El sync las cuenta como
// descartadas y avisa; no las traga en silencio.
// ─────────────────────────────────────────────────────────────────────────────

const DROP = ['__v'] as const;

export function toFundRow(doc: MongoDoc, companyId: string, syncedAt: string): HfFundRow | null {
  const fundKey = toStr(doc.fundKey);
  if (!fundKey) return null;
  const rango = parseExpectedReturn(doc.expectedReturn);
  return {
    company_id: companyId,
    fund_key: fundKey,
    name: toStr(doc.name),
    subtitle: toStr(doc.subtitle),
    strategy: toStr(doc.strategy),
    min_investment: toNum(doc.minInvestment),
    holding_months: toInt(doc.holdingMonths),
    expected_return_raw: toStr(doc.expectedReturn),
    expected_return_min_pct: rango?.minPct ?? null,
    expected_return_max_pct: rango?.maxPct ?? null,
    risk: toStr(doc.risk),
    currency: toStr(doc.currency),
    // `enabled` es tri-estado a propósito: false = apagado (los cinco de Vex),
    // null = el documento no lo dice. No son lo mismo.
    enabled: toBool(doc.enabled),
    status: toStr(doc.status),
    approval_mode: toStr(doc.approvalMode),
    close_date: toIso(doc.closeDate),
    slots_total: toInt(doc.slotsTotal),
    profits_locked: toBool(doc.profitsLocked),
    min_remaining_balance: toNum(doc.minRemainingBalance),
    source_created_at: toIso(doc.createdAt),
    source_updated_at: toIso(doc.updatedAt),
    raw: toRaw(doc, DROP),
    synced_at: syncedAt,
  };
}

export function toInvestmentRow(
  doc: MongoDoc,
  companyId: string,
  syncedAt: string,
): HfInvestmentRow | null {
  // `investmentId` es la llave de negocio (uuid). Respaldo en `_id` por el
  // mismo motivo que en `toWithdrawalRow`: sin llave no hay espejo posible.
  const investmentId = toStr(doc.investmentId) ?? toStr(doc._id);
  if (!investmentId) return null;
  return {
    company_id: companyId,
    investment_id: investmentId,
    ref: toStr(doc.ref),
    user_external_id: toStr(doc.userId),
    fund_key: toStr(doc.fundKey),
    program: toStr(doc.program),
    invested: toNum(doc.invested),
    principal: toNum(doc.principal),
    balance: toNum(doc.balance),
    currency: toStr(doc.currency),
    holding_months: toInt(doc.holdingMonths),
    start_date: toIso(doc.startDate),
    end_date: toIso(doc.endDate),
    status: toStr(doc.status),
    accepted_tc: toBool(doc.acceptedTC),
    approved_at: toIso(doc.approvedAt),
    approved_by: toStr(doc.approvedBy),
    rejected_at: toIso(doc.rejectedAt),
    rejected_by: toStr(doc.rejectedBy),
    rejected_reason: toStr(doc.rejectedReason),
    closed_at: toIso(doc.closedAt),
    closed_reason: toStr(doc.closedReason),
    source_created_at: toIso(doc.createdAt),
    source_updated_at: toIso(doc.updatedAt),
    raw: toRaw(doc, DROP),
    synced_at: syncedAt,
  };
}

export function toLedgerRow(doc: MongoDoc, companyId: string, syncedAt: string): HfLedgerRow | null {
  const entryId = toStr(doc.entryId) ?? toStr(doc._id);
  if (!entryId) return null;
  return {
    company_id: companyId,
    entry_id: entryId,
    investment_id: toStr(doc.investmentId),
    user_external_id: toStr(doc.userId),
    fund_key: toStr(doc.fundKey),
    type: toStr(doc.type),
    // Con SIGNO. Nunca `Math.abs`: una terminación resta y tiene que restar.
    amount: toNum(doc.amount),
    balance_before: toNum(doc.balanceBefore),
    balance_after: toNum(doc.balanceAfter),
    currency: toStr(doc.currency),
    payout_id: toStr(doc.payoutId),
    description: toStr(doc.description),
    source_created_at: toIso(doc.createdAt),
    raw: toRaw(doc, DROP),
    synced_at: syncedAt,
  };
}

export function toPayoutRow(doc: MongoDoc, companyId: string, syncedAt: string): HfPayoutRow | null {
  const payoutId = toStr(doc.payoutId) ?? toStr(doc._id);
  if (!payoutId) return null;
  return {
    company_id: companyId,
    payout_id: payoutId,
    fund_key: toStr(doc.fundKey),
    program: toStr(doc.program),
    percent: toNum(doc.percent),
    status: toStr(doc.status),
    accounts_affected: toInt(doc.accountsAffected),
    total_credited: toNum(doc.totalCredited),
    currency: toStr(doc.currency),
    executed_by: toStr(doc.executedBy),
    started_at: toIso(doc.startedAt),
    finished_at: toIso(doc.finishedAt),
    source_created_at: toIso(doc.createdAt),
    raw: toRaw(doc, DROP),
    synced_at: syncedAt,
  };
}

export function toCommissionRow(
  doc: MongoDoc,
  companyId: string,
  syncedAt: string,
): HfCommissionRow | null {
  const commissionId = toStr(doc.commissionId) ?? toStr(doc._id);
  if (!commissionId) return null;
  return {
    company_id: companyId,
    commission_id: commissionId,
    type: toStr(doc.type),
    beneficiary_user_external_id: toStr(doc.beneficiaryUserId),
    beneficiary_username: toStr(doc.beneficiaryUsername),
    source_user_external_id: toStr(doc.sourceUserId),
    source_username: toStr(doc.sourceUsername),
    investment_id: toStr(doc.investmentId),
    fund_key: toStr(doc.fundKey),
    level: toInt(doc.level),
    percent: toNum(doc.percent),
    base_amount: toNum(doc.baseAmount),
    // Con signo: los reversos son negativos y el neto los necesita.
    amount: toNum(doc.amount),
    currency: toStr(doc.currency),
    ym: toStr(doc.ym),
    status: toStr(doc.status),
    paid_at: toIso(doc.paidAt),
    source_created_at: toIso(doc.createdAt),
    raw: toRaw(doc, DROP),
    synced_at: syncedAt,
  };
}

/**
 * Solicitudes de retiro. La colección está VACÍA en las dos empresas al
 * 2026-09-02, así que las columnas salen de los ÍNDICES del CRM (requestId,
 * investmentId, userId, status, type) y todo lo demás vive en `raw`. Cuando
 * llegue la primera solicitud real, esto se cotejará contra un documento de
 * verdad — hasta entonces, lo que no tenga columna NO se pierde.
 */
export function toWithdrawalRequestRow(
  doc: MongoDoc,
  companyId: string,
  syncedAt: string,
): HfWithdrawalRequestRow | null {
  const requestId = toStr(doc.requestId) ?? toStr(doc._id);
  if (!requestId) return null;
  return {
    company_id: companyId,
    request_id: requestId,
    investment_id: toStr(doc.investmentId),
    user_external_id: toStr(doc.userId),
    fund_key: toStr(doc.fundKey),
    status: toStr(doc.status),
    type: toStr(doc.type),
    amount: toNum(doc.amount),
    currency: toStr(doc.currency),
    requested_at: toIso(doc.requestedAt) ?? toIso(doc.requestedDate),
    processed_at: toIso(doc.processedAt) ?? toIso(doc.processedDate),
    source_created_at: toIso(doc.createdAt),
    source_updated_at: toIso(doc.updatedAt),
    raw: toRaw(doc, DROP),
    synced_at: syncedAt,
  };
}

/**
 * Rendimientos mensuales por fondo. También vacía hoy; el único índice del CRM
 * es (fundKey, ym) y ésa es la llave. `percent` y `amount` quedan en `null`
 * cuando el documento no los trae: la pantalla dibuja «sin datos», no 0%.
 */
export function toMonthlyReturnRow(
  doc: MongoDoc,
  companyId: string,
  syncedAt: string,
): HfMonthlyReturnRow | null {
  const fundKey = toStr(doc.fundKey);
  const ym = toStr(doc.ym);
  if (!fundKey || !ym) return null;
  return {
    company_id: companyId,
    fund_key: fundKey,
    ym,
    percent: toNum(doc.percent),
    amount: toNum(doc.amount),
    raw: toRaw(doc, DROP),
    synced_at: syncedAt,
  };
}

export function toCertificateRow(
  doc: MongoDoc,
  companyId: string,
  syncedAt: string,
): HfCertificateRow | null {
  const certificateId = toStr(doc.certificateId) ?? toStr(doc._id);
  if (!certificateId) return null;
  return {
    company_id: companyId,
    certificate_id: certificateId,
    number: toStr(doc.number),
    investment_id: toStr(doc.investmentId),
    user_external_id: toStr(doc.userId),
    investor_name: toStr(doc.investorName),
    investment_date: toIso(doc.investmentDate),
    amount: toNum(doc.amount),
    currency: toStr(doc.currency),
    fund_key: toStr(doc.fundKey),
    program: toStr(doc.program),
    sent_at: toIso(doc.sentAt),
    source_created_at: toIso(doc.createdAt),
    raw: toRaw(doc, DROP),
    synced_at: syncedAt,
  };
}
