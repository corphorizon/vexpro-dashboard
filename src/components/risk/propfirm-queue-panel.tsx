'use client';

// ─────────────────────────────────────────────────────────────────────────────
// La cola de retiros de prop firm, ya revisada.
//
// ── LO QUE ESTA PANTALLA TIENE QUE DEJAR CLARO ─────────────────────────────
// 1. El veredicto NO es una decisión. Dice lo que el reglamento establece para
//    ese número de violaciones; aprobar o rechazar se sigue firmando en el CRM.
// 2. Una regla «sin comprobar» NO está cumplida. Está sin mirar. Pintarla en
//    verde junto a las demás afirmaría un cumplimiento que nadie verificó, que
//    es peor que no mostrarla.
//
// Por eso el resumen separa siempre los tres números —cumple, incumple, sin
// comprobar— en vez de reducirlos a un semáforo.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { CheckCircle, XCircle, HelpCircle, ChevronDown, Clock } from 'lucide-react';
import { Card, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { cn, formatNumber } from '@/lib/utils';
import { formatDateTime } from '@/lib/dates';

export interface QueueCheck {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'unverifiable';
  detail: string;
  offendingTrades: number;
  whyNot?: string;
}

export interface QueueRow {
  withdraw_id: string;
  login: number | null;
  username: string | null;
  user_email: string | null;
  program_name: string | null;
  requested_amount: number | null;
  requested_date: string | null;
  status: string | null;
  reviewed_at: string | null;
  review_outcome: string | null;
  review_violations: number | null;
  review_unverifiable: number | null;
  review_checks: QueueCheck[] | null;
  review_facts: {
    maxDrawdown: number;
    maxDrawdownPct: number | null;
    accountSize: number | null;
    netResult: number;
    durations: Array<{ label: string; count: number; profit: number }>;
  } | null;
  review_cycle: { startedAt: string | null; startedBy: string; excludedTrades: number } | null;
  review_error: string | null;
}

/** Lo que el REGLAMENTO dice, no lo que alguien decidió. */
const VEREDICTO: Record<string, { texto: string; variant: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  ok: { texto: 'Sin incumplimientos', variant: 'success' },
  denied_new_period: { texto: 'Denegado, con período nuevo', variant: 'warning' },
  denied_no_new_period: { texto: 'Denegado, sin período nuevo', variant: 'danger' },
  cannot_review: { texto: 'No se pudo revisar', variant: 'neutral' },
};

function Fila({ r }: { r: QueueRow }) {
  const [abierto, setAbierto] = useState(false);
  const v = r.review_outcome ? VEREDICTO[r.review_outcome] : null;
  const checks = r.review_checks ?? [];
  const cumple = checks.filter((c) => c.status === 'pass').length;
  const incumple = checks.filter((c) => c.status === 'fail').length;
  const sinMirar = checks.filter((c) => c.status === 'unverifiable').length;

  return (
    <div className="border-b border-border last:border-0">
      <button
        type="button"
        onClick={() => setAbierto((x) => !x)}
        className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{r.username ?? `#${r.login}`}</p>
          <p className="truncate text-xs text-muted-foreground">
            {r.program_name} · cuenta {r.login} · {r.requested_date ? formatDateTime(r.requested_date) : '—'}
          </p>
        </div>
        <span className="font-semibold tabular-nums">
          ${formatNumber(r.requested_amount ?? 0)}
        </span>
        {v ? <Badge variant={v.variant}>{v.texto}</Badge> : <Badge variant="neutral">Sin revisar</Badge>}
        {/* Los tres números SIEMPRE juntos: reducirlos a uno escondería
            justamente el que importa. */}
        <span className="text-xs tabular-nums text-muted-foreground">
          {cumple} cumple · <span className={cn(incumple > 0 && 'font-semibold text-negative')}>{incumple} incumple</span>
          {sinMirar > 0 && <> · <span className="text-warning">{sinMirar} sin comprobar</span></>}
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', abierto && 'rotate-180')} aria-hidden />
      </button>

      {abierto && (
        <div className="space-y-4 bg-muted/30 px-4 py-4">
          {r.review_error && (
            <p className="rounded-lg bg-negative/10 px-3 py-2 text-xs text-negative">
              No se pudo revisar: {r.review_error}
            </p>
          )}

          {r.review_cycle && (
            <p className="text-xs text-muted-foreground">
              Ciclo desde{' '}
              {r.review_cycle.startedAt ? r.review_cycle.startedAt.slice(0, 10) : '—'}
              {r.review_cycle.startedBy === 'retiro_pagado' ? ' (por un retiro pagado)' : ' (creación de la cuenta)'}
              {r.review_cycle.excludedTrades > 0 && (
                <> · {r.review_cycle.excludedTrades} operaciones de ciclos anteriores quedaron fuera</>
              )}
            </p>
          )}

          {r.review_facts && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border bg-card p-3">
                <p className="text-xs text-muted-foreground">Caída máxima del ciclo</p>
                <p className="text-lg font-semibold tabular-nums">
                  {formatNumber(r.review_facts.maxDrawdown)}
                  {r.review_facts.maxDrawdownPct !== null && (
                    <span className="ml-2 text-sm font-normal text-muted-foreground">
                      {r.review_facts.maxDrawdownPct}% de ${formatNumber(r.review_facts.accountSize ?? 0)}
                    </span>
                  )}
                </p>
                {/* La diferencia con el CRM no es un error y hay que decirlo. */}
                <p className="mt-1 text-xs text-muted-foreground">
                  Medida sobre operaciones cerradas. El CRM la mide sobre equity e incluye lo flotante,
                  así que la suya será igual o mayor — y es la que descalifica.
                </p>
              </div>
              <div className="rounded-lg border border-border bg-card p-3">
                <p className="text-xs text-muted-foreground">Duración de las operaciones</p>
                <div className="mt-2 space-y-1">
                  {r.review_facts.durations.map((d) => (
                    <div key={d.label} className="flex justify-between text-xs">
                      <span className="text-muted-foreground">{d.label}</span>
                      <span className="tabular-nums">{d.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="space-y-2">
            {checks.map((c) => (
              <div key={c.id} className="flex items-start gap-2 text-sm">
                {c.status === 'pass' && <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-positive" aria-hidden />}
                {c.status === 'fail' && <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-negative" aria-hidden />}
                {/* Interrogación y no tilde: no se comprobó, no es que cumpla. */}
                {c.status === 'unverifiable' && <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />}
                <div className="min-w-0">
                  <p className={cn('font-medium', c.status === 'fail' && 'text-negative')}>{c.label}</p>
                  <p className="text-xs text-muted-foreground">{c.detail}</p>
                  {c.whyNot && <p className="text-xs italic text-muted-foreground">{c.whyNot}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function PropfirmQueuePanel({
  pending,
  resolved,
  disclaimer,
}: {
  pending: QueueRow[];
  resolved: QueueRow[];
  disclaimer: string;
}) {
  const [verHistorial, setVerHistorial] = useState(false);
  const filas = verHistorial ? resolved : pending;

  return (
    <Card className="overflow-hidden p-0">
      <div className="px-4 pt-4">
        <CardTitle>Retiros de prop firm</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">{disclaimer}</p>
        <div className="mt-3 flex gap-2">
          {([['Pendientes', false, pending.length], ['Historial', true, resolved.length]] as const).map(
            ([texto, valor, n]) => (
              <button
                key={texto}
                type="button"
                onClick={() => setVerHistorial(valor)}
                aria-pressed={verHistorial === valor}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                  verHistorial === valor
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white'
                    : 'border-border hover:bg-muted',
                )}
              >
                {texto} <span className="ml-1 tabular-nums opacity-70">{n}</span>
              </button>
            ),
          )}
        </div>
      </div>

      <div className="mt-3 border-t border-border">
        {filas.length === 0 ? (
          <EmptyState
            compact
            icon={Clock}
            title={verHistorial ? 'Sin retiros cerrados' : 'No hay retiros pendientes'}
            description={
              verHistorial
                ? 'Ninguno cambió de estado en la ventana espejada.'
                : 'Cuando llegue una solicitud, se revisa sola contra el reglamento de su programa.'
            }
          />
        ) : (
          filas.map((r) => <Fila key={r.withdraw_id} r={r} />)
        )}
      </div>
    </Card>
  );
}
