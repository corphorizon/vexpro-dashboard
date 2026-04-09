'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { formatCurrency } from '@/lib/utils';
import {
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Plug,
  ChevronRight,
  Calendar,
} from 'lucide-react';
import { REFRESH_INTERVAL_MS } from '@/lib/api-integrations/config';
import { computeProviderTotals } from '@/lib/api-integrations/totals';
import type {
  ProviderDataset,
  ProviderSlug,
} from '@/lib/api-integrations/types';

// ─────────────────────────────────────────────────────────────────────────────
// RealTimeMovementsBanner
//
// Upper-filter section of the Movimientos page. Owns its own date-range
// filter (month or custom range) and polls /api/integrations/movements with
// those params. Renders four cards (Coinsbuy Deposits/Withdrawals, FairPay,
// Unipayment), each linking to a breakdown page.
// ─────────────────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return 'hace unos segundos';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  return `hace ${diffH} h`;
}

const SLUG_LABEL: Record<ProviderSlug, string> = {
  'coinsbuy-deposits': 'Coinsbuy · Depósitos',
  'coinsbuy-withdrawals': 'Coinsbuy · Retiros',
  fairpay: 'FairPay · Depósitos',
  unipayment: 'Unipayment · Depósitos',
};

const SLUG_ACCENT: Record<ProviderSlug, string> = {
  'coinsbuy-deposits': 'text-blue-600 dark:text-blue-400',
  'coinsbuy-withdrawals': 'text-red-600 dark:text-red-400',
  fairpay: 'text-emerald-600 dark:text-emerald-400',
  unipayment: 'text-violet-600 dark:text-violet-400',
};

// ── Current month helpers ──

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function currentMonthStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function monthBounds(yearMonth: string): { from: string; to: string } {
  const [y, m] = yearMonth.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return {
    from: `${y}-${pad(m)}-01`,
    to: `${y}-${pad(m)}-${pad(last)}`,
  };
}

type FilterMode = 'month' | 'range';

export function RealTimeMovementsBanner() {
  const [mode, setMode] = useState<FilterMode>('month');
  const [month, setMonth] = useState<string>(currentMonthStr());
  const [rangeFrom, setRangeFrom] = useState<string>('');
  const [rangeTo, setRangeTo] = useState<string>('');

  const [datasets, setDatasets] = useState<ProviderDataset[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Resolve the effective {from, to} from the filter state.
  const { from, to } = useMemo(() => {
    if (mode === 'month') return monthBounds(month);
    return { from: rangeFrom, to: rangeTo };
  }, [mode, month, rangeFrom, rangeTo]);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      const res = await fetch(`/api/integrations/movements?${qs.toString()}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Error desconocido');
      setDatasets(json.datasets ?? []);
      setFetchedAt(json.fetchedAt);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Error de red');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  // Refetch on filter change + poll every REFRESH_INTERVAL_MS.
  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Query-string carried over into the breakdown page link so the breakdown
  // starts on the same range (it has its own filter afterwards).
  const linkQs = useMemo(() => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    return p.toString();
  }, [from, to]);

  return (
    <Card>
      {/* Header row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Plug className="w-4 h-4 text-violet-500" />
          <h3 className="text-sm font-semibold">APIs en tiempo real</h3>
          {fetchedAt && (
            <span className="text-xs text-muted-foreground">
              · Actualizado {timeAgo(fetchedAt)}
            </span>
          )}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="self-start sm:self-auto flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border bg-card text-xs hover:bg-muted transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refrescar
        </button>
      </div>

      {/* Filter controls */}
      <div className="flex flex-wrap items-center gap-2 mb-4 p-2 rounded-lg bg-muted/30 border border-border">
        <div className="flex items-center gap-1.5 pl-1 pr-0.5">
          <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">Período</span>
        </div>
        {/* Segmented toggle — single pill with evenly sized buttons and no seams */}
        <div className="inline-flex h-8 items-center rounded-md border border-border bg-card p-0.5">
          <button
            type="button"
            onClick={() => setMode('month')}
            className={`h-7 px-3 text-xs font-medium rounded-[5px] transition-colors ${
              mode === 'month'
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Mes
          </button>
          <button
            type="button"
            onClick={() => setMode('range')}
            className={`h-7 px-3 text-xs font-medium rounded-[5px] transition-colors ${
              mode === 'range'
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Rango
          </button>
        </div>
        {mode === 'month' ? (
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="h-8 px-2.5 text-xs rounded-md border border-border bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        ) : (
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={rangeFrom}
              onChange={(e) => setRangeFrom(e.target.value)}
              className="h-8 px-2.5 text-xs rounded-md border border-border bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
              aria-label="Desde"
            />
            <span className="text-xs text-muted-foreground">—</span>
            <input
              type="date"
              value={rangeTo}
              onChange={(e) => setRangeTo(e.target.value)}
              className="h-8 px-2.5 text-xs rounded-md border border-border bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
              aria-label="Hasta"
            />
          </div>
        )}
      </div>

      {errorMsg && (
        <div className="p-2 mb-2 rounded bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs">
          {errorMsg}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        {datasets.map((ds) => {
          const totals = computeProviderTotals(ds);
          return (
            <Link
              key={ds.slug}
              href={`/movimientos/desglose/${ds.slug}${linkQs ? `?${linkQs}` : ''}`}
              className="block p-3 rounded-lg border border-border bg-muted/20 hover:bg-muted/40 transition-colors group"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold truncate">
                  {SLUG_LABEL[ds.slug]}
                </span>
                {ds.status === 'fresh' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                ) : (
                  <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
                )}
              </div>
              <p className={`text-base font-bold ${SLUG_ACCENT[ds.slug]}`}>
                {formatCurrency(totals.total)}
              </p>
              <div className="flex items-center justify-between mt-0.5">
                <p className="text-[10px] text-muted-foreground">
                  {totals.count} {totals.count === 1 ? 'tx' : 'tx'} ·{' '}
                  {totals.acceptedStatus}
                  {ds.isMock && ' · mock'}
                </p>
                <ChevronRight className="w-3 h-3 text-muted-foreground group-hover:translate-x-0.5 transition-transform" />
              </div>
              {ds.status === 'error' && ds.errorMessage && (
                <p className="text-[10px] text-red-500 mt-0.5 truncate" title={ds.errorMessage}>
                  {ds.errorMessage}
                </p>
              )}
            </Link>
          );
        })}
        {datasets.length === 0 && !errorMsg && (
          <p className="text-xs text-muted-foreground col-span-full">
            Cargando datos de APIs...
          </p>
        )}
      </div>
    </Card>
  );
}

// Exported so the main Movimientos page can read API totals for the
// "Depósitos Totales" / "Retiros Totales" lines in the period tables.
export function useApiTotals(from: string, to: string) {
  const [datasets, setDatasets] = useState<ProviderDataset[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const qs = new URLSearchParams();
        if (from) qs.set('from', from);
        if (to) qs.set('to', to);
        const res = await fetch(`/api/integrations/movements?${qs.toString()}`);
        const json = await res.json();
        if (!cancelled && json.success) {
          setDatasets(json.datasets ?? []);
        }
      } catch {
        // Silent — API card already shows errors.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  return useMemo(() => {
    const by: Record<ProviderSlug, number> = {
      'coinsbuy-deposits': 0,
      'coinsbuy-withdrawals': 0,
      fairpay: 0,
      unipayment: 0,
    };
    for (const ds of datasets) {
      by[ds.slug] = computeProviderTotals(ds).total;
    }
    const depositsTotal = by['coinsbuy-deposits'] + by.fairpay + by.unipayment;
    const withdrawalsTotal = by['coinsbuy-withdrawals'];
    return { by, depositsTotal, withdrawalsTotal };
  }, [datasets]);
}
