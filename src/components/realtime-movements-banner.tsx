'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { formatCurrency } from '@/lib/utils';
import { RefreshCw, CheckCircle2, AlertTriangle, Plug } from 'lucide-react';
import { REFRESH_INTERVAL_MS } from '@/lib/api-integrations/config';
import type { AggregatedMovements } from '@/lib/api-integrations';

// ─────────────────────────────────────────────────────────────────────────────
// RealTimeMovementsBanner
//
// Polls /api/integrations/movements every 5 minutes and renders a compact
// status panel for each provider (Coinsbuy, FairPay, Unipayment).
// While real API credentials are not configured, the backend returns mock
// data and we surface an "API pendiente — usando mock" indicator.
// ─────────────────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return 'hace unos segundos';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  return `hace ${diffH} h`;
}

const PROVIDER_LABEL: Record<string, string> = {
  coinsbuy: 'Coinsbuy',
  fairpay: 'FairPay',
  unipayment: 'Unipayment',
};

export function RealTimeMovementsBanner() {
  const [data, setData] = useState<AggregatedMovements | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/integrations/movements');
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Error desconocido');
      setData({ deposits: json.deposits, withdrawals: json.withdrawals, fetchedAt: json.fetchedAt });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Error de red');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + interval polling
  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <Card>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <Plug className="w-4 h-4 text-violet-500" />
          <h3 className="text-sm font-semibold">APIs en tiempo real</h3>
          {data && (
            <span className="text-xs text-muted-foreground">
              · Actualizado {timeAgo(data.fetchedAt)}
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

      {errorMsg && (
        <div className="p-2 mb-2 rounded bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs">
          {errorMsg}
        </div>
      )}

      {data && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {data.deposits.map((p) => {
            const total = p.data.reduce((s, d) => s + d.amount, 0);
            return (
              <div
                key={p.provider}
                className="p-3 rounded-lg border border-border bg-muted/20"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold">{PROVIDER_LABEL[p.provider]}</span>
                  {p.status === 'fresh' ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  ) : (
                    <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
                  )}
                </div>
                <p className="text-base font-bold">{formatCurrency(total)}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {p.data.length} {p.data.length === 1 ? 'depósito' : 'depósitos'}
                  {p.isMock && ' · mock'}
                </p>
                {p.status === 'error' && p.errorMessage && (
                  <p className="text-[10px] text-red-500 mt-0.5 truncate" title={p.errorMessage}>
                    {p.errorMessage}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!data && !errorMsg && (
        <p className="text-xs text-muted-foreground">Cargando datos de APIs...</p>
      )}
    </Card>
  );
}
