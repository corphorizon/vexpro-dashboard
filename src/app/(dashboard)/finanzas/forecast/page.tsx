'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Forecast de caja — /finanzas/forecast
//
// La primera pantalla del producto que mira hacia ADELANTE. Proyección
// determinista de los próximos 6 meses corriendo los insumos reales + meses
// sintéticos por LA MISMA fórmula de distribución que usa /socios
// (src/lib/forecast.ts) — el arrastre de deuda y reserva sale de donde
// realmente está parado el negocio.
//
// Los supuestos se muestran, no se esconden: qué meses promedia, qué factor
// aplica el escenario y qué compromisos ya firmados (OPs aprobadas sin
// pagar) están fuera del promedio.
//
// ── «LIBRO MAYOR» (2026-10-12) ────────────────────────────────────────────
//   · Tres `StatCard` → `KpiStrip`. «Comprometido sin pagar» ya no dice
//     «$0.00» cuando la lectura de órdenes falla: dice «—» y por qué
//     (forecast-view.ts, con test). La deuda final va con signo de pasivo,
//     igual que la columna de la tabla y que Balances.
//   · Escenario → `Segmented`; horizonte → `Select`; supuestos → `Notice info`.
//   · El gráfico vive en un `Panel` y toma los colores de los tokens:
//     ingresos `pos` (entrada), egresos `neg` (salida), a distribuir
//     `brand-ink` (no es entrada ni salida: es el reparto). Antes: `--info`,
//     `--warning` y `--positive`, o sea ámbar para egresos («pendiente») y
//     verde para lo distribuible. El eje usaba `$${v/1000}k` armado a mano:
//     ahora `formatMoney(v, { compact })`.
//   · La tabla → `FinTable`; cada fila lleva «Proyección» (`StatusBadge
//     info`): TODOS los meses de esta tabla son sintéticos, ninguno es dato.
//     «A distribuir» ya no va en verde por ser positivo (spec §2.1).
//   Medido antes/después en este archivo: 1 `text-white` crudo + 1
//   `bg-[var(--color-primary)]` + 19 tokens legados → 0.
//
// DESCARTADO: sombrear la zona proyectada del gráfico — todo el gráfico es
// proyección; lo dice el título del panel.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Line, ComposedChart, Bar,
} from 'recharts';
import { TrendingUp } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useData } from '@/lib/data-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { formatMoney } from '@/lib/money';
import { projectCashflow, SCENARIO_INCOME_FACTOR, type Scenario } from '@/lib/forecast';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Panel } from '@/components/ui/panel';
import { Notice } from '@/components/ui/notice';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money } from '@/components/ui/money';
import { Segmented } from '@/components/ui/segmented';
import { Select } from '@/components/ui/field';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  COMMITTED_ORDERS_LIMIT,
  committedSummary,
  lastCarriedDebt,
  type ApprovedOrder,
  type CommittedState,
} from './forecast-view';

const SCENARIOS: Array<{ key: Scenario; labelKey: string }> = [
  { key: 'pesimista', labelKey: 'forecast.scenarioPessimistic' },
  { key: 'base', labelKey: 'forecast.scenarioBase' },
  { key: 'optimista', labelKey: 'forecast.scenarioOptimistic' },
];

const MONTH_ABBR_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

/** Colores del gráfico: tokens (flipan solos con el tema), nunca hex. */
const CHART = {
  income: 'var(--pos)',
  expenses: 'var(--neg)',
  distribute: 'var(--brand-ink)',
  grid: 'var(--border)',
  tick: 'var(--text-3)',
} as const;

type ForecastRow = ReturnType<typeof projectCashflow>['months'][number];

export default function ForecastPage() {
  const { t } = useI18n();
  const accessDenied = !useModuleAccess('reports');
  const { getDistributionInputs } = useData();

  const [scenario, setScenario] = useState<Scenario>('base');
  const [monthsAhead, setMonthsAhead] = useState(6);
  const [committed, setCommitted] = useState<CommittedState>({ status: 'loading' });

  // Compromisos ya firmados: órdenes aprobadas sin pagar. No entran al
  // promedio (son puntuales, no run-rate) — se muestran aparte como salida
  // comprometida del corto plazo. Si la lectura falla la proyección sigue
  // igual, pero el KPI dice «—» y no «$0.00» (forecast-view.ts).
  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/admin/payment-orders?status=approved&limit=${COMMITTED_ORDERS_LIMIT}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (!json?.success) {
          setCommitted({ status: 'failed' });
          return;
        }
        setCommitted({ status: 'ok', orders: (json.orders ?? []) as ApprovedOrder[] });
      })
      .catch(() => {
        if (!cancelled) setCommitted({ status: 'failed' });
      });
    return () => { cancelled = true; };
  }, []);

  const inputs = useMemo(() => getDistributionInputs(), [getDistributionInputs]);
  const forecast = useMemo(
    () => projectCashflow(inputs, { monthsAhead, scenario }),
    [inputs, monthsAhead, scenario],
  );

  const commit = committedSummary(committed);
  const approved = committed.status === 'ok' ? committed.orders : [];
  const totalDistribuir = forecast.months.reduce((s, m) => s + m.distribuir, 0);
  const lastDebt = lastCarriedDebt(forecast.months);

  const monthLabel = useCallback((label: string) => {
    const [abbr, yy] = label.split(' ');
    const idx = MONTH_ABBR_ES.indexOf(abbr);
    return idx === -1 ? label : `${t(`forecast.monthShort${idx + 1}`)} ${yy ?? ''}`.trim();
  }, [t]);

  const chartData = forecast.months.map((m) => ({
    name: monthLabel(m.label),
    income: m.income,
    expenses: m.expenses,
    distribuir: m.distribuir,
  }));

  if (accessDenied) {
    return (
      <EmptyState
        icon={TrendingUp}
        title={t('forecast.accessDeniedTitle')}
        description={t('forecast.accessDeniedDesc')}
      />
    );
  }

  const hasMonths = forecast.months.length > 0;

  const kpis: KpiItem[] = [
    {
      key: 'distribute',
      label: t('forecast.statDistribute', { months: String(monthsAhead) }),
      value: hasMonths ? totalDistribuir : null,
      format: 'money',
      hero: true,
      sub: hasMonths ? t('forecast.statDistributeHint') : t('forecast.emptyDesc'),
    },
    {
      key: 'committed',
      label: t('forecast.statCommitted'),
      value: commit.total,
      format: 'money',
      sub:
        commit.count === null
          ? undefined
          : commit.truncated
            ? t('forecast.lm.committedTruncated', { count: String(commit.count) })
            : t(commit.count === 1 ? 'forecast.statCommittedHintOne' : 'forecast.statCommittedHintMany', {
                count: String(commit.count),
              }),
      missingBadge:
        committed.status === 'loading'
          ? { kind: 'stale', label: t('forecast.lm.committedLoading') }
          : { kind: 'bad', label: t('forecast.lm.committedFailed') },
    },
    {
      key: 'debt',
      label: t('forecast.statDebt'),
      value: lastDebt,
      format: 'money',
      sub:
        lastDebt === null
          ? t('forecast.emptyDesc')
          : lastDebt < 0
            ? t('forecast.statDebtHintOpen')
            : t('forecast.statDebtHintClear'),
      missingBadge: false,
    },
  ];

  const projectionBadge = <StatusBadge kind="info" label={t('forecast.lm.projection')} />;

  const columns: FinColumn<ForecastRow>[] = [
    {
      key: 'month',
      header: t('forecast.colMonth'),
      cell: (m) => monthLabel(m.label),
      mobileMeta: () => projectionBadge,
    },
    { key: 'kind', header: t('forecast.lm.colKind'), cell: () => projectionBadge, hideSm: true },
    { key: 'income', header: t('forecast.seriesIncome'), kind: 'money', value: (m) => m.income, hideSm: true },
    { key: 'expenses', header: t('forecast.seriesExpenses'), kind: 'money', value: (m) => m.expenses, hideSm: true },
    { key: 'saldo', header: t('forecast.colBalance'), kind: 'money', value: (m) => m.saldo, hideSm: true },
    {
      key: 'reserve',
      header: t('forecast.colReserve'),
      kind: 'money',
      value: (m) => m.reserve,
      money: { tone: 'neutral' },
      hideSm: true,
    },
    { key: 'distribuir', header: t('forecast.seriesDistribute'), kind: 'money', value: (m) => m.distribuir },
    {
      key: 'debt',
      header: t('forecast.colCarriedDebt'),
      kind: 'money',
      // Pasivo: con signo −, en `neg`. Sin deuda, «—» (no hay nada que arrastrar).
      cell: (m) =>
        m.debtOut > 0 ? <Money value={-m.debtOut} className="font-medium" /> : <span className="text-text-3">—</span>,
      hideSm: true,
    },
  ];

  const orderColumns: FinColumn<ApprovedOrder>[] = [
    { key: 'order', header: t('forecast.lm.colOrder'), cell: (o) => o.order_number, meta: (o) => o.beneficiary_name },
    { key: 'total', header: t('forecast.lm.colAmount'), kind: 'money', value: (o) => o.total },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('forecast.title')}
        subtitle={t('forecast.subtitle', { months: String(monthsAhead) })}
        icon={TrendingUp}
        actions={
          <>
            <Select
              aria-label={t('forecast.monthsAriaLabel')}
              value={monthsAhead}
              onChange={(e) => setMonthsAhead(Number(e.target.value))}
              className="w-auto"
            >
              <option value={3}>{t('forecast.monthsOption', { n: '3' })}</option>
              <option value={6}>{t('forecast.monthsOption', { n: '6' })}</option>
              <option value={12}>{t('forecast.monthsOption', { n: '12' })}</option>
            </Select>
            <Segmented
              aria-label={t('forecast.lm.scenarioAria')}
              value={scenario}
              onChange={setScenario}
              options={SCENARIOS.map((s) => ({ value: s.key, label: t(s.labelKey) }))}
            />
          </>
        }
      />

      <KpiStrip items={kpis} />

      {committed.status === 'failed' && (
        <Notice kind="bad" title={t('forecast.lm.committedFailedTitle')}>
          {t('forecast.lm.committedFailedBody')}
        </Notice>
      )}

      {/* Supuestos a la vista — un forecast con supuestos escondidos es un
          número que parece confiable y no se puede discutir. */}
      <Notice kind="info" title={t('forecast.lm.assumptionsTitle')}>
        {t('forecast.assumptionsIncomePrefix')}{' '}
        <strong className="font-semibold text-foreground">
          {forecast.assumptions.sampleMonths.map(monthLabel).join(', ') || '—'}
        </strong>{' '}
        {t('forecast.assumptionsPerMonth', { amount: formatMoney(forecast.assumptions.avgIncome) })} ×{' '}
        <strong className="font-semibold text-foreground">{SCENARIO_INCOME_FACTOR[scenario]}</strong>.{' '}
        {t('forecast.assumptionsExpenses', { amount: formatMoney(forecast.assumptions.avgExpenses) })}
      </Notice>

      {/* Gráfico */}
      <Panel
        title={t('forecast.lm.chartTitle')}
        hint={t('forecast.lm.chartHint', { scenario: t(SCENARIOS.find((s) => s.key === scenario)!.labelKey) })}
      >
        {!hasMonths ? (
          <EmptyState
            icon={TrendingUp}
            title={t('forecast.emptyTitle')}
            description={t('forecast.emptyDesc')}
          />
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: CHART.tick }} />
              <YAxis
                tick={{ fontSize: 12, fill: CHART.tick }}
                tickFormatter={(v) => formatMoney(Number(v), { compact: true })}
                width={64}
              />
              <Tooltip
                formatter={(value) => [formatMoney(Number(value))]}
                contentStyle={{
                  borderRadius: '6px', border: '1px solid var(--border)',
                  backgroundColor: 'var(--card)', color: 'var(--foreground)',
                  fontSize: '12px', boxShadow: 'var(--shadow-2)',
                }}
                cursor={{ fill: 'var(--row-hover)' }}
              />
              <Legend wrapperStyle={{ fontSize: '12px', color: 'var(--text-2)' }} />
              <Bar dataKey="income" name={t('forecast.seriesIncome')} fill={CHART.income} radius={[4, 4, 0, 0]} />
              <Bar dataKey="expenses" name={t('forecast.seriesExpenses')} fill={CHART.expenses} radius={[4, 4, 0, 0]} />
              <Line dataKey="distribuir" name={t('forecast.seriesDistribute')} stroke={CHART.distribute} strokeWidth={2} dot />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </Panel>

      {/* Tabla */}
      <Panel flush title={t('forecast.lm.tableTitle')} hint={t('forecast.lm.tableHint')}>
        <FinTable
          columns={columns}
          rows={forecast.months}
          rowKey={(m) => m.label}
          caption={t('forecast.lm.tableTitle')}
          empty={t('forecast.emptyDesc')}
        />
      </Panel>

      {/* Compromisos firmados */}
      {approved.length > 0 && (
        <Panel
          flush
          title={t('forecast.committedTitle')}
          footer={
            commit.truncated
              ? t('forecast.lm.committedTruncatedFooter', { count: String(approved.length) })
              : undefined
          }
        >
          <FinTable
            columns={orderColumns}
            rows={approved}
            rowKey={(o) => o.id}
            caption={t('forecast.committedTitle')}
            footer={{ label: t('forecast.committedTotal'), values: { total: commit.total } }}
          />
        </Panel>
      )}
    </div>
  );
}
