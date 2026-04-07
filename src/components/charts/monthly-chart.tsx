'use client';

import React, { useMemo, useState, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { useData } from '@/lib/data-context';
import { usePeriod } from '@/lib/period-context';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export const MonthlyChart = React.memo(function MonthlyChart() {
  const { mode, selectedPeriodIds } = usePeriod();
  const { periods, getPeriodSummary } = useData();

  // Responsive: detect mobile
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const maxVisible = isMobile ? 3 : 6;

  const allPeriods = useMemo(() => {
    return mode === 'consolidated'
      ? periods.filter(p => selectedPeriodIds.includes(p.id))
      : periods;
  }, [mode, selectedPeriodIds, periods]);

  // Default to showing the last N periods
  const [startIndex, setStartIndex] = useState(() => Math.max(0, allPeriods.length - maxVisible));

  // Reset when periods or maxVisible change
  useEffect(() => {
    setStartIndex(Math.max(0, allPeriods.length - maxVisible));
  }, [allPeriods.length, maxVisible]);

  const visiblePeriods = allPeriods.slice(startIndex, startIndex + maxVisible);
  const canGoBack = startIndex > 0;
  const canGoForward = startIndex + maxVisible < allPeriods.length;

  const data = useMemo(() => {
    return visiblePeriods.map((period) => {
      const summary = getPeriodSummary(period.id);
      return {
        name: period.label,
        Depósitos: summary?.totalDeposits || 0,
        Retiros: summary?.totalWithdrawals || 0,
        Egresos: summary?.totalExpenses || 0,
      };
    });
  }, [visiblePeriods, getPeriodSummary]);

  return (
    <div>
      {/* Navigation controls */}
      {allPeriods.length > maxVisible && (
        <div className="flex items-center justify-end gap-2 mb-3">
          <span className="text-xs text-muted-foreground">
            {visiblePeriods[0]?.label} — {visiblePeriods[visiblePeriods.length - 1]?.label}
          </span>
          <button
            onClick={() => setStartIndex(Math.max(0, startIndex - maxVisible))}
            disabled={!canGoBack}
            className="p-1 rounded-md border border-border hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => setStartIndex(Math.min(allPeriods.length - maxVisible, startIndex + maxVisible))}
            disabled={!canGoForward}
            className="p-1 rounded-md border border-border hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}

      <ResponsiveContainer width="100%" height={isMobile ? 250 : 350}>
        <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="name" tick={{ fontSize: isMobile ? 10 : 12, fill: 'var(--muted-foreground)' }} />
          <YAxis tick={{ fontSize: isMobile ? 10 : 12, fill: 'var(--muted-foreground)' }} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} width={isMobile ? 45 : 60} />
          <Tooltip
            formatter={(value) => [`$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2 })}`]}
            contentStyle={{ borderRadius: '8px', border: '1px solid var(--border)', backgroundColor: 'var(--card)', color: 'var(--foreground)', fontSize: '12px' }}
          />
          <Legend wrapperStyle={{ fontSize: isMobile ? '10px' : '12px' }} />
          <Bar dataKey="Depósitos" fill="#3B82F6" radius={[4, 4, 0, 0]} />
          <Bar dataKey="Retiros" fill="#EF4444" radius={[4, 4, 0, 0]} />
          <Bar dataKey="Egresos" fill="#F59E0B" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
});
