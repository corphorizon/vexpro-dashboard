'use client';

import React, { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { DEMO_PERIODS, getPeriodSummary } from '@/lib/demo-data';
import { usePeriod } from '@/lib/period-context';

export const MonthlyChart = React.memo(function MonthlyChart() {
  const { mode, selectedPeriodIds } = usePeriod();

  const data = useMemo(() => {
    const visiblePeriods = mode === 'consolidated'
      ? DEMO_PERIODS.filter(p => selectedPeriodIds.includes(p.id))
      : DEMO_PERIODS;

    return visiblePeriods.map((period) => {
      const summary = getPeriodSummary(period.id);
      return {
        name: period.label,
        Depósitos: summary?.totalDeposits || 0,
        Retiros: summary?.totalWithdrawals || 0,
        Egresos: summary?.totalExpenses || 0,
      };
    });
  }, [mode, selectedPeriodIds]);

  return (
    <ResponsiveContainer width="100%" height={350}>
      <BarChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="name" tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} />
        <YAxis tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
        <Tooltip
          formatter={(value) => [`$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2 })}`]}
          contentStyle={{ borderRadius: '8px', border: '1px solid var(--border)', backgroundColor: 'var(--card)', color: 'var(--foreground)' }}
        />
        <Legend />
        <Bar dataKey="Depósitos" fill="#3B82F6" radius={[4, 4, 0, 0]} />
        <Bar dataKey="Retiros" fill="#EF4444" radius={[4, 4, 0, 0]} />
        <Bar dataKey="Egresos" fill="#F59E0B" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
});
