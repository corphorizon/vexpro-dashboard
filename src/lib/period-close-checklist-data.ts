// ─────────────────────────────────────────────────────────────────────────────
// Checklist de cierre — las CONSULTAS (server-side).
//
// Vive en un módulo propio y no dentro de la ruta porque lo llaman dos:
//   · GET /api/admin/period-close-checklist  → lo muestra antes de cerrar.
//   · POST /api/admin/data (op period_status) → lo CONGELA al cerrar
//     (period_close_checklists, migración 111).
// Importar un handler de ruta desde otra ruta para reusar una función es la
// clase de acoplamiento que después nadie se anima a tocar.
//
// Las REGLAS (qué cuenta como deriva, qué bloquea) son puras y viven en
// src/lib/period-close-checklist.ts. Acá sólo se leen datos y se arman los
// detalles. Las ETIQUETAS no están acá: viajan como clave de i18n.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { features } from '@/lib/business-model';
import {
  CHECKLIST_LABEL_KEYS,
  CRM_DRIFT_METRICS,
  computeAccrualCashGap,
  computeCrmDrift,
  earlierOpenPeriods,
  type ChecklistItem,
  type ChecklistKey,
  type PeriodOrderRow,
} from '@/lib/period-close-checklist';

/** Consulta que el modelo de negocio no admite: cuenta 0 y no toca la base.
 *  Devolver la misma forma que PostgREST evita un `if` por ítem más abajo. */
const SKIPPED = Promise.resolve({ count: 0, data: [] as unknown[] });

/** Textos de respaldo, en castellano, por si un cliente viejo no traduce. */
const FALLBACK_LABEL: Record<ChecklistKey, string> = {
  expenses_no_proof: 'Egresos sin referencia ni comprobante',
  income_lines_uncollected: 'Facturado sin cobrar',
  liquidity_unreconciled: 'Movimientos de liquidez sin cuenta MT',
  orders_approved_unpaid: 'Órdenes aprobadas sin pagar',
  investments_mixed: 'Inversiones mixtas sin separar',
  crm_drift: 'Diferencias contra lo que el CRM ya calculó',
  expenses_accrual_cash_gap: 'Los egresos se congelan por devengado, no por caja',
  earlier_periods_open: 'Hay meses anteriores sin cerrar',
};

/** Nombre de la métrica dentro del texto del detalle (que es una sola cadena;
 *  la traducción por ítem va por `labelKey`). */
const FALLBACK_METRIC_LABEL: Record<string, string> = {
  propfirm_sales: 'Ventas Prop Firm',
  propfirm_withdrawals: 'Retiros Prop Firm',
};

const money = (n: number) =>
  `$${Math.abs(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface PeriodCloseChecklist {
  period: { id: string; label: string | null };
  items: ChecklistItem[];
  clean: boolean;
  /** true → la RPC `close_period` va a rechazar el cierre. */
  blocked: boolean;
}

/**
 * Arma el checklist de un período. Recibe el admin client ya creado para que
 * el flujo de cierre (/api/admin/data) lo reutilice sin abrir otro.
 *
 * Devuelve `null` si el período no existe o no es de esa empresa.
 */
export async function buildPeriodCloseChecklist(
  admin: SupabaseClient,
  companyId: string,
  periodId: string,
): Promise<PeriodCloseChecklist | null> {
  const { data: period, error: perErr } = await admin
    .from('periods')
    .select('id, company_id, year, month, label')
    .eq('id', periodId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (perErr) throw perErr;
  if (!period) return null;

  const pad = (n: number) => String(n).padStart(2, '0');
  const monthStart = `${period.year}-${pad(period.month)}-01`;
  const monthEnd = `${period.year}-${pad(period.month)}-${pad(new Date(period.year, period.month, 0).getDate())}`;

  // El checklist tiene que hablar del negocio que cierra el mes. Una
  // consultora no tiene cuentas MT ni inversiones: esos dos ítems le daban
  // 0 SIEMPRE — ruido que enseña a cerrar sin leer — mientras que el único
  // que le importa (lo facturado y no cobrado) no estaba. Mismo registro
  // que el resto del dashboard: business-model.ts decide, no esta pantalla.
  const { data: companyRow } = await admin
    .from('companies')
    .select('business_model')
    .eq('id', companyId)
    .maybeSingle();
  const businessModel = (companyRow as { business_model?: string } | null)?.business_model ?? null;
  const f = features(businessModel);

  // Un broker también factura servicios sueltos, pero su cierre pivota sobre
  // depósitos y liquidez: agregarle un ítem cambiaría la pantalla que su
  // equipo mira todos los meses. El ítem nuevo es para el modelo donde la
  // facturación ES el ingreso — ahí lo no cobrado no se reparte.
  const billingIsTheIncome = f.incomeLines && !f.deposits;

  const [
    expNoProof,
    liqPending,
    opsApproved,
    invMixed,
    incomePending,
    expensesForGap,
    allPeriods,
    crmTotals,
    propFirmSales,
    propFirmWithdrawals,
  ] = await Promise.all([
    // Egresos del período sin referencia NI comprobante — lo primero que
    // pide cualquier contador al revisar el mes.
    admin.from('expenses')
      .select('id, concept', { count: 'exact' })
      .eq('company_id', companyId)
      .eq('period_id', periodId)
      .is('reference', null)
      .is('attachment_path', null)
      .limit(5),
    // Movimientos de liquidez del mes calendario sin cuenta MT atribuida.
    f.liquidity
      ? admin.from('liquidity_movements')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .is('account_id', null)
          .gte('date', monthStart)
          .lte('date', monthEnd)
      : SKIPPED,
    // Órdenes aprobadas sin pagar (globales — el compromiso no entiende de
    // meses, pero cerrar sin saberlo es cerrar a ciegas).
    admin.from('payment_orders')
      .select('order_number, beneficiary_name, total', { count: 'exact' })
      .eq('company_id', companyId)
      .eq('status', 'approved')
      .limit(5),
    // Inversiones `mixed` del mes: ganancia y retiro en la misma fila,
    // pendientes de separar (migración 062).
    f.investments
      ? admin.from('investments')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('movement_type', 'mixed')
          .gte('date', monthStart)
          .lte('date', monthEnd)
      : SKIPPED,
    // Líneas facturadas del período que siguen sin cobrarse. Para una
    // empresa de servicios ES el pendiente del cierre: lo que no se cobró no
    // entra en el saldo a favor y por lo tanto no se reparte — cerrar el mes
    // sin mirarlo es congelar una distribución con plata que todavía está
    // afuera. (Horizon cerraba agosto con 14.900 sin cobrar y nadie avisaba.)
    billingIsTheIncome
      ? admin.from('income_lines')
          .select('concept, client, pending', { count: 'exact' })
          .eq('company_id', companyId)
          .eq('period_id', periodId)
          .gt('pending', 0)
          .order('pending', { ascending: false })
      : SKIPPED,
    // Devengado vs caja de los egresos del período (chequeo nuevo).
    admin.from('expenses')
      .select('amount, paid')
      .eq('company_id', companyId)
      .eq('period_id', periodId),
    // Todos los períodos de la empresa: hace falta para el orden cronológico.
    admin.from('periods')
      .select('id, year, month, label, is_closed')
      .eq('company_id', companyId),
    // Lo que el CRM ya calculó para ese mes (migración 100).
    admin.from('crm_monthly_totals')
      .select('metric, amount')
      .eq('company_id', companyId)
      .eq('year', period.year)
      .eq('month', period.month),
    admin.from('prop_firm_sales')
      .select('amount')
      .eq('company_id', companyId)
      .eq('period_id', periodId),
    admin.from('withdrawals')
      .select('amount')
      .eq('company_id', companyId)
      .eq('period_id', periodId)
      .eq('category', 'prop_firm'),
  ]);

  const pendingLines = (incomePending.data ?? []) as Array<{
    concept: string; client: string | null; pending: number | string;
  }>;
  const pendingTotal = pendingLines.reduce((s, l) => s + (Number(l.pending) || 0), 0);

  const items: ChecklistItem[] = [];
  const push = (
    key: ChecklistKey,
    count: number,
    detail: string | null,
    severity: 'warning' | 'blocking' = 'warning',
  ) => {
    items.push({
      key,
      labelKey: CHECKLIST_LABEL_KEYS[key],
      label: FALLBACK_LABEL[key],
      count,
      detail,
      severity,
    });
  };

  // ── Orden cronológico primero: es el único bloqueante ───────────────────
  const periodRows: PeriodOrderRow[] = ((allPeriods.data ?? []) as Array<{
    id: string; year: number; month: number; label: string | null; is_closed: boolean | null;
  }>).map((p) => ({
    id: p.id, year: p.year, month: p.month, label: p.label, isClosed: !!p.is_closed,
  }));
  const openBefore = earlierOpenPeriods(periodRows, { year: period.year, month: period.month });
  if (openBefore.length > 0) {
    push(
      'earlier_periods_open',
      openBefore.length,
      openBefore.map((p) => p.label || `${p.year}-${String(p.month).padStart(2, '0')}`).join(' · '),
      'blocking',
    );
  }

  push(
    'expenses_no_proof',
    expNoProof.count ?? 0,
    (expNoProof.data ?? []).map((e) => (e as { concept: string }).concept).join(' · ') || null,
  );

  if (billingIsTheIncome) {
    push(
      'income_lines_uncollected',
      incomePending.count ?? 0,
      pendingLines.length > 0
        ? `Total ${money(pendingTotal)} — ` +
          pendingLines
            .slice(0, 5)
            .map((l) => `${l.client?.trim() || 'sin cliente'}: ${money(Number(l.pending) || 0)}`)
            .join(' · ')
        : null,
    );
  }

  if (f.liquidity) push('liquidity_unreconciled', liqPending.count ?? 0, null);

  push(
    'orders_approved_unpaid',
    opsApproved.count ?? 0,
    (opsApproved.data ?? [])
      .map((o) => `${(o as { order_number: string }).order_number} ${money(Number((o as { total: number }).total))}`)
      .join(' · ') || null,
  );

  if (f.investments) push('investments_mixed', invMixed.count ?? 0, null);

  // ── Deriva contra el CRM (chequeo nuevo) ────────────────────────────────
  const crmByMetric = new Map<string, number>(
    ((crmTotals.data ?? []) as Array<{ metric: string; amount: number | string }>).map((r) => [
      r.metric,
      Number(r.amount) || 0,
    ]),
  );
  const manualByKey: Record<string, number> = {
    propfirm_sales: ((propFirmSales.data ?? []) as Array<{ amount: number | string }>).reduce(
      (s, r) => s + (Number(r.amount) || 0),
      0,
    ),
    propfirm_withdrawals: ((propFirmWithdrawals.data ?? []) as Array<{ amount: number | string }>).reduce(
      (s, r) => s + (Number(r.amount) || 0),
      0,
    ),
  };
  const drifts = computeCrmDrift(
    CRM_DRIFT_METRICS.map((m) => ({
      key: m.key,
      manual: manualByKey[m.key] ?? 0,
      crm: crmByMetric.has(m.crmMetric) ? (crmByMetric.get(m.crmMetric) as number) : null,
    })),
  );
  if (drifts.length > 0) {
    push(
      'crm_drift',
      drifts.length,
      drifts
        .map(
          (d) =>
            `${FALLBACK_METRIC_LABEL[d.key] ?? d.key}: cargado ${money(d.manual)} · CRM ${money(d.crm ?? 0)} (${d.diff < 0 ? 'falta' : 'sobra'} ${money(d.diff)})`,
        )
        .join(' · '),
    );
  }

  // ── Salto devengado/caja de los egresos (chequeo nuevo) ─────────────────
  const expRows = (expensesForGap.data ?? []) as Array<{ amount: number | string; paid: number | string }>;
  const gap = computeAccrualCashGap({
    businessModel,
    totalAccrued: expRows.reduce((s, r) => s + (Number(r.amount) || 0), 0),
    totalPaid: expRows.reduce((s, r) => s + (Number(r.paid) || 0), 0),
  });
  if (gap !== null && gap !== 0) {
    push(
      'expenses_accrual_cash_gap',
      1,
      `Devengado ${money(expRows.reduce((s, r) => s + (Number(r.amount) || 0), 0))} · pagado ${money(
        expRows.reduce((s, r) => s + (Number(r.paid) || 0), 0),
      )} · diferencia ${money(gap)}`,
    );
  }

  return {
    period: { id: period.id, label: period.label },
    items,
    clean: items.every((i) => i.count === 0),
    blocked: items.some((i) => i.severity === 'blocking' && i.count > 0),
  };
}
