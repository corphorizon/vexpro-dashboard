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

import { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Line, ComposedChart,
} from 'recharts';
import { TrendingUp, Info } from 'lucide-react';
import { useData } from '@/lib/data-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { formatCurrency } from '@/lib/utils';
import { projectCashflow, SCENARIO_INCOME_FACTOR, type Scenario } from '@/lib/forecast';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/empty-state';

const SCENARIOS: Array<{ key: Scenario; label: string }> = [
  { key: 'pesimista', label: 'Pesimista (−20%)' },
  { key: 'base', label: 'Base' },
  { key: 'optimista', label: 'Optimista (+20%)' },
];

interface ApprovedOrder {
  id: string;
  order_number: string;
  beneficiary_name: string;
  total: number;
}

export default function ForecastPage() {
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

  const chartData = forecast.months.map((m) => ({
    name: m.label,
    Ingresos: m.income,
    Egresos: m.expenses,
    'A distribuir': m.distribuir,
  }));

  if (accessDenied) {
    return <EmptyState icon={TrendingUp} title="403 · Acceso restringido" description="No tenés acceso a Reportes." />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Forecast de Caja"
        subtitle={`Proyección a ${monthsAhead} meses con la fórmula real de distribución`}
        icon={TrendingUp}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Meses a proyectar"
              value={monthsAhead}
              onChange={(e) => setMonthsAhead(Number(e.target.value))}
              className="h-9 rounded-lg border border-border bg-card px-3 text-base sm:text-sm"
            >
              <option value={3}>3 meses</option>
              <option value={6}>6 meses</option>
              <option value={12}>12 meses</option>
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
                  {s.label}
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
          Ingresos proyectados: promedio de{' '}
          <strong>{forecast.assumptions.sampleMonths.join(', ') || '—'}</strong>{' '}
          ({formatCurrency(forecast.assumptions.avgIncome)}/mes) ×{' '}
          <strong>{SCENARIO_INCOME_FACTOR[scenario]}</strong>. Egresos: promedio de esos mismos
          meses ({formatCurrency(forecast.assumptions.avgExpenses)}/mes) — el escenario no los
          toca porque son mayormente fijos. La deuda y la reserva se arrastran desde el mes en
          curso con la misma fórmula que Socios.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label={`A distribuir en ${monthsAhead} meses`}
          value={formatCurrency(totalDistribuir)}
          tone={totalDistribuir > 0 ? 'positive' : 'warning'}
          hint="Suma de lo distribuible proyectado, escenario elegido"
        />
        <StatCard
          label="Comprometido sin pagar"
          value={formatCurrency(committedTotal)}
          tone={committedTotal > 0 ? 'warning' : 'neutral'}
          hint={`${approved.length} ${approved.length === 1 ? 'orden aprobada' : 'órdenes aprobadas'} pendientes de pago`}
        />
        <StatCard
          label="Deuda al final del horizonte"
          value={formatCurrency(lastDebt)}
          tone={lastDebt > 0 ? 'negative' : 'positive'}
          hint={lastDebt > 0 ? 'La proyección no alcanza a saldar la deuda' : 'Sin deuda arrastrada al final'}
        />
      </div>

      {/* Gráfico */}
      <Card className="p-4">
        {forecast.months.length === 0 ? (
          <EmptyState
            icon={TrendingUp}
            title="Sin historia para proyectar"
            description="Hacen falta períodos con datos para calcular el promedio."
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
              <Bar dataKey="Ingresos" fill="var(--info)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Egresos" fill="var(--warning)" radius={[4, 4, 0, 0]} />
              <Line dataKey="A distribuir" stroke="var(--positive)" strokeWidth={2} dot />
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
                <th className="px-4 py-3 font-medium">Mes</th>
                <th className="px-4 py-3 font-medium text-right">Ingresos</th>
                <th className="px-4 py-3 font-medium text-right">Egresos</th>
                <th className="px-4 py-3 font-medium text-right">Saldo</th>
                <th className="px-4 py-3 font-medium text-right">Reserva</th>
                <th className="px-4 py-3 font-medium text-right">A distribuir</th>
                <th className="px-4 py-3 font-medium text-right">Deuda arrastrada</th>
              </tr>
            </thead>
            <tbody>
              {forecast.months.map((m) => (
                <tr key={m.label} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-3 font-medium whitespace-nowrap">{m.label}</td>
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
            Órdenes aprobadas sin pagar — salida comprometida
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
              <span>Total comprometido</span>
              <span className="tabular-nums">{formatCurrency(committedTotal)}</span>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
