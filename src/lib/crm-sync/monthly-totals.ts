// ─────────────────────────────────────────────────────────────────────────────
// El sync de los totales mensuales del CRM.
//
// El PORQUÉ de cada número —qué lado del P2P, qué campo de las ventas, por qué
// los retiros no salen del espejo— está en `src/lib/crm-monthly.ts`, junto a
// las funciones puras que lo calculan. Acá sólo está lo que toca Mongo y
// Supabase, que es lo que no se puede testear sin ellos.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { withOrionMongo } from '@/lib/api-integrations/orion-mongo/client';
import { CONCEPT_GROUPS } from './wallet-sources';
import {
  CRM_MONTHLY_METRIC_KEYS,
  ORION_P2P_LEG_FIELDS,
  ORION_PROPFIRM_WITHDRAWAL_FIELDS,
  ORION_TRANSFER_P2P_FIELDS,
  ORION_USER_PROPFIRM_FIELDS,
  PROPFIRM_PURCHASE_CONCEPT,
  aggregateP2pByMonth,
  aggregatePropfirmSalesByMonth,
  aggregatePropfirmWithdrawalsByMonth,
  aggregateWalletPropfirmByMonth,
  splitMonthKey,
  type MonthlyBucket,
  type P2pLeg,
  type PropfirmPurchase,
  type PropfirmWithdrawalDoc,
} from '@/lib/crm-monthly';

/**
 * Los conceptos de `wallettransfers` que son P2P, derivados del registro único
 * de conceptos (`CONCEPT_GROUPS`). Escribir el literal 'TRANSFER_P2P' acá
 * sería la segunda lista, que es el modo de falla número uno de este repo.
 */
export const P2P_CONCEPTS: string[] = Object.entries(CONCEPT_GROUPS)
  .filter(([, group]) => group === 'p2p')
  .map(([concept]) => concept);

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface CrmMonthlyTotalsResult {
  /** Filas escritas, por métrica. Una métrica sin datos NO escribe filas
   *  (AP Markets no tiene prop firm: "no aplica" ≠ "cero"). */
  rows: Record<string, number>;
  months: number;
  elapsedMs: number;
  warnings: string[];
}

interface Row {
  company_id: string;
  year: number;
  month: number;
  metric: string;
  amount: number;
  currency: string;
  tx_count: number;
  excluded_count: number;
  excluded_amount: number;
  detail: Record<string, unknown>;
  source: 'api';
  computed_at: string;
}

function toRows(
  companyId: string,
  metric: string,
  buckets: Map<string, MonthlyBucket>,
  now: string,
  extra?: (monthKey: string) => Record<string, unknown>,
): Row[] {
  const rows: Row[] = [];
  for (const [key, b] of buckets) {
    const ym = splitMonthKey(key);
    if (!ym) continue;
    rows.push({
      company_id: companyId,
      year: ym.year,
      month: ym.month,
      metric,
      amount: b.amount,
      currency: 'USD',
      tx_count: b.count,
      excluded_count: b.excludedCount,
      excluded_amount: b.excludedAmount,
      detail: { ...b.cross, ...(extra?.(key) ?? {}) },
      source: 'api',
      computed_at: now,
    });
  }
  return rows;
}

/**
 * Recalcula la serie mensual COMPLETA de las tres métricas y la deja en
 * `crm_monthly_totals`.
 *
 * Completa y no incremental a propósito: son 2.892 patas P2P, 1.599
 * transferencias, 1.559 compras y 250 retiros en la empresa más grande —
 * cuatro consultas de menos de un segundo. Un cursor acá sólo agregaría la
 * clase de bug que introduce (una transferencia que cambia de estado después
 * del corte quedaría contada para siempre como completada).
 */
export async function syncCrmMonthlyTotals(
  admin: SupabaseClient,
  companyId: string,
): Promise<CrmMonthlyTotalsResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const now = new Date().toISOString();
  const proj = (fields: readonly string[]) =>
    Object.fromEntries(fields.map((f) => [f, 1])) as Record<string, 1>;

  const datos = await withOrionMongo(companyId, async ({ db }) => {
    const [p2pLegs, transfers, compras, comprasWallet, retiros] = await Promise.all([
      db.collection('wallettransfers')
        .find({ concept: { $in: P2P_CONCEPTS } }, { projection: proj(ORION_P2P_LEG_FIELDS) })
        .toArray(),
      db.collection('transferp2ps')
        .find({}, { projection: proj(ORION_TRANSFER_P2P_FIELDS) })
        .toArray(),
      db.collection('userpropfirms')
        .find({}, { projection: proj(ORION_USER_PROPFIRM_FIELDS) })
        .toArray(),
      db.collection('wallettransfers')
        .find({ concept: PROPFIRM_PURCHASE_CONCEPT }, { projection: proj(ORION_P2P_LEG_FIELDS) })
        .toArray(),
      db.collection('withdrawalpropfirms')
        .find({}, { projection: proj(ORION_PROPFIRM_WITHDRAWAL_FIELDS) })
        .toArray(),
    ]);
    return { p2pLegs, transfers, compras, comprasWallet, retiros };
  });

  const estados = new Map<string, string>(
    datos.transfers.map((t: Record<string, unknown>) => [String(t.transferId ?? ''), String(t.transferStatus ?? '')]),
  );

  const p2p = aggregateP2pByMonth(datos.p2pLegs as P2pLeg[], estados);
  const ventas = aggregatePropfirmSalesByMonth(datos.compras as PropfirmPurchase[]);
  const billetera = aggregateWalletPropfirmByMonth(datos.comprasWallet as P2pLeg[]);
  const retiros = aggregatePropfirmWithdrawalsByMonth(datos.retiros as PropfirmWithdrawalDoc[]);

  const filas: Row[] = [
    ...toRows(companyId, 'p2p_transfers', p2p, now),
    ...toRows(companyId, 'propfirm_sales', ventas, now, (k) => ({ wallet: billetera.get(k) ?? 0 })),
    ...toRows(companyId, 'propfirm_withdrawals', retiros, now),
  ];

  // Avisos: lo que hay que mirar sin tener que abrir la tabla.
  for (const [k, b] of p2p) {
    if (b.count > 0 && Math.abs(b.amount - Number(b.cross.inSide)) > 0.01) {
      warnings.push(
        `P2P ${k}: el lado OUT (${b.amount}) y el IN (${b.cross.inSide}) no coinciden — hay patas huérfanas.`,
      );
    }
  }
  const excluidasP2p = [...p2p.values()].reduce((s, b) => s + b.excludedCount, 0);
  if (excluidasP2p > 0) {
    const monto = round2([...p2p.values()].reduce((s, b) => s + b.excludedAmount, 0));
    warnings.push(`P2P: ${excluidasP2p} pata(s) OUT excluidas por $${monto} (transferencias no completadas o sin estado).`);
  }
  for (const [k, b] of ventas) {
    const w = billetera.get(k);
    if (w !== undefined && Math.abs(b.amount - w) > 0.01) {
      warnings.push(`Ventas prop firm ${k}: cobrado ${b.amount} vs billetera ${w}.`);
    }
  }

  const rows: Record<string, number> = {};
  for (const metric of CRM_MONTHLY_METRIC_KEYS) rows[metric] = 0;

  for (let i = 0; i < filas.length; i += 500) {
    const part = filas.slice(i, i + 500);
    const { error } = await admin
      .from('crm_monthly_totals')
      .upsert(part, { onConflict: 'company_id,year,month,metric' });
    if (error) throw new Error(`crm_monthly_totals: ${error.message}`);
    for (const r of part) rows[r.metric] = (rows[r.metric] ?? 0) + 1;
  }

  return {
    rows,
    months: new Set(filas.map((f) => `${f.year}-${f.month}`)).size,
    elapsedMs: Date.now() - started,
    warnings,
  };
}
