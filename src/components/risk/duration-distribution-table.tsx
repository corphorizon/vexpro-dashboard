'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Trade } from '@/lib/risk/types';
import type { DurationBucket } from '@/lib/risk/duration-distribution';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { NUM_CLASS } from '@/components/ui/money';
import { ROW_ACTION_CLASS } from '@/components/payment-orders/action-button';
import { cn, formatNumber } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// DurationDistributionTable
//
// Cada fila clickeable abre un modal con los trades del bucket. La fila Total
// no es clickeable.
//
// El componente es 100% controlado por las props `buckets` + totales — no
// computa nada por sí mismo, solo presenta. La fuente de verdad es siempre
// el helper `computeDurationDistribution`.
//
// «LIBRO MAYOR» (2026-10-12): FinTable con el total como fila `total` dentro
// de la tabla (antes `border-t-2` + `bg-muted/50`), números a la derecha y tabulares (antes
// centrados), profit con tono `sign` desde la misma regla que <Money>, y el
// modal con tokens (antes `text-emerald-600` / `text-red-600` en las filas).
// El profit sigue en el MISMO formato que antes (`formatNumber`, sin «$»):
// es el de la cuenta del informe, que puede no estar en dólares.
//
// DESCARTADO: el `footer` de FinTable — formatea sus valores con <Money>
// («$»), y este profit no está necesariamente en dólares (ver arriba).
// ─────────────────────────────────────────────────────────────────────────────

interface DurationDistributionTableProps {
  buckets: DurationBucket[];
  totalCount: number;
  totalProfit: number;
}

const TOTAL_KEY = '__total__';

interface DistRow {
  key: string;
  label: string;
  count: number;
  profitTotal: number;
  isTotal?: boolean;
}

/** Profit con signo de color (misma regla que moneyToneClass, en `formatNumber`). */
function Profit({ value, className }: { value: number; className?: string }) {
  const cents = Math.round(value * 100);
  return (
    <span className={cn(NUM_CLASS, cents > 0 && 'text-pos', cents < 0 && 'text-neg', className)}>
      {formatNumber(value)}
    </span>
  );
}

export function DurationDistributionTable({ buckets, totalCount, totalProfit }: DurationDistributionTableProps) {
  const [openBucketKey, setOpenBucketKey] = useState<string | null>(null);
  const openBucket = openBucketKey ? buckets.find((b) => b.key === openBucketKey) : null;

  const rows: DistRow[] = [
    ...buckets.map((b) => ({ key: b.key, label: b.label, count: b.count, profitTotal: b.profitTotal })),
    { key: TOTAL_KEY, label: 'Total', count: totalCount, profitTotal: totalProfit, isTotal: true },
  ];

  const columns: FinColumn<DistRow>[] = [
    {
      key: 'label',
      header: 'Rango de duración',
      cell: (b) => <span className={cn(!b.isTotal && b.count === 0 && 'text-text-3')}>{b.label}</span>,
    },
    { key: 'count', header: 'Cantidad de trades', kind: 'number', value: (b) => b.count },
    {
      key: 'profit',
      header: 'Profit total',
      kind: 'number',
      value: (b) => b.profitTotal,
      cell: (b) => <Profit value={b.profitTotal} className="font-medium" />,
    },
  ];

  return (
    <>
      <FinTable<DistRow>
        caption="Distribución por duración"
        columns={columns}
        rows={rows}
        rowKey={(b) => b.key}
        // La fila Total va dentro de la tabla (alineada con sus columnas),
        // con el fondo y el peso de un total. No abre detalle.
        rowVariant={(b) => (b.isTotal ? 'total' : undefined)}
        // Sólo los rangos con trades abren el detalle: uno vacío no tiene qué mostrar.
        onRowClick={(b) => {
          if (!b.isTotal && b.count > 0) setOpenBucketKey(b.key);
        }}
      />

      {openBucket && <DurationBucketModal bucket={openBucket} onClose={() => setOpenBucketKey(null)} />}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal interno — lista de trades de un bucket
// ─────────────────────────────────────────────────────────────────────────────

function DurationBucketModal({ bucket, onClose }: { bucket: DurationBucket; onClose: () => void }) {
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

  // ESC cierra (antes sólo el botón o el clic afuera).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const columns: FinColumn<Trade>[] = [
    {
      key: 'position',
      header: 'Position',
      cell: (t) => <span className="font-mono text-[12px]">{t.position}</span>,
      meta: (t) => `${t.symbol} · ${t.type.toUpperCase()}`,
    },
    { key: 'volume', header: 'Volume', align: 'right', hideSm: true, cell: (t) => <span className={NUM_CLASS}>{t.volume}</span> },
    {
      key: 'profit',
      header: 'Profit',
      kind: 'money',
      value: (t) => t.profit,
      money: { tone: 'sign' },
    },
    {
      key: 'duration',
      header: 'Duración',
      align: 'right',
      hideSm: true,
      cell: (t) => <span className={cn(NUM_CLASS, 'text-text-2')}>{fmtDuration(t.durationMinutes)}</span>,
    },
    {
      key: 'open',
      header: 'Apertura',
      hideSm: true,
      cell: (t) => <span className={cn(NUM_CLASS, 'text-[12.5px] text-text-2')}>{fmtDate(t.openTime)}</span>,
    },
  ];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="duration-bucket-title"
        className="flex max-h-[85vh] w-full max-w-5xl flex-col rounded-ui-xl border border-border bg-card shadow-3"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h3 id="duration-bucket-title" className="text-[15px] font-semibold text-foreground">
              Trades en rango {bucket.label}
            </h3>
            <p className="text-[12.5px] text-text-3">
              {bucket.count} {bucket.count === 1 ? 'trade' : 'trades'} · Profit total:{' '}
              <Profit value={bucket.profitTotal} />
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className={ROW_ACTION_CLASS}>
            <X className="size-5" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <FinTable<Trade>
            caption={`Trades en rango ${bucket.label}`}
            columns={columns}
            rows={bucket.trades}
            rowKey={(t) => String(t.index)}
          />
        </div>
      </div>
    </div>
  );
}
