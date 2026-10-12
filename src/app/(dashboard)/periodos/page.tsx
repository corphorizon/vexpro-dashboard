'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /periodos — abrir, cerrar y reabrir los meses contables.
//
// Cerrar congela los INSUMOS de la cadena de distribución (migración 061,
// reglas-del-proyecto.md §2.3) y bloquea la edición del mes. Reabrir exige un
// motivo que queda en el Registro de Actividad.
//
// «Libro mayor» (2026-10-12, docs/diseno-libro-mayor.md):
//   · KpiStrip de conteos (Abiertos, En curso, Cerrados) en vez de tres Card
//     con íconos sobre fondos de color crudo.
//   · FinTable: Período (+ «cerrado por / cuándo» como meta en móvil), Estado
//     con StatusBadge — Abierto `pend`, En curso `info`, Cerrado neutro (antes
//     «Abierto» era verde, el color de «completado»; ver periods-view.ts) —,
//     Reserva %, Cerrado por, Cerrado el, y acciones de fila.
//   · La leyenda de estados (una Card aparte) pasa al pie del panel.
//   · Checklist de cierre como Panel con un ítem por chequeo y su kind
//     (ok/pend/bad): ahora se ven también los chequeos que dieron 0, así
//     «sin pendientes de X» no se confunde con «no se revisó X». Los avisos
//     de fallo y bloqueo son Notice; el motivo de reapertura, Field.
//   · Los textos de los diálogos estaban en castellano fijo: ahora i18n.
//
// Medición (colores fuera de tokens, sin contar comentarios): antes 23 clases
// de paleta cruda (`bg-slate-100`, `text-emerald-700`, `text-amber-600`,
// `text-white`… 9 de ellas bajo `dark:`), 7 `dark:` de color, 1
// `text-[10px]`, 1 `[var(--color-primary)]`, 31 tokens legados
// (`text-muted-foreground`, `bg-negative/10`, `bg-warning/10`…) y un SVG de
// ícono armado a mano; después 1: el scrim `bg-black/45` de los modales
// (spec §6.1, igual que /socios — no es un color con significado).
//
// DESCARTADO:
//   · Botón de cerrar en rojo (`bg-negative`): cerrar no es pérdida ni error
//     (spec §2.1); es el primario del diálogo.
//   · Ocultar las acciones de fila hasta el hover: FinTable ya lo hace en
//     escritorio y las deja siempre visibles en táctil.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Calendar, Check, Lock, Unlock, X } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { Notice } from '@/components/ui/notice';
import { Field, Textarea } from '@/components/ui/field';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { NUM_CLASS } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ActionButton, ROW_ACTION_CLASS } from '@/components/payment-orders/action-button';
import { useAuth, canEdit } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { updatePeriodStatus } from '@/lib/supabase/mutations';
import { useAutoClearMessage } from '@/lib/use-auto-clear-message';
import { formatDate } from '@/lib/dates';
import { cn } from '@/lib/utils';
import {
  PERIOD_STATUSES,
  PERIOD_STATUS_KIND,
  buildPeriodRows,
  checklistRows,
  checklistSummary,
  periodStatusCounts,
  type ChecklistApiItem,
  type ChecklistState,
  type PeriodRow,
  type PeriodStatus,
  type PeriodWithClose,
} from './periods-view';

const STATUS_LABEL_KEY: Record<PeriodStatus, string> = {
  closed: 'periods.closed',
  open: 'periods.open',
  in_progress: 'periods.inProgress',
};

const STATUS_DESC_KEY: Record<PeriodStatus, string> = {
  closed: 'periods.closedDesc',
  open: 'periods.openDesc',
  in_progress: 'periods.inProgressDesc',
};

/** Acción de fila con texto (Cerrar / Reabrir): mismo alto que el botón-ícono. */
const ROW_TEXT_ACTION =
  'inline-flex h-8 items-center gap-1.5 rounded-ui-md px-2.5 text-[12.5px] font-medium text-text-2 hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-50 [@media(pointer:coarse)]:h-10';

/** Cáscara de modal: scrim, ESC para cerrar, cabecera con título y «×». */
function Dialog({
  title,
  onClose,
  children,
  footer,
  labelledBy,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
  labelledBy: string;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-ui-xl border border-border bg-card shadow-3"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <h2 id={labelledBy} className="text-[15px] font-semibold text-foreground">
            {title}
          </h2>
          <button type="button" onClick={onClose} className={ROW_ACTION_CLASS} aria-label={t('periods.dialogCancel')}>
            <X aria-hidden className="size-4" strokeWidth={1.75} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
      </div>
    </div>
  );
}

export default function PeriodosPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { periods: dataPeriods, refresh, loading } = useData();
  const isAdmin = canEdit(user);
  // «En curso» depende del mes de hoy: se toma una vez al montar.
  const [now] = useState(() => new Date());

  const rows = useMemo(() => buildPeriodRows(dataPeriods as PeriodWithClose[], now), [dataPeriods, now]);
  const counts = useMemo(() => periodStatusCounts(rows), [rows]);

  const [successMsg, showSuccessRaw] = useAutoClearMessage(3000);
  const [errorMsg, showErrorRaw] = useAutoClearMessage(4500);
  const [updating, setUpdating] = useState<string | null>(null);

  // Mutuamente excluyentes: un éxito limpia el error y viceversa, para que la
  // pantalla nunca muestre los dos a la vez.
  const showSuccess = (msg: string) => { showErrorRaw(''); showSuccessRaw(msg); };
  const showError = (msg: string) => { showSuccessRaw(''); showErrorRaw(msg); };
  const errText = (err: unknown) =>
    t('periods.actionError', { error: err instanceof Error ? err.message : t('periods.unknownError') });

  const [closeTarget, setCloseTarget] = useState<{ id: string; label: string } | null>(null);
  const [checklist, setChecklist] = useState<ChecklistState | null>(null);
  const [closing, setClosing] = useState(false);

  /** Etiqueta traducida del ítem, con el respaldo del servidor si la clave
   *  todavía no está en i18n. Nunca se muestra la clave cruda. */
  const itemLabel = (i: Pick<ChecklistApiItem, 'labelKey' | 'label' | 'key'>) => {
    if (i.labelKey) {
      const translated = t(i.labelKey);
      if (translated !== i.labelKey) return translated;
    }
    return i.label ?? i.key;
  };

  const confirmClose = async () => {
    if (!closeTarget) return;
    setClosing(true);
    setUpdating(closeTarget.id);
    try {
      await updatePeriodStatus(closeTarget.id, true, undefined);
      await refresh();
      showSuccess(t('periods.statusChanged', { label: closeTarget.label, status: t(STATUS_LABEL_KEY.closed) }));
      setCloseTarget(null);
    } catch (err) {
      showError(errText(err));
    } finally {
      setClosing(false);
      setUpdating(null);
    }
  };

  const [reopenTarget, setReopenTarget] = useState<{ id: string; label: string } | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [reopening, setReopening] = useState(false);

  const confirmReopen = async () => {
    if (!reopenTarget || !reopenReason.trim()) return;
    setReopening(true);
    setUpdating(reopenTarget.id);
    try {
      await updatePeriodStatus(reopenTarget.id, false, reopenReason.trim());
      await refresh();
      showSuccess(t('periods.statusChanged', { label: reopenTarget.label, status: t(STATUS_LABEL_KEY.open) }));
      setReopenTarget(null);
    } catch (err) {
      showError(errText(err));
    } finally {
      setReopening(false);
      setUpdating(null);
    }
  };

  // Reabrir tiene su propio diálogo con campo de motivo. El window.prompt
  // anterior era nativo, sin estilo, sin i18n y algunos navegadores lo
  // bloquean en silencio — la reapertura se cancelaba sin explicación
  // (auditoría 2026-08-06, QW12).
  const openReopen = (row: PeriodRow) => {
    setReopenTarget({ id: row.id, label: row.label });
    setReopenReason('');
  };

  // Cerrar abre su propio diálogo con el CHECKLIST de pendientes (P1-4 del
  // benchmark, auditoría 2026-08-06). Son advertencias, salvo el orden
  // cronológico, que bloquea — cerrar con pendientes es legítimo, pero tiene
  // que ser una decisión informada, no un descuido.
  const openClose = (row: PeriodRow) => {
    setCloseTarget({ id: row.id, label: row.label });
    setChecklist(null);
    void apiFetch(`/api/admin/period-close-checklist?period_id=${row.id}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) {
          setChecklist({ items: json.items ?? [], clean: !!json.clean, blocked: !!json.blocked });
        } else setChecklist({ items: [], clean: true, failed: true });
      })
      // Si el checklist falla, se puede cerrar igual: es un asistente, no
      // una barrera nueva (el bloqueo real está en la RPC).
      .catch(() => setChecklist({ items: [], clean: true, failed: true }));
  };

  const checkRows = useMemo(() => checklistRows(checklist?.items ?? []), [checklist]);
  const checkSummary = checklistSummary(checkRows);

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const kpiItems: KpiItem[] = [
    {
      key: 'open',
      label: t('periods.open'),
      value: counts.open,
      format: 'count',
      hero: true,
      sub: t('periods.kpiOpenHint'),
    },
    { key: 'in_progress', label: t('periods.inProgress'), value: counts.in_progress, format: 'count' },
    { key: 'closed', label: t('periods.closed'), value: counts.closed, format: 'count' },
  ];

  // ── Columnas ──────────────────────────────────────────────────────────────
  const statusBadge = (r: PeriodRow) => (
    <StatusBadge kind={PERIOD_STATUS_KIND[r.status]} label={t(STATUS_LABEL_KEY[r.status])} />
  );
  const reserveText = (r: PeriodRow) => (r.reservePct === null ? '—' : `${r.reservePct} %`);
  const closedAtText = (r: PeriodRow) => (r.closedAt ? formatDate(r.closedAt) : '—');

  const columns: FinColumn<PeriodRow>[] = [
    {
      key: 'period',
      header: t('periods.colPeriod'),
      cell: (r) => r.label || '—',
      meta: (r) => `${r.year}-${String(r.month).padStart(2, '0')}`,
      mobileMeta: (r) => (
        <>
          {statusBadge(r)}
          {r.status === 'closed' && (
            <span>
              {t('periods.closedByOn', { by: r.closedBy ?? '—', on: closedAtText(r) })}
            </span>
          )}
        </>
      ),
    },
    { key: 'status', header: t('common.status'), hideSm: true, cell: statusBadge },
    {
      key: 'reserve',
      header: t('periods.colReserve'),
      kind: 'number',
      hideSm: true,
      cell: (r) => <span className={cn(NUM_CLASS, r.reservePct === null && 'text-text-3')}>{reserveText(r)}</span>,
    },
    {
      key: 'closedBy',
      header: t('periods.colClosedBy'),
      hideSm: true,
      cell: (r) => <span className={r.closedBy ? 'text-text-2' : 'text-text-3'}>{r.closedBy ?? '—'}</span>,
    },
    {
      key: 'closedAt',
      header: t('periods.colClosedAt'),
      hideSm: true,
      width: '112px',
      cell: (r) => <span className={cn(NUM_CLASS, r.closedAt ? 'text-text-2' : 'text-text-3')}>{closedAtText(r)}</span>,
    },
  ];

  // Las acciones se derivan SOLO del estado: con `is_closed` evaluado
  // primero, 'in_progress' ya significa exactamente "mes actual y abierto".
  const rowActions = isAdmin
    ? (r: PeriodRow) => {
        if (updating === r.id) return <span className="px-2.5 text-[12.5px] text-text-3">{t('periods.updating')}</span>;
        if (r.status === 'open') {
          return (
            <button type="button" className={ROW_TEXT_ACTION} onClick={() => openClose(r)}>
              <Lock aria-hidden className="size-3.5" strokeWidth={1.75} />
              {t('periods.close')}
            </button>
          );
        }
        if (r.status === 'closed') {
          return (
            <button type="button" className={ROW_TEXT_ACTION} onClick={() => openReopen(r)}>
              <Unlock aria-hidden className="size-3.5" strokeWidth={1.75} />
              {t('periods.reopen')}
            </button>
          );
        }
        return <span className="px-2.5 text-[12.5px] text-text-3">{t('periods.monthInProgress')}</span>;
      }
    : undefined;

  const legend = (
    <dl className="flex flex-wrap gap-x-5 gap-y-1.5">
      {PERIOD_STATUSES.map((s) => (
        <div key={s} className="flex items-center gap-1.5">
          <dt>
            <StatusBadge kind={PERIOD_STATUS_KIND[s]} label={t(STATUS_LABEL_KEY[s])} />
          </dt>
          <dd>{t(STATUS_DESC_KEY[s])}</dd>
        </div>
      ))}
    </dl>
  );

  const closeButtonLabel = closing
    ? t('periods.closing')
    : checklist?.blocked
      ? t('periods.cannotClose')
      : checklist && !checklist.failed && (!checklist.clean || checkSummary.bad + checkSummary.pend > 0)
        ? t('periods.closeAnyway')
        : t('periods.closePeriod');

  return (
    <div className="space-y-4">
      <PageHeader title={t('periods.title')} subtitle={t('periods.subtitle')} icon={Calendar} />

      {successMsg && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-ui-md border border-pos/35 bg-pos-bg px-3.5 py-2.5 text-[13px] font-medium text-foreground"
        >
          <Check aria-hidden className="size-4 shrink-0 text-pos" strokeWidth={2} />
          {successMsg}
        </div>
      )}
      {errorMsg && <Notice kind="bad" title={errorMsg} />}

      {loading && rows.length === 0 ? (
        <div className="space-y-4" aria-busy="true">
          <Skeleton className="h-[92px]" />
          <Skeleton className="h-72" />
        </div>
      ) : (
        <>
          <KpiStrip items={kpiItems} />

          <Panel
            flush
            title={t('periods.title')}
            hint={t('periods.listHint', { count: String(rows.length) })}
            footer={legend}
          >
            <FinTable
              caption={t('periods.title')}
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              rowActions={rowActions}
              maxHeight="70vh"
              empty={t('periods.empty')}
            />
          </Panel>
        </>
      )}

      {/* Diálogo de CIERRE con checklist de pendientes. */}
      {closeTarget && (
        <Dialog
          labelledBy="period-close-title"
          title={t('periods.closeTitle', { label: closeTarget.label })}
          onClose={() => !closing && setCloseTarget(null)}
          footer={
            <>
              <ActionButton onClick={() => setCloseTarget(null)} disabled={closing}>
                {t('periods.dialogCancel')}
              </ActionButton>
              <ActionButton
                variant="primary"
                onClick={confirmClose}
                loading={closing}
                // Con un bloqueante, el botón se apaga: la RPC lo rechazaría
                // igual y "Cerrar de todos modos" prometería algo que no pasa.
                disabled={!checklist || !!checklist.blocked}
                title={checklist?.blocked ? t('periods.blockedHint') : undefined}
              >
                {closeButtonLabel}
              </ActionButton>
            </>
          }
        >
          <p className="text-[13px] text-text-2">{t('periods.closeIntro')}</p>

          {!checklist && (
            <div className="space-y-2" aria-busy="true">
              <p className="text-[13px] text-text-3">{t('periods.checking')}</p>
              <Skeleton className="h-24" />
            </div>
          )}

          {checklist?.failed && <Notice kind="pend" title={t('periods.checklistFailed')} />}

          {checklist?.blocked && (
            <Notice kind="bad" title={t('periods.cannotClose')}>
              {t('periods.blockedHint')}
            </Notice>
          )}

          {checklist && !checklist.failed && (
            <Panel
              flush
              titleAs="h3"
              title={t('periods.checklistTitle')}
              hint={
                checkSummary.bad + checkSummary.pend === 0
                  ? t('periods.checklistClean')
                  : t('periods.checklistHint', {
                      pend: String(checkSummary.bad + checkSummary.pend),
                      total: String(checkRows.length),
                    })
              }
            >
              {checkRows.length === 0 ? (
                <p className="px-4 py-3 text-[13px] text-text-3">{t('periods.checklistEmpty')}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {checkRows.map((i) => (
                    <li key={i.key} className="flex items-start gap-3 px-4 py-2.5 text-[13px]">
                      <StatusBadge
                        kind={i.kind}
                        label={
                          i.kind === 'ok'
                            ? t('periods.checkOk')
                            : i.kind === 'bad'
                              ? t('periods.blocking')
                              : t('periods.checkPending')
                        }
                        className="mt-px"
                      />
                      <div className="min-w-0 flex-1">
                        <p className={cn('font-medium', i.kind === 'ok' ? 'text-text-2' : 'text-foreground')}>
                          {i.kind !== 'ok' && <span className={NUM_CLASS}>{i.count} · </span>}
                          {itemLabel(i)}
                        </p>
                        {i.kind !== 'ok' && i.detail && (
                          <p className="mt-0.5 break-words text-[12px] leading-4 text-text-3">{i.detail}</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}
        </Dialog>
      )}

      {/* Diálogo de reapertura con motivo obligatorio. El motivo queda en el
          Registro de Actividad junto a quién reabrió. */}
      {reopenTarget && (
        <Dialog
          labelledBy="period-reopen-title"
          title={t('periods.reopenTitle', { label: reopenTarget.label })}
          onClose={() => !reopening && setReopenTarget(null)}
          footer={
            <>
              <ActionButton onClick={() => setReopenTarget(null)} disabled={reopening}>
                {t('periods.dialogCancel')}
              </ActionButton>
              <ActionButton
                variant="primary"
                onClick={confirmReopen}
                loading={reopening}
                disabled={!reopenReason.trim()}
              >
                {reopening ? t('periods.reopening') : t('periods.reopenPeriod')}
              </ActionButton>
            </>
          }
        >
          <p className="text-[13px] text-text-2">{t('periods.reopenIntro')}</p>
          <Field label={t('periods.reopenReason')} required hint={t('periods.reopenReasonHint')}>
            <Textarea
              rows={2}
              autoFocus
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder={t('periods.reopenPlaceholder')}
            />
          </Field>
        </Dialog>
      )}
    </div>
  );
}
