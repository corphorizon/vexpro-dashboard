// ─────────────────────────────────────────────────────────────────────────────
// Asiento diario automático del libro por canal (server-only).
//
// Lo llama el cron de las 00:00 UTC, justo después de guardar el snapshot del
// día. En ese momento tenemos las dos puntas necesarias:
//   · el saldo REAL que reportó la API al cierre de ayer (el snapshot), y
//   · las transacciones de ayer ya sincronizadas en api_transactions.
//
// Con eso se asientan hasta 4 líneas por canal y por día:
//   · Depósitos del día        (ingreso)
//   · Retiros del día          (egreso)  — sin transferencias internas
//   · Transferencias internas  (egreso)  — mueven saldo, no son retiro del negocio
//   · Ajuste de conciliación   (el resto) — fuerza el cierre contra el saldo real
//
// La última línea es la que hace que el libro NUNCA discrepe de la wallet.
// En Coinsbuy absorbe las comisiones de red (~$1-4/día); en UniPayment, las
// liquidaciones de salida que su API no expone. Verificado contra 6 días de
// producción: con estas 4 líneas el cierre da exacto al centavo.
// ─────────────────────────────────────────────────────────────────────────────

import type { createAdminClient } from '@/lib/supabase/admin';
import { AUTO_CATEGORIES, previousDay, resolveInternalTransfers } from '@/lib/channel-ledger';

type Admin = ReturnType<typeof createAdminClient>;

interface DayMovements {
  deposits: number;
  withdrawals: number;
  internal: number;
}

interface LedgerLine {
  entry_date: string;
  kind: 'in' | 'out';
  concept: string;
  category: string;
  amount: number;
  notes?: string;
}

/** Diferencias por debajo de un centavo son ruido de coma flotante, no un ajuste. */
const CENT = 0.01;

/**
 * Ajuste máximo tolerado por canal antes de ABORTAR el asiento del día.
 * Coinsbuy: comisiones de red, $1-4/día — 500 da margen de sobra.
 * UniPayment: absorbe las liquidaciones de salida que su API no expone
 * ($2K-8K/día observados) — 25.000 cubre picos sin tragarse un desastre.
 * Un ajuste fuera de rango casi siempre es una wallet que faltó en la
 * respuesta de la API o un snapshot pisado: mejor no escribir nada, avisar,
 * y reprocesar el día cuando se entienda la causa.
 */
export const MAX_ADJUSTMENT: Record<string, number> = {
  coinsbuy: 500,
  unipayment: 25_000,
};

export interface LedgerSyncResult {
  channel_key: string;
  entry_date: string;
  /** Saldo real de la API al cierre del día — el libro cierra acá. */
  closing: number;
  bootstrapped?: boolean;
  adjustment?: number;
  error?: string;
}

/**
 * Asienta el día `entryDate` del canal `channelKey` y deja el libro cerrando
 * exactamente en `actualClose` (el saldo que reportó la API).
 *
 * Idempotente: el índice único parcial (company, canal, fecha, categoría)
 * sobre source='api' hace que un segundo pase del cron sobreescriba las
 * líneas en vez de duplicarlas.
 */
export async function syncChannelLedgerDay(
  admin: Admin,
  companyId: string,
  channelKey: string,
  entryDate: string,
  actualClose: number,
): Promise<LedgerSyncResult> {
  // ── Saldo con el que veníamos ──────────────────────────────────────────
  const { data: priorRows, error: priorError } = await admin.rpc('get_channel_ledger_balances', {
    p_company_id: companyId,
    p_asof: previousDay(entryDate),
  });
  if (priorError) {
    return { channel_key: channelKey, entry_date: entryDate, closing: actualClose, error: priorError.message };
  }

  const prior = (priorRows ?? []) as Array<{ channel_key: string; balance: number | string }>;
  const priorRow = prior.find((r) => r.channel_key === channelKey);

  // ── Arranque en frío ───────────────────────────────────────────────────
  // Sin saldo previo no hay contra qué conciliar: inventar movimientos sería
  // fabricar historia. Se abre el libro con el saldo real de hoy y a partir
  // de mañana el asiento diario ya es normal.
  if (!priorRow) {
    const { error } = await admin.from('channel_ledger_entries').insert({
      company_id: companyId,
      channel_key: channelKey,
      entry_date: entryDate,
      kind: 'opening',
      source: 'api',
      concept: 'Saldo inicial',
      category: AUTO_CATEGORIES.opening,
      amount: actualClose,
      notes: 'Apertura automática del libro con el saldo reportado por la API.',
    });
    // 23505 = otro pase del cron lo abrió primero. No es un error.
    if (error && error.code !== '23505') {
      return { channel_key: channelKey, entry_date: entryDate, closing: actualClose, error: error.message };
    }
    return { channel_key: channelKey, entry_date: entryDate, closing: actualClose, bootstrapped: true };
  }

  const priorBalance = Number(priorRow.balance) || 0;

  // ── Movimientos del día ────────────────────────────────────────────────
  const { data: movRows, error: movError } = await admin.rpc('get_channel_day_movements', {
    p_company_id: companyId,
    p_day: entryDate,
  });
  if (movError) {
    return { channel_key: channelKey, entry_date: entryDate, closing: actualClose, error: movError.message };
  }

  const mov = ((movRows ?? []) as Array<{ channel_key: string } & Record<string, number | string>>)
    .find((r) => r.channel_key === channelKey);

  const day: DayMovements = {
    deposits: Number(mov?.deposits) || 0,
    withdrawals: Number(mov?.withdrawals) || 0,
    internal: Number(mov?.internal) || 0,
  };

  // Líneas MANUALES del mismo día: entran al saldo (balanceAsOf las incluye)
  // pero no vienen de api_transactions, así que si no se suman acá el ajuste
  // las "des-explicaría". Caso concreto: el alta de la wallet 1705 se asentó
  // como línea manual de +38.397,58 el 2026-08-06 — sin este término, el
  // cierre de esa noche calcularía un ajuste de ~+38K y abortaría por umbral.
  const { data: manualRows, error: manualErr } = await admin
    .from('channel_ledger_entries')
    .select('kind, amount')
    .eq('company_id', companyId)
    .eq('channel_key', channelKey)
    .eq('entry_date', entryDate)
    .eq('source', 'manual');
  if (manualErr) {
    return { channel_key: channelKey, entry_date: entryDate, closing: actualClose, error: manualErr.message };
  }
  const manualDelta = ((manualRows ?? []) as Array<{ kind: string; amount: number }>)
    .reduce((sum, r) => sum + (r.kind === 'out' ? -Number(r.amount) : Number(r.amount)), 0);

  const lines: LedgerLine[] = [];
  if (day.deposits > CENT) {
    lines.push({ entry_date: entryDate, kind: 'in', concept: 'Depósitos del día', category: AUTO_CATEGORIES.deposits, amount: day.deposits });
  }
  if (day.withdrawals > CENT) {
    lines.push({ entry_date: entryDate, kind: 'out', concept: 'Retiros del día', category: AUTO_CATEGORIES.withdrawals, amount: day.withdrawals });
  }

  // ── Internas + ajuste: decide el saldo real del custodio ───────────────
  // Una interna entre dos wallets FIJADAS no mueve el agregado: asentarla
  // como salida y revertirla con un ajuste gigante era ficción contable (el
  // 06/08 el guard abortó el día entero por $35.000 que fueron 1079→1705).
  // resolveInternalTransfers contrasta los dos candidatos contra actualClose.
  const baseWithoutInternal = priorBalance + manualDelta + day.deposits - day.withdrawals;
  const { internalLeftAggregate, adjustment } = resolveInternalTransfers({
    baseWithoutInternal,
    internal: day.internal,
    actualClose,
  });

  if (day.internal > CENT && internalLeftAggregate) {
    lines.push({
      entry_date: entryDate, kind: 'out', concept: 'Transferencias internas',
      category: AUTO_CATEGORIES.internal, amount: day.internal,
      notes: 'Movimiento hacia una wallet propia fuera del agregado: mueve el saldo del canal pero queda fuera de Retiros Totales.',
    });
  }
  if (Math.abs(adjustment) > CENT) {
    lines.push({
      entry_date: entryDate,
      kind: adjustment >= 0 ? 'in' : 'out',
      concept: 'Ajuste de conciliación',
      category: AUTO_CATEGORIES.adjustment,
      amount: Math.abs(adjustment),
      notes: 'Diferencia contra el saldo real de la API (comisiones de red y movimientos no detallados por el proveedor).',
    });
  }

  // Cota de sanidad ANTES de escribir: un ajuste enorme no es una comisión de
  // red, es un dato de entrada roto (wallet ausente en la respuesta, snapshot
  // pisado, wallet recién fijada). Escribirlo contaminaría el libro con un
  // movimiento que no existió; mejor fallar ruidoso y reprocesar el día.
  const maxAdj = MAX_ADJUSTMENT[channelKey] ?? 1_000;
  if (Math.abs(adjustment) > maxAdj) {
    return {
      channel_key: channelKey,
      entry_date: entryDate,
      closing: actualClose,
      error: `Ajuste fuera de rango (${adjustment.toFixed(2)} > ±${maxAdj}): no se asentó el día. Revisar snapshot y wallets antes de reprocesar.`,
    };
  }

  // RPC en vez de upsert: el ON CONFLICT de PostgREST no puede apoyarse en el
  // índice único PARCIAL (where source='api') — Postgres lo rechaza con 42P10
  // y por eso el cron nunca escribió (auditoría 2026-08-06). La RPC además
  // REEMPLAZA el día completo (delete+insert de las líneas 'api'), así que una
  // re-corrida que produce menos líneas no deja huérfanas.
  const { error } = await admin.rpc('replace_channel_ledger_day', {
    p_company_id: companyId,
    p_channel_key: channelKey,
    p_entry_date: entryDate,
    p_lines: lines.map((l) => ({ ...l, notes: l.notes ?? null })),
  });
  if (error) {
    return { channel_key: channelKey, entry_date: entryDate, closing: actualClose, error: error.message };
  }

  return { channel_key: channelKey, entry_date: entryDate, closing: actualClose, adjustment };
}
