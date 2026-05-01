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
  Wallet,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { computeProviderTotals } from '@/lib/api-integrations/totals';
import { withActiveCompany } from '@/lib/api-fetch';
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

interface WalletOption {
  id: string;
  label: string;
  currencyCode: string;
}

// Sentinel meaning "no default wallet chosen yet — use the tenant's
// configured default (companies.default_wallet_id) or the first wallet
// the API returns, in that order". Kept as an exported constant for
// back-compat with older callers that still passed it explicitly.
//
// The old literal '1079' (VexPro's Main Wallet ID) was removed in
// migration-031. Every tenant now owns its default_wallet_id on the
// companies row; resolveInitialWalletId() below applies the fallback
// chain uniformly.
export const DEFAULT_WALLET_ID = '';

/**
 * Resolves the wallet id we should show on first render.
 *
 *   1. Controlled prop wins (the Movimientos page lifts state)
 *   2. Tenant's default_wallet_id from the companies row
 *   3. Sentinel '' — banner later swaps to the first API wallet in a
 *      useEffect once walletOptions arrive
 */
function resolveInitialWalletId(
  controlled: string | undefined,
  tenantDefault: string | null | undefined,
): string {
  if (controlled !== undefined) return controlled;
  if (tenantDefault) return tenantDefault;
  return '';
}

interface BannerProps {
  /** Optional controlled wallet id. When provided, banner becomes controlled
   *  and propagates changes via onWalletChange. Used so the Movimientos
   *  page can keep the banner AND the "Depósitos" table in sync (same
   *  walletId → same totals). */
  walletId?: string;
  onWalletChange?: (walletId: string) => void;
  /** Fires after the banner finishes a live sync (user pressed "Refrescar").
   *  The parent page uses this to invalidate its own persisted-movements
   *  cache so the tables below update with the freshly synced data. */
  onAfterLiveSync?: () => void;
}

export function RealTimeMovementsBanner({ walletId: walletIdProp, onWalletChange, onAfterLiveSync }: BannerProps = {}) {
  const { user } = useAuth();
  const { company } = useData();
  const isAdmin = user?.role === 'admin';

  const [mode, setMode] = useState<FilterMode>('month');
  const [month, setMonth] = useState<string>(currentMonthStr());
  const [rangeFrom, setRangeFrom] = useState<string>('');
  const [rangeTo, setRangeTo] = useState<string>('');
  // Initial wallet id comes from the tenant's companies.default_wallet_id.
  // If null (tenant hasn't picked one yet) we fall through to '' and let
  // the walletOptions-sync effect below pick the first API wallet.
  const [walletIdLocal, setWalletIdLocal] = useState<string>(
    resolveInitialWalletId(walletIdProp, company?.default_wallet_id),
  );
  const walletId = walletIdProp ?? walletIdLocal;
  const setWalletId = (id: string) => {
    if (onWalletChange) onWalletChange(id);
    else setWalletIdLocal(id);
  };
  const [walletOptions, setWalletOptions] = useState<WalletOption[]>([]);

  const [datasets, setDatasets] = useState<ProviderDataset[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Load wallet options once on mount — only admins need the full list
  useEffect(() => {
    if (!isAdmin) return; // Non-admins use the default wallet, no need to fetch
    (async () => {
      try {
        const res = await fetch(withActiveCompany('/api/integrations/coinsbuy/wallets'));
        const json = await res.json();
        if (json.success && Array.isArray(json.wallets)) {
          const options: WalletOption[] = json.wallets.map(
            (w: { id: string; label: string; currencyCode: string }) => ({
              id: w.id,
              label: w.label,
              currencyCode: w.currencyCode,
            }),
          );
          setWalletOptions(options);

          // Fallback: if the currently-resolved walletId is empty (no
          // tenant default, no controlled prop, no previous local pick),
          // seed it with the first API wallet so the rest of the page
          // has something to filter against.
          //
          // setWalletId() routes through onWalletChange when controlled,
          // so the parent's state stays in sync. When uncontrolled it
          // writes to walletIdLocal.
          const effective = walletIdProp ?? walletIdLocal;
          if (!effective && options.length > 0) {
            setWalletId(options[0].id);
          }
        }
      } catch {
        // Silent — wallets are optional filter
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  // Resolve the effective {from, to} from the filter state.
  const { from, to } = useMemo(() => {
    if (mode === 'month') return monthBounds(month);
    return { from: rangeFrom, to: rangeTo };
  }, [mode, month, rangeFrom, rangeTo]);

  // Two modes of loading:
  //   1. loadFromCache (default on mount + filter changes): reads the last
  //      persisted state from Supabase. NO external API calls.
  //   2. loadLive (triggered by the "Refrescar" button): hits the real
  //      providers, writes through to api_transactions, and shows fresh data.
  // This way opening the page is fast and free of API quotas, and the user
  // explicitly decides when to sync.
  const loadFromCache = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      if (walletId) qs.set('walletId', walletId);
      const res = await fetch(withActiveCompany(`/api/integrations/persisted-movements?${qs.toString()}`));
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Error cargando datos persistidos');
      setDatasets(json.datasets ?? []);
      setFetchedAt(json.fetchedAt);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Error de red');
    } finally {
      setLoading(false);
    }
  }, [from, to, walletId]);

  const loadLive = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      if (walletId) qs.set('walletId', walletId);
      const res = await fetch(withActiveCompany(`/api/integrations/movements?${qs.toString()}`));
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Error desconocido');
      setDatasets(json.datasets ?? []);
      setFetchedAt(json.fetchedAt);
      // Wait briefly for the server-side fire-and-forget persist to complete,
      // THEN tell the parent page to re-read from Supabase. Without this
      // delay the tables below could fetch persisted-movements before the
      // write-through finished, showing stale zeros.
      if (onAfterLiveSync) {
        setTimeout(onAfterLiveSync, 1500);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Error de red');
    } finally {
      setLoading(false);
    }
  }, [from, to, walletId, onAfterLiveSync]);

  // Load from cache on mount + whenever filters change. Never auto-fetch
  // from external APIs — that only happens when the user clicks Refrescar.
  useEffect(() => {
    loadFromCache();
  }, [loadFromCache]);

  // Query-string carried over into the breakdown page link so the breakdown
  // starts on the same range AND the same wallet filter the cards used.
  // Passing walletId here is the difference that closes the "tarjetas vs
  // desglose" discrepancy Kevin reported on 2026-05-01 — without this the
  // breakdown defaulted to all wallets.
  const linkQs = useMemo(() => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (walletId) p.set('walletId', walletId);
    return p.toString();
  }, [from, to, walletId]);

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
          onClick={loadLive}
          disabled={loading}
          title="Consulta las APIs externas y guarda los resultados"
          className="self-start sm:self-auto flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/5 text-xs font-medium hover:bg-[var(--color-primary)]/10 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Sincronizando…' : 'Refrescar desde APIs'}
        </button>
      </div>

      {/* Filter controls */}
      <div className="flex flex-wrap items-center gap-3 mb-4 p-3 rounded-lg bg-muted/30 border border-border">
        {/* Mode toggle: Mes vs Rango */}
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-muted-foreground" />
          <div className="inline-flex rounded-md border border-border bg-card overflow-hidden">
            <button
              type="button"
              onClick={() => setMode('month')}
              aria-pressed={mode === 'month'}
              className={`px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                mode === 'month'
                  ? 'bg-[var(--color-primary)] text-white'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              Mes
            </button>
            <button
              type="button"
              onClick={() => setMode('range')}
              aria-pressed={mode === 'range'}
              className={`px-3.5 py-1.5 text-xs font-semibold transition-colors border-l border-border ${
                mode === 'range'
                  ? 'bg-[var(--color-primary)] text-white border-l-[var(--color-primary)]'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              Rango
            </button>
          </div>
        </div>

        {/* Date input(s) — mes único o rango */}
        {mode === 'month' ? (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-medium">Mes:</span>
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="h-8 px-2.5 text-xs rounded-md border border-border bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30"
              aria-label="Seleccionar mes"
            />
          </label>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-medium">Desde:</span>
              <input
                type="date"
                value={rangeFrom}
                onChange={(e) => setRangeFrom(e.target.value)}
                className="h-8 px-2.5 text-xs rounded-md border border-border bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30"
                aria-label="Fecha desde"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-medium">Hasta:</span>
              <input
                type="date"
                value={rangeTo}
                onChange={(e) => setRangeTo(e.target.value)}
                className="h-8 px-2.5 text-xs rounded-md border border-border bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30"
                aria-label="Fecha hasta"
              />
            </label>
          </div>
        )}

        {/* Divider + wallet selector */}
        <div className="w-px h-6 bg-border hidden sm:block" />

        {/* Wallet selector (Coinsbuy) — only admins can change */}
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Wallet className="w-4 h-4" />
          <span className="font-medium">Wallet:</span>
          {isAdmin && walletOptions.length > 0 ? (
            <select
              value={walletId}
              onChange={(e) => setWalletId(e.target.value)}
              className="h-8 px-2.5 text-xs rounded-md border border-border bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 max-w-[240px]"
              aria-label="Seleccionar wallet de Coinsbuy"
            >
              <option value="">Todas las wallets</option>
              {walletOptions.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label} ({w.currencyCode})
                </option>
              ))}
            </select>
          ) : (
            <span className="h-8 flex items-center px-2.5 text-xs rounded-md border border-border bg-muted/50 text-foreground">
              Wallet principal
            </span>
          )}
        </label>
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
// Reads from the persisted cache — never triggers a live API call on its
// own. The banner's "Refrescar" button is what syncs new data in.
// `walletId` MUST be passed so the totals stay consistent with what the
// banner displays.
export function useApiTotals(
  from: string,
  to: string,
  walletId: string = DEFAULT_WALLET_ID,
  /** Bump this number to force a re-read of the persisted cache (after the
   *  banner finishes a live sync and writes through to Supabase). */
  refreshKey: number = 0,
) {
  const [datasets, setDatasets] = useState<ProviderDataset[]>([]);

  // Debounce rapid wallet-selector clicks (350 ms) and support AbortController
  // so a newer request supersedes an older one mid-flight — fixes N-fetches-
  // per-click when the user scrolls through wallets quickly.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      (async () => {
        try {
          const qs = new URLSearchParams();
          if (from) qs.set('from', from);
          if (to) qs.set('to', to);
          if (walletId) qs.set('walletId', walletId);
          const res = await fetch(
            `/api/integrations/persisted-movements?${qs.toString()}`,
            { signal: controller.signal },
          );
          const json = await res.json();
          if (!cancelled && json.success) {
            setDatasets(json.datasets ?? []);
          }
        } catch {
          // Silent — card already shows errors.
        }
      })();
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [from, to, walletId, refreshKey]);

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
