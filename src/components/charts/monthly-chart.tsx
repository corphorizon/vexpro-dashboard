'use client';

import React, { useMemo, useState, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { useData } from '@/lib/data-context';
import { usePeriod } from '@/lib/period-context';
import { isDerivedBrokerPeriod, computeDerivedBroker } from '@/lib/broker-logic';
import { withActiveCompany } from '@/lib/api-fetch';
import { ChevronLeft, ChevronRight } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// MonthlyChart — bars per period for deposits / retiros / egresos.
//
// Consolidates API + manual the same way /resumen-general and /movimientos
// do, so the bar heights always match the card values shown above the chart.
// Before this, the chart read only `summary.totalDeposits / totalWithdrawals`
// from getPeriodSummary(), which are manual-only — post-Apr-2026 periods
// that live primarily in api_transactions showed as ~half the real value.
//
// Consolidation rules (mirror of resumen-general):
//   · Historical period (pre Apr 2026) → manual only
//   · Derived-broker period            → add API totals from api_transactions
//     · Deposits     = summary.totalDeposits + apiMonth.deposits
//     · Withdrawals  = derivedBrokerFromApi(apiW, ib, pf, other) + storedBroker
//                        + ib + propFirm + other
//     · Egresos      = summary.totalExpenses (manual — no API equivalent)
// ─────────────────────────────────────────────────────────────────────────────

interface MonthTotals {
  deposits: number;
  withdrawals: number;
}

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

  // ── API period totals fetch ──────────────────────────────────────────
  // If any visible period is in the derived-broker era, request per-month
  // totals from /api/integrations/period-totals. The endpoint buckets
  // api_transactions by YYYY-MM so we can look up each bar directly.
  const hasDerived = useMemo(
    () => visiblePeriods.some(isDerivedBrokerPeriod),
    [visiblePeriods],
  );

  const { apiFrom, apiTo } = useMemo(() => {
    if (!hasDerived || visiblePeriods.length === 0) return { apiFrom: '', apiTo: '' };
    const derived = visiblePeriods.filter(isDerivedBrokerPeriod);
    if (derived.length === 0) return { apiFrom: '', apiTo: '' };
    const sorted = [...derived].sort((a, b) => a.year - b.year || a.month - b.month);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const pad = (n: number) => String(n).padStart(2, '0');
    const lastDay = new Date(last.year, last.month, 0).getDate();
    return {
      apiFrom: `${first.year}-${pad(first.month)}-01`,
      apiTo: `${last.year}-${pad(last.month)}-${pad(lastDay)}`,
    };
  }, [hasDerived, visiblePeriods]);

  const [apiMonths, setApiMonths] = useState<Record<string, MonthTotals>>({});

  useEffect(() => {
    if (!apiFrom || !apiTo) {
      setApiMonths({});
      return;
    }
    let cancelled = false;
    fetch(withActiveCompany(`/api/integrations/period-totals?from=${apiFrom}&to=${apiTo}`))
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.success && json.months) setApiMonths(json.months);
      })
      .catch(() => {
        // API down / user has no creds configured → fallback to manual only.
        if (!cancelled) setApiMonths({});
      });
    return () => { cancelled = true; };
  }, [apiFrom, apiTo]);

  // ── Per-period consolidation ─────────────────────────────────────────
  const data = useMemo(() => {
    return visiblePeriods.map((period) => {
      const summary = getPeriodSummary(period.id);
      const fallback = {
        name: period.label,
        Depósitos: summary?.totalDeposits || 0,
        Retiros: summary?.totalWithdrawals || 0,
        Egresos: summary?.totalExpenses || 0,
      };
      if (!summary) return fallback;
      if (!isDerivedBrokerPeriod(period)) return fallback;

      const pad = (n: number) => String(n).padStart(2, '0');
      const monthKey = `${period.year}-${pad(period.month)}`;
      const api = apiMonths[monthKey] ?? { deposits: 0, withdrawals: 0 };

      // Deposits: every manual channel (coinsbuy/fairpay/unipayment/other)
      // sits inside summary.totalDeposits. api.deposits adds the API side.
      // Same relationship /resumen-general uses.
      const consolidatedDeposits = summary.totalDeposits + api.deposits;

      // Withdrawals: derived-broker formula from broker-logic. storedBroker
      // stays manual; the other three categories (ib / propFirm / other) are
      // "baked into" the API total so we subtract them out first, then add
      // them back so the chart bar equals the sum of all categories visible
      // to the user in /resumen-general.
      const ibCommissions = summary.withdrawals.find((w) => w.category === 'ib_commissions')?.amount ?? 0;
      const propFirmW = summary.withdrawals.find((w) => w.category === 'prop_firm')?.amount ?? 0;
      const otherW = summary.withdrawals.find((w) => w.category === 'other')?.amount ?? 0;
      const storedBroker = summary.withdrawals.find((w) => w.category === 'broker')?.amount ?? 0;

      const derivedBroker = computeDerivedBroker({
        apiWithdrawalsTotal: api.withdrawals,
        ibCommissions,
        propFirm: propFirmW,
        other: otherW,
      });
      const consolidatedWithdrawals =
        derivedBroker + storedBroker + ibCommissions + propFirmW + otherW;

      return {
        name: period.label,
        Depósitos: consolidatedDeposits,
        Retiros: consolidatedWithdrawals,
        Egresos: summary.totalExpenses,
      };
    });
  }, [visiblePeriods, getPeriodSummary, apiMonths]);

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
