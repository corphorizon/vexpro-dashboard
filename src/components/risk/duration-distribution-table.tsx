'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import type { Trade } from '@/lib/risk/types';
import type { DurationBucket } from '@/lib/risk/duration-distribution';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// DurationDistributionTable
//
// Tabla con header verde (igual al diseño de referencia). Cada fila clickeable
// abre un modal con los trades del bucket. Fila Total no es clickeable.
//
// El componente es 100% controlado por las props `buckets` + totales — no
// computa nada por sí mismo, solo presenta. La fuente de verdad es siempre
// el helper `computeDurationDistribution`.
// ─────────────────────────────────────────────────────────────────────────────

interface DurationDistributionTableProps {
  buckets: DurationBucket[];
  totalCount: number;
  totalProfit: number;
}

export function DurationDistributionTable({ buckets, totalCount, totalProfit }: DurationDistributionTableProps) {
  const [openBucketKey, setOpenBucketKey] = useState<string | null>(null);
  const openBucket = openBucketKey ? buckets.find((b) => b.key === openBucketKey) : null;

  const fmt = (n: number) =>
    n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const profitColor = (n: number) =>
    n > 0 ? 'text-emerald-700 dark:text-emerald-400'
    : n < 0 ? 'text-red-600 dark:text-red-400'
    : 'text-foreground';

  return (
    <>
      <div className="rounded-xl overflow-hidden border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-emerald-700 text-white">
              <th className="px-4 py-3 text-left font-semibold">Rango de duración</th>
              <th className="px-4 py-3 text-center font-semibold">Cantidad de trades</th>
              <th className="px-4 py-3 text-center font-semibold">Profit total</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b, i) => {
              const isClickable = b.count > 0;
              return (
                <tr
                  key={b.key}
                  onClick={isClickable ? () => setOpenBucketKey(b.key) : undefined}
                  className={cn(
                    'border-b border-border transition-colors',
                    i % 2 === 1 ? 'bg-muted/30' : 'bg-card',
                    isClickable
                      ? 'cursor-pointer hover:bg-emerald-50 dark:hover:bg-emerald-950/30'
                      : 'opacity-60 cursor-default',
                  )}
                  title={isClickable ? 'Click para ver los trades de este rango' : 'Sin trades en este rango'}
                >
                  <td className="px-4 py-3 text-center font-medium">{b.label}</td>
                  <td className="px-4 py-3 text-center">{b.count}</td>
                  <td className={cn('px-4 py-3 text-center font-semibold', profitColor(b.profitTotal))}>
                    {fmt(b.profitTotal)}
                  </td>
                </tr>
              );
            })}
            {/* Fila Total */}
            <tr className="bg-emerald-700 text-white font-bold">
              <td className="px-4 py-3 text-left">Total:</td>
              <td className="px-4 py-3 text-center">{totalCount}</td>
              <td className="px-4 py-3 text-center">{fmt(totalProfit)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Modal con los trades del bucket */}
      {openBucket && (
        <DurationBucketModal
          bucket={openBucket}
          onClose={() => setOpenBucketKey(null)}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal interno — lista de trades de un bucket
// ─────────────────────────────────────────────────────────────────────────────

function DurationBucketModal({ bucket, onClose }: { bucket: DurationBucket; onClose: () => void }) {
  const fmt$ = (n: number) =>
    `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtDuration = (m: number) => {
    if (m < 1) return `${(m * 60).toFixed(0)}s`;
    if (m < 60) return `${m.toFixed(1)}m`;
    return `${(m / 60).toFixed(1)}h`;
  };
  const fmtDate = (d: Date | string) => {
    const date = typeof d === 'string' ? new Date(d) : d;
    return date.toLocaleString('es-CO', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-card rounded-xl shadow-xl w-full max-w-5xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div>
            <h3 className="font-semibold text-base">Trades en rango {bucket.label}</h3>
            <p className="text-xs text-muted-foreground">
              {bucket.count} {bucket.count === 1 ? 'trade' : 'trades'} · Profit total: {fmt$(bucket.profitTotal)}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded hover:bg-muted"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="overflow-auto flex-1">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 sticky top-0">
              <tr className="border-b border-border">
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Position</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Symbol</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Tipo</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">Volume</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">Profit</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">Duración</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Apertura</th>
              </tr>
            </thead>
            <tbody>
              {bucket.trades.map((t: Trade) => (
                <tr key={t.index} className="border-b border-border/50 hover:bg-muted/30">
                  <td className="px-3 py-2 font-mono">{t.position}</td>
                  <td className="px-3 py-2 font-medium">{t.symbol}</td>
                  <td className="px-3 py-2 uppercase">{t.type}</td>
                  <td className="px-3 py-2 text-right">{t.volume}</td>
                  <td className={`px-3 py-2 text-right font-semibold ${t.profit > 0 ? 'text-emerald-600' : t.profit < 0 ? 'text-red-600' : ''}`}>
                    {fmt$(t.profit)}
                  </td>
                  <td className="px-3 py-2 text-right">{fmtDuration(t.durationMinutes)}</td>
                  <td className="px-3 py-2">{fmtDate(t.openTime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
