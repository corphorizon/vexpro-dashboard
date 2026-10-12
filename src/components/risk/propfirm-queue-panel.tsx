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
//
// ── «LIBRO MAYOR» (2026-10-12) ──────────────────────────────────────────────
// Sólo presentación; el veredicto, los checks y el PDF para el cliente son los
// mismos.
//   · Panel + FinTable (36 px) en vez de filas-acordeón: cliente con programa
//     y cuenta como meta, monto con <Money> (antes `$${formatNumber(x ?? 0)}`
//     armado a mano: un monto null se leía «$0.00»), veredicto con
//     StatusBadge desde risk-kinds.ts (`outcomeKind`), conteo de checks.
//   · Al tocar una fila se abre su detalle DEBAJO de la tabla (fila
//     seleccionada con la barra de 3 px): los checks son una lista con
//     StatusBadge ok / bad / pend — «sin comprobar» en `pend`, nunca verde.
//   · Pendientes / Historial con <Segmented> y el estado final con <Chip>s
//     (antes botones `bg-[var(--color-primary)] text-white`: un relleno de
//     marca por filtro).
//   · El PDF de revisión (`generatePropfirmReviewPDF`) es el mismo, con los
//     mismos datos; sólo se carga con `await import()` al pedirlo: antes el
//     import era estático y jsPDF viajaba en el bundle de la pantalla.
//
// DESCARTADO: acordeón dentro de FinTable (fila expandible). FinTable no
// tiene filas de detalle y agregarlo es tocar `ui/` (fuera de esta tanda);
// el detalle debajo con la fila marcada se lee igual y deja la tabla densa.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';
import { Clock, ExternalLink, FileDown, Globe, X } from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { NUM_CLASS } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { Notice } from '@/components/ui/notice';
import { Segmented } from '@/components/ui/segmented';
import { Chip } from '@/components/ui/chip';
import { EmptyState } from '@/components/ui/empty-state';
import { ActionButton, ROW_ACTION_CLASS, actionButtonClass } from '@/components/payment-orders/action-button';
import { MONEY_LOCALE, formatMoney } from '@/lib/money';
import { cn, formatNumber } from '@/lib/utils';
import { formatDateTime } from '@/lib/dates';
import { withActiveCompany } from '@/lib/api-fetch';
import { checkKind, outcomeKind } from './risk-kinds';
import { checkTally, finalStatusCounts, filterByFinalStatus } from './propfirm-view';

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

/** Lo que el REGLAMENTO dice, no lo que alguien decidió. El color, en risk-kinds.ts. */
const VEREDICTO: Record<string, string> = {
  ok: 'Sin incumplimientos',
  denied_new_period: 'Denegado, con período nuevo',
  denied_no_new_period: 'Denegado, sin período nuevo',
  cannot_review: 'No se pudo revisar',
};

/** Marca de la empresa para el PDF que se le manda al cliente. */
export interface QueueBrand { name: string; logoUrl: string | null }

/**
 * El estado FINAL con el que quedó el retiro en el CRM, en castellano.
 *
 * El mapa es una traducción, no un registro cerrado: si Orion agrega un estado
 * nuevo, el chip sale igual con el código crudo. Un estado que no figure acá
 * no puede desaparecer del filtro — se llevaría sus retiros con él y la
 * pestaña volvería a mentir por omisión.
 */
const ESTADO_FINAL: Record<string, string> = {
  APPROVED: 'Aprobados',
  REJECTED: 'Rechazados',
  CANCELED: 'Cancelados',
  CANCELLED: 'Cancelados',
};

const countFmt = new Intl.NumberFormat(MONEY_LOCALE, { maximumFractionDigits: 0 });

const urlInforme = (r: QueueRow, source?: 'orion') =>
  // El enlace se abre en pestaña nueva, no con apiFetch: hay que arrastrar el
  // scope de empresa a mano (apiFetch lo hace solo, un <a> no).
  withActiveCompany(
    `/api/admin/propfirm-queue/statement?login=${r.login ?? ''}&withdrawId=${encodeURIComponent(r.withdraw_id)}` +
      (source ? `&source=${source}` : ''),
  );

/** «3 cumple · 1 incumple · 2 sin comprobar» — los tres SIEMPRE juntos. */
function CheckSummary({ checks }: { checks: QueueCheck[] }) {
  const n = checkTally(checks);
  return (
    <span className={cn(NUM_CLASS, 'text-[12.5px] text-text-2')}>
      {n.pass} cumple ·{' '}
      <span className={cn(n.fail > 0 && 'font-semibold text-neg')}>{n.fail} incumple</span>
      {n.unverifiable > 0 && (
        <>
          {' · '}
          <span className="font-medium text-pend">{n.unverifiable} sin comprobar</span>
        </>
      )}
    </span>
  );
}

function Detalle({ r, marca, onClose }: { r: QueueRow; marca: QueueBrand; onClose: () => void }) {
  const [bajando, setBajando] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const f = r.review_facts;
  const checks = r.review_checks ?? [];

  const bajarPdf = async () => {
    setBajando(true);
    setPdfError(null);
    try {
      // On-demand: jsPDF sólo baja cuando alguien pide la prueba.
      const { generatePropfirmReviewPDF } = await import('@/lib/pdf-export');
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
    } catch (err) {
      // Antes un fallo acá se tragaba en silencio (try/finally sin catch).
      setPdfError(err instanceof Error ? err.message : 'No se pudo generar el PDF');
    } finally {
      setBajando(false);
    }
  };

  return (
    <section
      aria-label={`Detalle de ${r.username ?? `#${r.login}`}`}
      className="space-y-4 border-t border-border bg-surface-2 px-4 py-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-foreground">{r.username ?? `#${r.login}`}</p>
          <p className="text-[12.5px] text-text-3">
            {r.program_name ?? '—'} · cuenta <span className="font-mono">{r.login ?? '—'}</span>
            {r.reviewed_at ? ` · revisado ${formatDateTime(r.reviewed_at)}` : ''}
          </p>
        </div>
        <button type="button" onClick={onClose} className={ROW_ACTION_CLASS} aria-label="Cerrar detalle">
          <X className="size-4" aria-hidden />
        </button>
      </div>

      {r.review_error && (
        <Notice kind="bad" title="No se pudo revisar">
          {r.review_error}
        </Notice>
      )}

      {r.review_cycle && (
        <p className="text-[12.5px] text-text-2">
          Ciclo desde{' '}
          <span className={NUM_CLASS}>{r.review_cycle.startedAt ? r.review_cycle.startedAt.slice(0, 10) : '—'}</span>
          {r.review_cycle.startedBy === 'retiro_pagado' ? ' (por un retiro pagado)' : ' (creación de la cuenta)'}
          {r.review_cycle.excludedTrades > 0 && (
            <> · {r.review_cycle.excludedTrades} operaciones de ciclos anteriores quedaron fuera</>
          )}
        </p>
      )}

      {/* Los checks: lista con severidad. «Sin comprobar» va en `pend`. */}
      {checks.length > 0 && (
        <div className="rounded-ui-md border border-border bg-card">
          <p className="border-b border-border px-3 py-2 text-[11.5px] font-semibold uppercase tracking-[.03em] text-text-3">
            Reglas del programa · <CheckSummary checks={checks} />
          </p>
          <ul className="divide-y divide-border">
            {checks.map((c) => (
              <li key={c.id} className="flex items-start gap-3 px-3 py-2.5">
                <StatusBadge
                  kind={checkKind(c.status)}
                  label={c.status === 'pass' ? 'Cumple' : c.status === 'fail' ? 'Incumple' : 'Sin comprobar'}
                  className="mt-px w-[112px] shrink-0 justify-start"
                />
                <div className="min-w-0">
                  <p className={cn('text-[13px] font-medium', c.status === 'fail' ? 'text-neg' : 'text-foreground')}>
                    {c.label}
                  </p>
                  <p className="text-[12.5px] text-text-2">{c.detail}</p>
                  {c.whyNot && <p className="text-[12.5px] italic text-text-3">{c.whyNot}</p>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {f && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-ui-md border border-border bg-card p-3">
            <p className="text-[12px] font-medium text-text-3">Caída máxima del ciclo</p>
            <p className={cn(NUM_CLASS, 'text-[18px] font-semibold text-foreground')}>
              {formatNumber(f.maxDrawdown)}
              {f.maxDrawdownPct !== null && (
                <span className="ml-2 text-[13px] font-normal text-text-2">
                  {f.maxDrawdownPct}% de {f.accountSize !== null ? formatMoney(f.accountSize) : '—'}
                </span>
              )}
            </p>
            {/* La diferencia con el CRM no es un error y hay que decirlo. */}
            <p className="mt-1 text-[12.5px] text-text-3">
              Medida sobre operaciones cerradas. El CRM la mide sobre equity e incluye lo flotante, así que la suya
              será igual o mayor — y es la que descalifica.
            </p>
          </div>
          <div className="rounded-ui-md border border-border bg-card p-3">
            <p className="text-[12px] font-medium text-text-3">Duración de las operaciones</p>
            <dl className="mt-2 space-y-1">
              {f.durations.map((d) => (
                <div key={d.label} className="flex justify-between text-[12.5px]">
                  <dt className="text-text-2">{d.label}</dt>
                  <dd className={NUM_CLASS}>{countFmt.format(d.count)}</dd>
                </div>
              ))}
            </dl>
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
        <div className="rounded-ui-md border border-border bg-card p-3 text-[12.5px]">
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            <Globe className="size-3.5 text-text-3" aria-hidden />
            Última IP de la cuenta: <span className="font-mono">{f.ip ?? 'sin registro'}</span>
          </p>
          {f.ip &&
            ((f.sharedIpTotal ?? 0) === 0 ? (
              <p className="mt-1 text-text-2">Ninguna otra cuenta real usa esa IP.</p>
            ) : f.sharedIpMassive ? (
              <p className="mt-1 text-text-2">
                IP compartida masivamente: {f.sharedIpTotal} cuentas reales más — probable VPN u operadora, no
                evidencia de nada.
              </p>
            ) : (
              <div className="mt-1 text-text-2">
                <p>Comparte IP con {f.sharedIpTotal} cuenta(s) real(es):</p>
                <ul className="mt-1 space-y-0.5">
                  {(f.sharedIpAccounts ?? []).map((c) => (
                    <li key={c.login}>
                      <span className="font-mono">#{c.login}</span> · {c.name}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          <p className="mt-1 italic text-text-3">
            Es un dato para mirar, no una regla: no cambia el veredicto. La evidencia de copiar son las operaciones
            sincronizadas, que sí se revisan arriba.
          </p>
        </div>
      )}

      {/* Acciones del revisor: el informe de la cuenta y la prueba para el
          cliente. El PDF va en inglés por pedido explícito — su lector es
          el trader, no quien revisa. */}
      <div className="flex flex-wrap gap-2">
        {r.login !== null && (
          <a href={urlInforme(r)} target="_blank" rel="noopener noreferrer" className={actionButtonClass('secondary')}>
            <ExternalLink className="size-4" aria-hidden />
            Abrir informe de la cuenta
          </a>
        )}
        {f?.orionReportAt && (
          <a
            href={urlInforme(r, 'orion')}
            target="_blank"
            rel="noopener noreferrer"
            className={actionButtonClass('secondary')}
            title="El informe que generó el CRM cuando la cuenta se descalificó por pérdida"
          >
            <ExternalLink className="size-4" aria-hidden />
            Informe del CRM ({f.orionReportAt.slice(0, 10)})
          </a>
        )}
        <ActionButton loading={bajando} onClick={() => void bajarPdf()}>
          {!bajando && <FileDown className="size-4" aria-hidden />}
          {bajando ? 'Generando…' : 'Download review (PDF)'}
        </ActionButton>
      </div>
      {pdfError && <p className="text-[12.5px] text-neg">{pdfError}</p>}
    </section>
  );
}

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
  const [vista, setVista] = useState<'pending' | 'history'>('pending');
  // ── EL FILTRO POR ESTADO FINAL (pedido de Kevin, 2026-08-27) ────────────
  // Cuando el CRM cambia el estado de un retiro, el espejo lo trae en la
  // corrida siguiente y la fila deja de ser «pendiente»: pasa a Historial
  // sola. Lo que faltaba era poder preguntarle al historial CÓMO terminó cada
  // uno — «en qué estado quedó» —, que es lo que hacen estos chips.
  const [estado, setEstado] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);

  // Los estados se sacan de los datos, no de una lista fija: si mañana Orion
  // devuelve uno nuevo aparece su chip, en vez de esconder esos retiros.
  const estados = useMemo(() => finalStatusCounts(resolved), [resolved]);

  const verHistorial = vista === 'history';
  const filas = verHistorial ? filterByFinalStatus(resolved, estado) : pending;
  const seleccionada = abierto ? filas.find((r) => r.withdraw_id === abierto) ?? null : null;

  const columns: FinColumn<QueueRow>[] = [
    {
      key: 'client',
      header: 'Cliente',
      cell: (r) => r.username ?? `#${r.login}`,
      meta: (r) => `${r.program_name ?? '—'} · cuenta ${r.login ?? '—'}`,
      mobileMeta: (r) => (
        <StatusBadge kind={outcomeKind(r.review_outcome)} label={r.review_outcome ? VEREDICTO[r.review_outcome] ?? r.review_outcome : 'Sin revisar'} />
      ),
    },
    {
      key: 'amount',
      header: 'Monto',
      kind: 'money',
      value: (r) => r.requested_amount,
    },
    {
      key: 'requested',
      header: 'Solicitado',
      hideSm: true,
      cell: (r) => (
        <span className={cn(NUM_CLASS, 'text-[12.5px] text-text-2')}>
          {r.requested_date ? formatDateTime(r.requested_date) : '—'}
        </span>
      ),
    },
    {
      key: 'verdict',
      header: 'Veredicto del reglamento',
      hideSm: true,
      cell: (r) => (
        <StatusBadge
          kind={outcomeKind(r.review_outcome)}
          label={r.review_outcome ? VEREDICTO[r.review_outcome] ?? r.review_outcome : 'Sin revisar'}
        />
      ),
    },
    {
      key: 'checks',
      header: 'Reglas',
      hideSm: true,
      // Los tres números SIEMPRE juntos: reducirlos a uno escondería
      // justamente el que importa.
      cell: (r) => <CheckSummary checks={r.review_checks ?? []} />,
    },
    ...(verHistorial
      ? [
          {
            key: 'crm',
            header: 'Estado en el CRM',
            hideSm: true,
            cell: (r: QueueRow) => <span className="text-[12.5px] text-text-2">{r.status ?? '—'}</span>,
          } satisfies FinColumn<QueueRow>,
        ]
      : []),
  ];

  return (
    <Panel
      title="Retiros de prop firm"
      hint={disclaimer}
      flush
      actions={
        <Segmented<'pending' | 'history'>
          aria-label="Retiros de prop firm"
          value={vista}
          onChange={(v) => {
            setVista(v);
            setEstado(null);
            setAbierto(null);
          }}
          options={[
            { value: 'pending', label: 'Pendientes', count: pending.length },
            { value: 'history', label: 'Historial', count: resolved.length },
          ]}
        />
      }
    >
      {verHistorial && estados.length > 0 && (
        <div role="group" aria-label="Estado final" className="flex flex-wrap items-center gap-2 px-4 py-3">
          <span className="text-[12px] font-medium text-text-3">Estado final</span>
          <Chip active={estado === null} onClick={() => setEstado(null)} count={resolved.length}>
            Todos
          </Chip>
          {estados.map(({ status, count }) => (
            <Chip
              key={status}
              active={estado === status}
              onClick={() => {
                setEstado(estado === status ? null : status);
                setAbierto(null);
              }}
              count={count}
            >
              {ESTADO_FINAL[status] ?? status}
            </Chip>
          ))}
        </div>
      )}

      <FinTable<QueueRow>
        caption="Retiros de prop firm"
        columns={columns}
        rows={filas}
        rowKey={(r) => r.withdraw_id}
        selectedKey={seleccionada?.withdraw_id ?? null}
        onRowClick={(r) => setAbierto(abierto === r.withdraw_id ? null : r.withdraw_id)}
        rowActions={(r) =>
          r.login !== null ? (
            <a
              href={urlInforme(r)}
              target="_blank"
              rel="noopener noreferrer"
              className={ROW_ACTION_CLASS}
              aria-label="Abrir informe de la cuenta"
              title="Todas las operaciones del ciclo, como el informe que descarga MetaQuotes"
            >
              <ExternalLink className="size-4" aria-hidden />
            </a>
          ) : null
        }
        maxHeight="60vh"
        empty={
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
        }
      />

      {seleccionada && <Detalle r={seleccionada} marca={company} onClose={() => setAbierto(null)} />}
    </Panel>
  );
}
