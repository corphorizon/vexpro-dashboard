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
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Line, ComposedChart,
} from 'recharts';
import { TrendingUp, Info } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useData } from '@/lib/data-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { formatCurrency } from '@/lib/utils';
import { projectCashflow, SCENARIO_INCOME_FACTOR, type Scenario } from '@/lib/forecast';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/empty-state';

const SCENARIOS: Array<{ key: Scenario; labelKey: string }> = [
  { key: 'pesimista', labelKey: 'forecast.scenarioPessimistic' },
  { key: 'base', labelKey: 'forecast.scenarioBase' },
  { key: 'optimista', labelKey: 'forecast.scenarioOptimistic' },
];

const MONTH_ABBR_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

interface ApprovedOrder {
  id: string;
  order_number: string;
  beneficiary_name: string;
  total: number;
}

export default function ForecastPage() {
  const { t } = useI18n();
  const accessDenied = !useModuleAccess('reports');
  const { getDistributionInputs } = useData();

  const [scenario, setScenario] = useState<Scenario>('base');
  const [monthsAhead, setMonthsAhead] = useState(6);
  const [approved, setApproved] = useState<ApprovedOrder[]>([]);

  // Compromisos ya firmados: órdenes aprobadas sin pagar. No entran al
  // promedio (son puntuales, no run-rate) — se muestran aparte como salida
  // comprometida del corto plazo.
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/admin/payment-orders?status=approved')
      .then((r) => r.json())
      .then((json) => {
        if (cancelled || !json.success) return;
        const rows = (json.orders ?? []) as ApprovedOrder[];
        setApproved(rows);
      })
      .catch(() => { /* el forecast funciona igual sin este dato */ });
    return () => { cancelled = true; };
  }, []);

  const inputs = useMemo(() => getDistributionInputs(), [getDistributionInputs]);
  const forecast = useMemo(
    () => projectCashflow(inputs, { monthsAhead, scenario }),
    [inputs, monthsAhead, scenario],
  );

  const committedTotal = approved.reduce((s, o) => s + o.total, 0);
  const totalDistribuir = forecast.months.reduce((s, m) => s + m.distribuir, 0);
  const lastDebt = forecast.months.at(-1)?.debtOut ?? 0;

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

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('forecast.title')}
        subtitle={t('forecast.subtitle', { months: String(monthsAhead) })}
        icon={TrendingUp}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t('forecast.monthsAriaLabel')}
              value={monthsAhead}
              onChange={(e) => setMonthsAhead(Number(e.target.value))}
              className="h-9 rounded-lg border border-border bg-card px-3 text-base sm:text-sm"
            >
              <option value={3}>{t('forecast.monthsOption', { n: '3' })}</option>
              <option value={6}>{t('forecast.monthsOption', { n: '6' })}</option>
              <option value={12}>{t('forecast.monthsOption', { n: '12' })}</option>
            </select>
            <div className="flex rounded-lg border border-border overflow-hidden">
              {SCENARIOS.map((s) => (
                <button
                  key={s.key}
                  onClick={() => setScenario(s.key)}
                  className={`px-3 h-9 text-xs font-medium transition-colors ${
                    scenario === s.key
                      ? 'bg-[var(--color-primary)] text-white'
                      : 'bg-card text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {t(s.labelKey)}
                </button>
              ))}
            </div>
          </div>
        }
      />

      {/* Supuestos a la vista — un forecast con supuestos escondidos es un
          número que parece confiable y no se puede discutir. */}
      <div className="flex gap-3 rounded-lg border border-border bg-muted/40 p-4">
        <Info className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">
          {t('forecast.assumptionsIncomePrefix')}{' '}
          <strong>{forecast.assumptions.sampleMonths.map(monthLabel).join(', ') || '—'}</strong>{' '}
          {t('forecast.assumptionsPerMonth', { amount: formatCurrency(forecast.assumptions.avgIncome) })} ×{' '}
          <strong>{SCENARIO_INCOME_FACTOR[scenario]}</strong>.{' '}
          {t('forecast.assumptionsExpenses', { amount: formatCurrency(forecast.assumptions.avgExpenses) })}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label={t('forecast.statDistribute', { months: String(monthsAhead) })}
          value={formatCurrency(totalDistribuir)}
          tone={totalDistribuir > 0 ? 'positive' : 'warning'}
          hint={t('forecast.statDistributeHint')}
        />
        <StatCard
          label={t('forecast.statCommitted')}
          value={formatCurrency(committedTotal)}
          tone={committedTotal > 0 ? 'warning' : 'neutral'}
          hint={t(
            approved.length === 1 ? 'forecast.statCommittedHintOne' : 'forecast.statCommittedHintMany',
            { count: String(approved.length) },
          )}
        />
        <StatCard
          label={t('forecast.statDebt')}
          value={formatCurrency(lastDebt)}
          tone={lastDebt > 0 ? 'negative' : 'positive'}
          hint={lastDebt > 0 ? t('forecast.statDebtHintOpen') : t('forecast.statDebtHintClear')}
        />
      </div>

      {/* Gráfico */}
      <Card className="p-4">
        {forecast.months.length === 0 ? (
          <EmptyState
            icon={TrendingUp}
            title={t('forecast.emptyTitle')}
            description={t('forecast.emptyDesc')}
          />
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} />
              <YAxis
                tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
                tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                width={55}
              />
              <Tooltip
                formatter={(value) => [formatCurrency(Number(value))]}
                contentStyle={{
                  borderRadius: '8px', border: '1px solid var(--border)',
                  backgroundColor: 'var(--card)', color: 'var(--foreground)',
                  fontSize: '12px', boxShadow: 'var(--elevation-2)',
                }}
                cursor={{ fill: 'var(--muted)', opacity: 0.5 }}
              />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
              <Bar dataKey="income" name={t('forecast.seriesIncome')} fill="var(--info)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="expenses" name={t('forecast.seriesExpenses')} fill="var(--warning)" radius={[4, 4, 0, 0]} />
              <Line dataKey="distribuir" name={t('forecast.seriesDistribute')} stroke="var(--positive)" strokeWidth={2} dot />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </Card>

      {/* Tabla */}
      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-medium">{t('forecast.colMonth')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('forecast.seriesIncome')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('forecast.seriesExpenses')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('forecast.colBalance')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('forecast.colReserve')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('forecast.seriesDistribute')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('forecast.colCarriedDebt')}</th>
              </tr>
            </thead>
            <tbody>
              {forecast.months.map((m) => (
                <tr key={m.label} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-3 font-medium whitespace-nowrap">{monthLabel(m.label)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatCurrency(m.income)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatCurrency(m.expenses)}</td>
                  <td className={`px-4 py-3 text-right tabular-nums ${m.saldo < 0 ? 'text-negative' : ''}`}>
                    {formatCurrency(m.saldo)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {formatCurrency(m.reserve)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium text-positive">
                    {formatCurrency(m.distribuir)}
                  </td>
                  <td className={`px-4 py-3 text-right tabular-nums ${m.debtOut > 0 ? 'text-negative' : 'text-muted-foreground'}`}>
                    {m.debtOut > 0 ? formatCurrency(-m.debtOut) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Compromisos firmados */}
      {approved.length > 0 && (
        <Card className="p-4">
          <h2 className="text-sm font-semibold mb-3">
            {t('forecast.committedTitle')}
          </h2>
          <div className="space-y-1">
            {approved.map((o) => (
              <div key={o.id} className="flex items-center justify-between text-sm py-1.5 border-b border-border/50 last:border-0">
                <span className="text-muted-foreground">
                  {o.order_number} · {o.beneficiary_name}
                </span>
                <span className="tabular-nums font-medium">{formatCurrency(o.total)}</span>
              </div>
            ))}
            <div className="flex items-center justify-between text-sm pt-2 font-semibold">
              <span>{t('forecast.committedTotal')}</span>
              <span className="tabular-nums">{formatCurrency(committedTotal)}</span>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
