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

import { useMemo, useState } from 'react';
import { CheckCircle, XCircle, HelpCircle, ChevronDown, Clock, ExternalLink, FileDown, Globe } from 'lucide-react';
import { Card, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { cn, formatNumber } from '@/lib/utils';
import { formatDateTime } from '@/lib/dates';
import { withActiveCompany } from '@/lib/api-fetch';
import { generatePropfirmReviewPDF } from '@/lib/pdf-export';

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
    // ── Añadidos después: las filas revisadas ANTES no los traen ──────────
    // Van opcionales a propósito. El espejo se revisa solo cada 30 minutos,
    // así que durante media hora conviven filas con y sin estos campos, y
    // declararlos obligatorios rompería la pantalla justo con las viejas.
    /** `mt5_users.LastIP` de la cuenta. Es un DATO, no entra en el veredicto. */
    ip?: string | null;
    /** Otras cuentas REALES que comparten esa IP. */
    sharedIpTotal?: number;
    sharedIpAccounts?: Array<{ login: number; name: string }>;
    /** Grupo grande (>10): VPN u operadora, no dice nada de nadie. */
    sharedIpMassive?: boolean;
    /** Fecha del informe oficial de Orion, si esa cuenta tiene uno. */
    orionReportAt?: string | null;
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

/** Marca de la empresa para el PDF que se le manda al cliente. */
export interface QueueBrand { name: string; logoUrl: string | null }

function Fila({ r, marca }: { r: QueueRow; marca: QueueBrand }) {
  const [abierto, setAbierto] = useState(false);
  const [bajando, setBajando] = useState(false);
  const f = r.review_facts;
  // El enlace se abre en pestaña nueva, no con apiFetch: hay que arrastrar el
  // scope de empresa a mano (apiFetch lo hace solo, un <a> no).
  const urlInforme = (source?: 'orion') =>
    withActiveCompany(
      `/api/admin/propfirm-queue/statement?login=${r.login ?? ''}&withdrawId=${encodeURIComponent(r.withdraw_id)}` +
      (source ? `&source=${source}` : ''),
    );
  const v = r.review_outcome ? VEREDICTO[r.review_outcome] : null;
  const checks = r.review_checks ?? [];
  const cumple = checks.filter((c) => c.status === 'pass').length;
  const incumple = checks.filter((c) => c.status === 'fail').length;
  const sinMirar = checks.filter((c) => c.status === 'unverifiable').length;

  return (
    <div className="border-b border-border last:border-0">
      {/* El enlace al informe vive FUERA del botón que despliega: un <a>
          dentro de un <button> es HTML inválido y el clic se lo come el
          botón, así que el informe no se abriría nunca. */}
      <div className="flex items-center gap-2 pr-4 hover:bg-muted/50">
      <button
        type="button"
        onClick={() => setAbierto((x) => !x)}
        className="flex flex-1 flex-wrap items-center gap-3 px-4 py-3 text-left"
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
        {r.login !== null && (
          <a
            href={urlInforme()}
            target="_blank"
            rel="noopener noreferrer"
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
            title="Todas las operaciones del ciclo, como el informe que descarga MetaQuotes"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            Abrir informe de la cuenta
          </a>
        )}
      </div>

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

          {/* ── LA IP: UN DATO, NO UNA REGLA ────────────────────────────
              No entra en el veredicto y la pantalla tiene que decirlo. Medido
              el 2026-08-27 hay una IP con 164 cuentas: es una VPN o el CGNAT
              de una operadora, no 164 personas copiándose. Por eso, cuando el
              grupo es grande se dice eso EN VEZ de listar las cuentas —
              listarlas se leería como una acusación. */}
          {f && f.ip !== undefined && (
            <div className="rounded-lg border border-border bg-card p-3 text-xs">
              <p className="flex items-center gap-1.5 font-medium">
                <Globe className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                Última IP de la cuenta: <span className="tabular-nums">{f.ip ?? 'sin registro'}</span>
              </p>
              {f.ip && (
                (f.sharedIpTotal ?? 0) === 0 ? (
                  <p className="mt-1 text-muted-foreground">Ninguna otra cuenta real usa esa IP.</p>
                ) : f.sharedIpMassive ? (
                  <p className="mt-1 text-muted-foreground">
                    IP compartida masivamente: {f.sharedIpTotal} cuentas reales más — probable VPN u operadora,
                    no evidencia de nada.
                  </p>
                ) : (
                  <div className="mt-1 text-muted-foreground">
                    <p>Comparte IP con {f.sharedIpTotal} cuenta(s) real(es):</p>
                    <ul className="mt-1 space-y-0.5">
                      {(f.sharedIpAccounts ?? []).map((c) => (
                        <li key={c.login} className="tabular-nums">#{c.login} · {c.name}</li>
                      ))}
                    </ul>
                  </div>
                )
              )}
              <p className="mt-1 italic text-muted-foreground">
                Es un dato para mirar, no una regla: no cambia el veredicto. La evidencia de copiar son las
                operaciones sincronizadas, que sí se revisan arriba.
              </p>
            </div>
          )}

          {/* Acciones del revisor: el informe de la cuenta y la prueba para el
              cliente. El PDF va en inglés por pedido explícito — su lector es
              el trader, no quien revisa. */}
          <div className="flex flex-wrap gap-2">
            {r.login !== null && (
              <a
                href={urlInforme()}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                Abrir informe de la cuenta
              </a>
            )}
            {f?.orionReportAt && (
              <a
                href={urlInforme('orion')}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted"
                title="El informe que generó el CRM cuando la cuenta se descalificó por pérdida"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                Informe del CRM ({f.orionReportAt.slice(0, 10)})
              </a>
            )}
            <button
              type="button"
              disabled={bajando}
              onClick={async () => {
                setBajando(true);
                try {
                  await generatePropfirmReviewPDF({
                    company: { name: marca.name, logoUrl: marca.logoUrl },
                    withdrawal: {
                      client: r.username ?? `#${r.login}`,
                      email: r.user_email,
                      account: r.login,
                      program: r.program_name,
                      amount: r.requested_amount ?? 0,
                      requestedAt: r.requested_date,
                      status: r.status,
                    },
                    cycle: r.review_cycle,
                    outcome: r.review_outcome,
                    checks: checks.map((c) => ({
                      label: c.label, status: c.status, detail: c.detail, whyNot: c.whyNot,
                    })),
                    facts: f ?? null,
                    reviewedAt: r.reviewed_at,
                  });
                } finally {
                  setBajando(false);
                }
              }}
              className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-60"
            >
              <FileDown className="h-3.5 w-3.5" aria-hidden />
              {bajando ? 'Generando…' : 'Download review (PDF)'}
            </button>
          </div>

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

/**
 * El estado FINAL con el que quedó el retiro en el CRM, en castellano.
 *
 * El mapa es una traducción, no un registro cerrado: si Orion agrega un estado
 * nuevo, el botón sale igual con el código crudo. Un estado que no figure acá
 * no puede desaparecer del filtro — se llevaría sus retiros con él y la
 * pestaña volvería a mentir por omisión.
 */
const ESTADO_FINAL: Record<string, string> = {
  APPROVED: 'Aprobados',
  REJECTED: 'Rechazados',
  CANCELED: 'Cancelados',
  CANCELLED: 'Cancelados',
};

export function PropfirmQueuePanel({
  pending,
  resolved,
  disclaimer,
  company,
}: {
  pending: QueueRow[];
  resolved: QueueRow[];
  disclaimer: string;
  /** Marca de la empresa para el PDF que se le manda al cliente. */
  company: QueueBrand;
}) {
  const [verHistorial, setVerHistorial] = useState(false);
  // ── EL FILTRO POR ESTADO FINAL (pedido de Kevin, 2026-08-27) ────────────
  // Cuando el CRM cambia el estado de un retiro, el espejo lo trae en la
  // corrida siguiente y la fila deja de ser «pendiente»: pasa a Historial
  // sola. Lo que faltaba era poder preguntarle al historial CÓMO terminó cada
  // uno — «en qué estado quedó» —, que es lo que hacen estos botones.
  const [estado, setEstado] = useState<string | null>(null);

  // Los estados se sacan de los datos, no de una lista fija: si mañana Orion
  // devuelve uno nuevo aparece su botón, en vez de esconder esos retiros.
  const estados = useMemo(() => {
    const n = new Map<string, number>();
    for (const r of resolved) {
      const k = r.status ?? '—';
      n.set(k, (n.get(k) ?? 0) + 1);
    }
    return [...n.entries()].sort((a, b) => b[1] - a[1]);
  }, [resolved]);

  const filas = verHistorial
    ? (estado ? resolved.filter((r) => (r.status ?? '—') === estado) : resolved)
    : pending;

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
                onClick={() => { setVerHistorial(valor); setEstado(null); }}
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

        {verHistorial && estados.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Estado final:</span>
            {([[null, 'Todos', resolved.length] as const] as Array<readonly [string | null, string, number]>)
              .concat(estados.map(([k, n]) => [k, ESTADO_FINAL[k] ?? k, n] as const))
              .map(([valor, texto, n]) => (
                <button
                  key={valor ?? 'todos'}
                  type="button"
                  onClick={() => setEstado(valor)}
                  aria-pressed={estado === valor}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                    estado === valor
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white'
                      : 'border-border hover:bg-muted',
                  )}
                >
                  {texto} <span className="ml-1 tabular-nums opacity-70">{n}</span>
                </button>
              ))}
          </div>
        )}
      </div>

      <div className="mt-3 border-t border-border">
        {filas.length === 0 ? (
          <EmptyState
            compact
            icon={Clock}
            title={verHistorial ? 'Sin retiros cerrados' : 'No hay retiros pendientes'}
            description={
              verHistorial
                ? estado
                  ? 'Ningún retiro quedó en ese estado dentro de la ventana espejada.'
                  : 'Ninguno cambió de estado en la ventana espejada.'
                : 'Cuando llegue una solicitud, se revisa sola contra el reglamento de su programa.'
            }
          />
        ) : (
          filas.map((r) => <Fila key={r.withdraw_id} r={r} marca={company} />)
        )}
      </div>
    </Card>
  );
}
