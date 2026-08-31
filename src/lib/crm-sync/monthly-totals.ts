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
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows';
import { CONCEPT_GROUPS } from './wallet-sources';
import { isUnknownConcept } from '@/lib/crm-wallet-concepts';
import {
  CRM_DEPOSIT_COMPLETED,
  FAIRPAY_COMPLETED,
  FAIRPAY_PROVIDER,
  aggregateFairpayAdjustmentByMonth,
  type FairpayPayment,
  CRM_MONTHLY_METRIC_KEYS,
  WALLET_METRIC_CONCEPTS,
  WALLET_METRIC_SPECS,
  aggregateWalletMetricByMonth,
  type WalletConceptMonthRow,
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
 * Escribe filas en `crm_monthly_totals` de a 500 y devuelve cuántas por
 * métrica. Una sola copia: el upsert vive acá y no repetido en cada paso.
 */
async function upsertRows(
  admin: SupabaseClient,
  filas: Row[],
  rows: Record<string, number>,
): Promise<void> {
  for (let i = 0; i < filas.length; i += 500) {
    const part = filas.slice(i, i + 500);
    const { error } = await admin
      .from('crm_monthly_totals')
      .upsert(part, { onConflict: 'company_id,year,month,metric' });
    if (error) throw new Error(`crm_monthly_totals: ${error.message}`);
    for (const r of part) rows[r.metric] = (rows[r.metric] ?? 0) + 1;
  }
}

/** Cuántos ids se piden por vuelta al cruzar contra `crm_deposits`. 200 deja
 *  la URL de PostgREST cómodamente por debajo de cualquier límite y la
 *  respuesta muy por debajo de las 1.000 filas que corta el servidor. */
const LOTE_CRUCE = 200;

/**
 * La serie mensual del AJUSTE FAIRPAY, en `crm_monthly_totals`.
 *
 * ── POR QUÉ ESTÁ SEPARADA DE `syncCrmMonthlyTotals` ────────────────────────
 * Las otras cinco métricas salen de Orion (Mongo). Ésta NO toca Mongo: los dos
 * lados del cruce —`api_transactions` y `crm_deposits`— viven en el mismo
 * Postgres. Si fuera un paso más adentro de la función grande, un Orion caído
 * se llevaría puesta una métrica que no depende de Orion, y el mes quedaría
 * "sin dato" por una razón que no tiene nada que ver. Es la regla §5.1 del
 * repo: cada tarea en su propio `try/catch`.
 *
 * El PORQUÉ del cruce (qué llave, qué entra, qué se excluye y la conciliación
 * mes a mes contra los $2.994,83 ya cargados) está en `crm-monthly.ts`, junto
 * a la función pura que lo calcula.
 *
 * Recalcula la serie ENTERA, igual que el resto: son 426 filas Completed en la
 * empresa más grande (medido el 2026-08-31) y un estado puede cambiar después
 * del corte.
 */
export async function syncFairpayAdjustment(
  admin: SupabaseClient,
  companyId: string,
): Promise<{ rows: number; monthKeys: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const now = new Date().toISOString();

  // `.order('id')` por columna única: sin él las páginas no son consistentes
  // entre sí y una fila puede salir dos veces o ninguna (ver fetch-all-rows).
  const pagos = await fetchAllRows<{ id: string; external_id: string; amount: number | string; transaction_date: string }>(
    (from, to) =>
      admin
        .from('api_transactions')
        .select('id, external_id, amount, transaction_date')
        .eq('company_id', companyId)
        .eq('provider', FAIRPAY_PROVIDER)
        .eq('status', FAIRPAY_COMPLETED)
        .order('id')
        .range(from, to),
  );

  // Una empresa sin FairPay NO escribe filas: "no aplica" no es "cero".
  if (pagos.length === 0) return { rows: 0, monthKeys: [], warnings };

  // El cruce, de a lotes. `external_id` (no el jsonb) para entrar por el
  // índice único, que además garantiza que el cruce sea 1 a 1.
  const acreditado = new Map<string, { paid: number | null; completed: boolean }>();
  const ids = [...new Set(pagos.map((p) => p.external_id).filter(Boolean))];
  for (let i = 0; i < ids.length; i += LOTE_CRUCE) {
    const lote = ids.slice(i, i + LOTE_CRUCE);
    const { data, error } = await admin
      .from('crm_deposits')
      .select('external_id, amount_paid, status_norm')
      .eq('company_id', companyId)
      .in('external_id', lote);
    if (error) throw new Error(`crm_deposits (cruce FairPay): ${error.message}`);
    for (const d of (data ?? []) as Array<{ external_id: string; amount_paid: number | string | null; status_norm: string }>) {
      acreditado.set(d.external_id, {
        // `null` = el CRM no dice cuánto acreditó. NO es 0 (§1.3): el pago se
        // excluye del ajuste en vez de contarse entero como recargo.
        paid: d.amount_paid === null || d.amount_paid === undefined ? null : Number(d.amount_paid),
        completed: d.status_norm === CRM_DEPOSIT_COMPLETED,
      });
    }
  }

  const entrada: FairpayPayment[] = pagos.map((p) => {
    const cruce = acreditado.get(p.external_id);
    return {
      paidAt: p.transaction_date,
      gross: p.amount,
      crossed: cruce !== undefined,
      credited: cruce?.paid ?? null,
      creditedInCrm: cruce?.completed ?? false,
    };
  });

  const { buckets, noMonth } = aggregateFairpayAdjustmentByMonth(entrada);

  const sinCruce = [...buckets.values()].reduce((s, b) => s + b.excludedCount, 0);
  if (sinCruce > 0) {
    const monto = round2([...buckets.values()].reduce((s, b) => s + b.excludedAmount, 0));
    warnings.push(
      `Ajuste FairPay: ${sinCruce} pago(s) Completed por $${monto} SIN contraparte en el CRM — fuera del ajuste (no se sabe cuánto se acreditó).`,
    );
  }
  if (noMonth.count > 0) {
    warnings.push(
      `Ajuste FairPay: ${noMonth.count} pago(s) por $${noMonth.amount} sin fecha utilizable — fuera de la serie.`,
    );
  }
  for (const [k, b] of buckets) {
    if (b.amount < 0) {
      warnings.push(
        `Ajuste FairPay ${k}: el ajuste da NEGATIVO ($${b.amount}) — el CRM acreditó más de lo que FairPay cobró. Mirar antes de cargar el egreso.`,
      );
    }
  }

  const filas = toRows(companyId, 'fairpay_adjustment', buckets, now);
  const contador: Record<string, number> = {};
  await upsertRows(admin, filas, contador);
  return { rows: contador.fairpay_adjustment ?? 0, monthKeys: [...buckets.keys()], warnings };
}

/**
 * Recalcula la serie mensual COMPLETA de todas las métricas del registro
 * (`CRM_MONTHLY_METRIC_KEYS`) y la deja en `crm_monthly_totals`.
 *
 * Tres se comparan contra lo cargado a mano (P2P, ventas y retiros de prop
 * firm) y el resto son INFORMATIVAS y no cuentan en el resultado (comisiones
 * IB, social trading fees, fee debt recovery, hedge fund y ajuste FairPay —
 * ver el bloque de métricas informativas en `crm-monthly.ts`). La cuenta no se
 * escribe acá a propósito: el registro es el único lugar donde vive la lista.
 *
 * Completa y no incremental a propósito: son 2.892 patas P2P, 1.599
 * transferencias, 1.559 compras y 250 retiros en la empresa más grande —
 * cuatro consultas de menos de un segundo. Un cursor acá sólo agregaría la
 * clase de bug que introduce (una transferencia que cambia de estado después
 * del corte quedaría contada para siempre como completada).
 *
 * Las dos consultas de billetera que agregan las series informativas NO
 * traen documentos: agrupan en Mongo y devuelven decenas de filas, aunque
 * detrás haya 225.569 patas de comisiones IB. Medido contra producción el
 * 2026-08-28 (Vex Pro, dos corridas): la serie 1.200 y 1.165 ms para 56
 * filas, y el censo de conceptos 458 y 484 ms para 25 conceptos.
 */
export async function syncCrmMonthlyTotals(
  admin: SupabaseClient,
  companyId: string,
): Promise<CrmMonthlyTotalsResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const now = new Date().toISOString();

  const rows: Record<string, number> = {};
  for (const metric of CRM_MONTHLY_METRIC_KEYS) rows[metric] = 0;

  // ── El ajuste FairPay va PRIMERO y aparte ──────────────────────────────
  // No toca Mongo (los dos lados están en Postgres) y ya deja sus filas
  // escritas antes de que se abra la conexión a Orion: un Orion caído no
  // puede llevarse puesta una métrica que no depende de Orion. Su `catch`
  // es propio por la misma razón (§5.1).
  const mesesFairpay: string[] = [];
  try {
    const fp = await syncFairpayAdjustment(admin, companyId);
    rows.fairpay_adjustment = fp.rows;
    mesesFairpay.push(...fp.monthKeys);
    warnings.push(...fp.warnings);
  } catch (err) {
    warnings.push(
      `Ajuste FairPay: NO se pudo calcular (${err instanceof Error ? err.message : 'error desconocido'}). La serie del mes queda SIN DATO, no en cero.`,
    );
  }

  const proj = (fields: readonly string[]) =>
    Object.fromEntries(fields.map((f) => [f, 1])) as Record<string, 1>;

  const datos = await withOrionMongo(companyId, async ({ db }) => {
    // ── Las tres series informativas ─────────────────────────────────────
    // Se agrupan EN MONGO por (concepto, dirección, mes) porque las patas de
    // comisiones IB de Vex Pro son 225.569 documentos: traerlos enteros para
    // sumarlos en JS sería mover megabytes por un puñado de números. El
    // resultado son ~60 filas.
    //
    // El mes sale de `$dateToString` con `timezone: 'UTC'` explícito. Y no
    // por prolijidad: `walletTransferDate` es un BSON **date**, no un string
    // (verificado el 2026-08-28 con `$type`), así que compararlo o cortarlo
    // como texto devuelve CERO FILAS SIN ERROR — el fallo silencioso de
    // siempre. `$convert ... onError/onNull: null` deja pasar el documento
    // con fecha rota como mes nulo, que se cuenta y se avisa en vez de
    // caerse o de inventarle un mes.
    const walletPipeline = [
      { $match: { concept: { $in: WALLET_METRIC_CONCEPTS } } },
      {
        $group: {
          _id: {
            c: '$concept',
            t: '$walletTransferType',
            m: {
              $convert: {
                input: {
                  $dateToString: { format: '%Y-%m', date: '$walletTransferDate', timezone: 'UTC' },
                },
                to: 'string',
                onError: null,
                onNull: null,
              },
            },
          },
          n: { $sum: 1 },
          net: { $sum: '$netAmount' },
          gross: { $sum: '$grossAmount' },
        },
      },
    ];

    // Y el censo de conceptos: para poder avisar si el broker inventa uno
    // que el registro no conoce. Es un $group sobre la colección entera, el
    // mismo costo que ya paga `wallet-sources`.
    const censoPipeline = [
      { $group: { _id: '$concept', n: { $sum: 1 }, net: { $sum: '$netAmount' } } },
    ];

    const [p2pLegs, transfers, compras, comprasWallet, retiros, walletGrouped, censo] = await Promise.all([
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
      db.collection('wallettransfers')
        .aggregate(walletPipeline, { allowDiskUse: false, maxTimeMS: 180_000 })
        .toArray(),
      db.collection('wallettransfers')
        .aggregate(censoPipeline, { allowDiskUse: false, maxTimeMS: 180_000 })
        .toArray(),
    ]);
    return { p2pLegs, transfers, compras, comprasWallet, retiros, walletGrouped, censo };
  });

  const estados = new Map<string, string>(
    datos.transfers.map((t: Record<string, unknown>) => [String(t.transferId ?? ''), String(t.transferStatus ?? '')]),
  );

  const p2p = aggregateP2pByMonth(datos.p2pLegs as P2pLeg[], estados);
  const ventas = aggregatePropfirmSalesByMonth(datos.compras as PropfirmPurchase[]);
  const billetera = aggregateWalletPropfirmByMonth(datos.comprasWallet as P2pLeg[]);
  const retiros = aggregatePropfirmWithdrawalsByMonth(datos.retiros as PropfirmWithdrawalDoc[]);

  // ── Las tres series INFORMATIVAS ────────────────────────────────────────
  // No cuentan en el resultado (base caja: mueven la billetera, no la caja —
  // el porqué está en la cabecera del bloque de métricas informativas de
  // `crm-monthly.ts`). Se calculan igual porque el dato sirve.
  const walletRows: WalletConceptMonthRow[] = (datos.walletGrouped as Array<Record<string, unknown>>)
    .map((g) => {
      const id = g._id as { c?: unknown; t?: unknown; m?: unknown };
      return {
        concept: String(id.c ?? ''),
        direction: String(id.t ?? ''),
        monthKey: typeof id.m === 'string' && id.m !== '' ? id.m : null,
        count: Number(g.n) || 0,
        net: Number(g.net) || 0,
        gross: Number(g.gross) || 0,
      };
    });

  const filasInfo: Row[] = [];
  for (const spec of WALLET_METRIC_SPECS) {
    const delGrupo = walletRows.filter((r) => CONCEPT_GROUPS[r.concept] === spec.group);
    // Una empresa sin la serie NO escribe filas: AP Markets no tiene un solo
    // FEE_DEBT_RECOVERY (verificado el 2026-08-28), y su mes tiene que salir
    // "sin datos", no en cero.
    if (delGrupo.length === 0) continue;
    const res = aggregateWalletMetricByMonth(delGrupo, spec);
    filasInfo.push(...toRows(companyId, spec.metric, res.buckets, now));
    for (const [concepto, v] of res.unclassified) {
      warnings.push(
        `${spec.metric}: el concepto '${concepto}' está en la familia '${spec.group}' pero la métrica no lo clasifica — ${v.count} movimiento(s) por $${v.amount} SIN contar.`,
      );
    }
    if (res.noMonth.count > 0) {
      warnings.push(
        `${spec.metric}: ${res.noMonth.count} movimiento(s) por $${res.noMonth.amount} sin fecha utilizable — fuera de la serie.`,
      );
    }
  }

  // Un concepto que el broker inventa y el registro no conoce tiene que
  // VERSE. Sin esto, dinero nuevo entraría por un flujo que nadie clasificó y
  // el número seguiría pareciendo correcto.
  const desconocidos = (datos.censo as Array<Record<string, unknown>>)
    .filter((c) => isUnknownConcept(String(c._id ?? '')))
    .sort((a, b) => (Number(b.net) || 0) - (Number(a.net) || 0));
  if (desconocidos.length > 0) {
    const detalle = desconocidos
      .map((c) => `'${String(c._id)}' (${Number(c.n) || 0} mov., $${round2(Number(c.net) || 0)})`)
      .join(', ');
    warnings.push(`Conceptos de billetera SIN clasificar en el registro: ${detalle}.`);
  }

  const filas: Row[] = [
    ...toRows(companyId, 'p2p_transfers', p2p, now),
    ...toRows(companyId, 'propfirm_sales', ventas, now, (k) => ({ wallet: billetera.get(k) ?? 0 })),
    ...toRows(companyId, 'propfirm_withdrawals', retiros, now),
    ...filasInfo,
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

  await upsertRows(admin, filas, rows);

  return {
    rows,
    // Los meses de FairPay llegan como 'YYYY-MM' y hay que normalizarlos a la
    // misma forma o el Set contaría 2026-04 y 2026-4 como dos meses distintos.
    months: new Set([
      ...filas.map((f) => `${f.year}-${f.month}`),
      ...mesesFairpay.flatMap((k) => {
        const ym = splitMonthKey(k);
        return ym ? [`${ym.year}-${ym.month}`] : [];
      }),
    ]).size,
    elapsedMs: Date.now() - started,
    warnings,
  };
}
