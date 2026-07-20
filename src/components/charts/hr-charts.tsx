'use client';

import React, { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell,
} from 'recharts';
import { EmptyState } from '@/components/ui/empty-state';
import { formatCurrency } from '@/lib/utils';
import { BarChart3, PieChart as PieIcon } from 'lucide-react';
import type { Period, CommercialMonthlyResult } from '@/lib/types';

// ─────────────────────────────────────────────────────────────────────────────
// Charts del dashboard de RRHH (rediseño UX, tanda 3).
//
// Reglas del sistema: colores SIEMPRE via tokens (var(--…)) para que flipen
// en dark mode; tooltips con formatCurrency compartido; EmptyState cuando no
// hay datos (nunca ejes vacíos). Cargados con next/dynamic desde la página
// (recharts ~350KB queda fuera del bundle inicial — mismo patrón PERF-03).
// ─────────────────────────────────────────────────────────────────────────────

const TOOLTIP_STYLE = {
  borderRadius: '8px',
  border: '1px solid var(--border)',
  backgroundColor: 'var(--card)',
  color: 'var(--foreground)',
  fontSize: '12px',
  boxShadow: 'var(--elevation-2)',
} as const;

// ─── Nómina por período: comisiones + sueldos apilados ───

export function PayrollTrendChart({
  periods,
  monthlyResults,
  maxPeriods = 8,
}: {
  periods: Period[];
  monthlyResults: CommercialMonthlyResult[];
  maxPeriods?: number;
}) {
  const data = useMemo(() => {
    const ordered = [...periods].sort((a, b) => a.year - b.year || a.month - b.month);
    const rows = ordered.map((p) => {
      let comisiones = 0;
      let sueldos = 0;
      for (const r of monthlyResults) {
        if (r.period_id !== p.id) continue;
        comisiones += r.real_payment ?? 0;
        sueldos += r.salary_paid ?? 0;
      }
      return { name: p.label ?? `${p.month}/${p.year}`, Comisiones: comisiones, Sueldos: sueldos };
    });
    // Solo períodos con nómina — meses sin resultados no aportan barras vacías.
    const withData = rows.filter((r) => r.Comisiones > 0 || r.Sueldos > 0);
    return withData.slice(-maxPeriods);
  }, [periods, monthlyResults, maxPeriods]);

  if (data.length === 0) {
    return (
      <EmptyState
        compact
        icon={BarChart3}
        title="Sin nómina registrada"
        description="Cuando haya resultados de comisiones o sueldos por período, la evolución aparece acá."
      />
    );
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} />
        <YAxis
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
          tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
          width={52}
        />
        <Tooltip
          formatter={(value, name) => [formatCurrency(Number(value)), name]}
          contentStyle={TOOLTIP_STYLE}
          cursor={{ fill: 'var(--muted)', opacity: 0.5 }}
        />
        <Legend wrapperStyle={{ fontSize: '12px' }} />
        <Bar dataKey="Comisiones" stackId="nomina" fill="var(--accent)" radius={[0, 0, 0, 0]} />
        <Bar dataKey="Sueldos" stackId="nomina" fill="var(--muted-foreground)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Distribución de empleados activos por departamento (donut) ───

// Paleta categórica: arranca en tokens de marca y extiende con hues fijos
// legibles en ambos temas (los tokens semánticos NO se usan acá — un
// departamento no es "positivo" ni "negativo").
const DONUT_COLORS = [
  'var(--accent)',
  '#8B5CF6', // violet
  '#06B6D4', // cyan
  '#F59E0B', // amber
  '#EC4899', // pink
  '#10B981', // emerald
  '#94A3B8', // slate
];

export function DepartmentDonut({
  departments,
}: {
  departments: { name: string; count: number }[];
}) {
  const total = departments.reduce((s, d) => s + d.count, 0);

  if (total === 0) {
    return (
      <EmptyState
        compact
        icon={PieIcon}
        title="Sin empleados activos"
        description="La distribución por departamento aparece al cargar empleados."
      />
    );
  }

  return (
    <div className="flex flex-col sm:flex-row items-center gap-4">
      <ResponsiveContainer width="100%" height={220} className="max-w-[220px]">
        <PieChart>
          <Pie
            data={departments}
            dataKey="count"
            nameKey="name"
            innerRadius={55}
            outerRadius={85}
            paddingAngle={2}
            strokeWidth={0}
          >
            {departments.map((_, i) => (
              <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value, name) => [`${value} ${Number(value) === 1 ? 'persona' : 'personas'}`, name]}
            contentStyle={TOOLTIP_STYLE}
          />
        </PieChart>
      </ResponsiveContainer>
      {/* Leyenda propia: la de recharts trunca nombres largos de departamento */}
      <ul className="flex-1 w-full space-y-1.5 text-sm">
        {departments.map((d, i) => (
          <li key={d.name} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 min-w-0">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }}
              />
              <span className="truncate">{d.name}</span>
            </span>
            <span className="tabular-nums text-muted-foreground shrink-0">
              {d.count} · {((d.count / total) * 100).toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
