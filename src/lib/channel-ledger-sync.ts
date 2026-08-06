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
import { AUTO_CATEGORIES, previousDay } from '@/lib/channel-ledger';

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

  const lines: LedgerLine[] = [];
  if (day.deposits > CENT) {
    lines.push({ entry_date: entryDate, kind: 'in', concept: 'Depósitos del día', category: AUTO_CATEGORIES.deposits, amount: day.deposits });
  }
  if (day.withdrawals > CENT) {
    lines.push({ entry_date: entryDate, kind: 'out', concept: 'Retiros del día', category: AUTO_CATEGORIES.withdrawals, amount: day.withdrawals });
  }
  if (day.internal > CENT) {
    lines.push({
      entry_date: entryDate, kind: 'out', concept: 'Transferencias internas',
      category: AUTO_CATEGORIES.internal, amount: day.internal,
      notes: 'Movimiento entre wallets propias: mueve el saldo del canal pero queda fuera de Retiros Totales.',
    });
  }

  // ── Ajuste que cierra contra el saldo real ─────────────────────────────
  const computed = priorBalance + day.deposits - day.withdrawals - day.internal;
  const adjustment = actualClose - computed;
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

  if (lines.length > 0) {
    const { error } = await admin.from('channel_ledger_entries').upsert(
      lines.map((l) => ({
        company_id: companyId,
        channel_key: channelKey,
        source: 'api' as const,
        ...l,
        notes: l.notes ?? null,
      })),
      { onConflict: 'company_id,channel_key,entry_date,category' },
    );
    if (error) {
      return { channel_key: channelKey, entry_date: entryDate, closing: actualClose, error: error.message };
    }
  }

  return { channel_key: channelKey, entry_date: entryDate, closing: actualClose, adjustment };
}
