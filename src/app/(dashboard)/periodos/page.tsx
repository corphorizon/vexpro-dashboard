'use client';

import { useState, useEffect } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { Card } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { Badge } from '@/components/ui/badge';
import { useAuth, canEdit } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import type { Period } from '@/lib/types';
import { useI18n } from '@/lib/i18n';
import { updatePeriodStatus } from '@/lib/supabase/mutations';
import { useAutoClearMessage } from '@/lib/use-auto-clear-message';
import { Calendar, Lock, Unlock, Clock, Check } from 'lucide-react';

type PeriodStatus = 'closed' | 'open' | 'in_progress';

interface ManagedPeriod {
  id: string;
  label: string;
  year: number;
  month: number;
  status: PeriodStatus;
}

const STATUS_BADGE: Record<PeriodStatus, 'success' | 'warning' | 'neutral'> = {
  closed: 'neutral',
  open: 'success',
  in_progress: 'warning',
};

const STATUS_ICON: Record<PeriodStatus, typeof Lock> = {
  closed: Lock,
  open: Unlock,
  in_progress: Clock,
};

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

function getStatusFromPeriod(p: Period): PeriodStatus {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  if (p.year === currentYear && p.month === currentMonth) return 'in_progress';
  if (p.is_closed) return 'closed';
  return 'open';
}

export default function PeríodosPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { periods: dataPeriods, refresh } = useData();
  const isAdmin = canEdit(user);

  // Derive managed periods from data context (always in sync)
  const [managedPeriods, setManagedPeriods] = useState<ManagedPeriod[]>([]);

  // Keep local state in sync with data context
  useEffect(() => {
    setManagedPeriods(
      dataPeriods.map(p => ({
        id: p.id,
        label: p.label || '',
        year: p.year,
        month: p.month,
        status: getStatusFromPeriod(p),
      }))
    );
  }, [dataPeriods]);

  const [successMsg, showSuccessRaw] = useAutoClearMessage(3000);
  const [errorMsg, showErrorRaw] = useAutoClearMessage(4500);
  const [updating, setUpdating] = useState<string | null>(null);

  // Mutually-exclusive surfacing: showing a success clears any error and
  // vice-versa, so the UI never displays both at once.
  const showSuccess = (msg: string) => { showErrorRaw(''); showSuccessRaw(msg); };
  const showError = (msg: string) => { showSuccessRaw(''); showErrorRaw(msg); };

  const [closeTarget, setCloseTarget] = useState<{ id: string; label: string; statusLabel: string } | null>(null);
  const [checklist, setChecklist] = useState<{
    items: Array<{ key: string; label: string; count: number; detail: string | null }>;
    clean: boolean;
    failed?: boolean;
  } | null>(null);
  const [closing, setClosing] = useState(false);

  const confirmClose = async () => {
    if (!closeTarget) return;
    setClosing(true);
    setUpdating(closeTarget.id);
    try {
      await updatePeriodStatus(closeTarget.id, true, undefined);
      await refresh();
      showSuccess(t('periods.statusChanged', { label: closeTarget.label, status: closeTarget.statusLabel }));
      setCloseTarget(null);
    } catch (err) {
      showError(`Error: ${err instanceof Error ? err.message : 'Error desconocido'}`);
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
      showError(`Error: ${err instanceof Error ? err.message : 'Error desconocido'}`);
    } finally {
      setReopening(false);
      setUpdating(null);
    }
  };

  const changeStatus = (id: string, newStatus: PeriodStatus) => {
    const period = managedPeriods.find(p => p.id === id);
    if (!period) return;

    const statusLabel = t(STATUS_LABEL_KEY[newStatus]);

    // Reabrir tiene su propio diálogo con campo de motivo. El window.prompt
    // anterior era nativo, sin estilo, sin i18n y algunos navegadores lo
    // bloquean en silencio — la reapertura se cancelaba sin explicación
    // (auditoría 2026-08-06, QW12).
    if (newStatus !== 'closed') {
      setReopenTarget({ id, label: period.label });
      setReopenReason('');
      return;
    }

    // Cerrar abre su propio diálogo con el CHECKLIST de pendientes (P1-4 del
    // benchmark, auditoría 2026-08-06): egresos sin comprobante, liquidez sin
    // conciliar, órdenes aprobadas sin pagar e inversiones mixtas. Son
    // advertencias, no bloqueos — cerrar con pendientes es legítimo, pero
    // tiene que ser una decisión informada, no un descuido.
    setCloseTarget({ id, label: period.label, statusLabel });
    setChecklist(null);
    void apiFetch(`/api/admin/period-close-checklist?period_id=${id}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setChecklist({ items: json.items ?? [], clean: !!json.clean });
        else setChecklist({ items: [], clean: true, failed: true });
      })
      // Si el checklist falla, se puede cerrar igual: es un asistente, no
      // una barrera nueva.
      .catch(() => setChecklist({ items: [], clean: true, failed: true }));
  };

  const closedCount = managedPeriods.filter(p => p.status === 'closed').length;
  const openCount = managedPeriods.filter(p => p.status === 'open').length;
  const inProgressCount = managedPeriods.filter(p => p.status === 'in_progress').length;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('periods.title')}
        subtitle={t('periods.subtitle')}
        icon={Calendar}
      />

      {successMsg && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-positive/10 text-positive text-sm font-medium" aria-live="polite">
          <Check className="w-4 h-4" />
          {successMsg}
        </div>
      )}
      {errorMsg && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-negative/10 text-negative text-sm font-medium" aria-live="assertive">
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" /></svg>
          {errorMsg}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800"><Lock className="w-5 h-5 text-slate-500" /></div>
            <div>
              <p className="text-sm text-muted-foreground">{t('periods.closed')}</p>
              <p className="text-2xl font-bold">{closedCount}</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-50"><Unlock className="w-5 h-5 text-emerald-500" /></div>
            <div>
              <p className="text-sm text-muted-foreground">{t('periods.open')}</p>
              <p className="text-2xl font-bold">{openCount}</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-warning/10"><Clock className="w-5 h-5 text-amber-500" /></div>
            <div>
              <p className="text-sm text-muted-foreground">{t('periods.inProgress')}</p>
              <p className="text-2xl font-bold">{inProgressCount}</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Legend */}
      <Card>
        <h2 className="text-sm font-semibold mb-3">{t('periods.statuses')}</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {(['closed', 'open', 'in_progress'] as PeriodStatus[]).map((key) => (
            <div key={key} className="flex items-start gap-2 text-sm">
              <Badge variant={STATUS_BADGE[key]}>{t(STATUS_LABEL_KEY[key])}</Badge>
              <span className="text-muted-foreground text-xs">{t(STATUS_DESC_KEY[key])}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Periods table */}
      <Card>
        <div className="flex items-center gap-3 mb-4">
          <Calendar className="w-5 h-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">{t('periods.title')}</h2>
        </div>
        <DataTable
          className="-mx-4 px-4 sm:mx-0 sm:px-0"
          data={managedPeriods}
          columns={[
            {
              header: t('periods.title'),
              accessor: (period) => {
                const Icon = STATUS_ICON[period.status];
                return (
                  <div className="flex items-center gap-2 font-medium">
                    <Icon className="w-4 h-4 text-muted-foreground" />
                    {period.label}
                  </div>
                );
              },
            },
            { header: t('periods.year'), accessor: 'year', className: 'hidden sm:table-cell' },
            { header: t('periods.month'), accessor: 'month', className: 'hidden sm:table-cell' },
            {
              header: t('common.status'),
              align: 'center',
              accessor: (period) => (
                <Badge variant={STATUS_BADGE[period.status]}>{t(STATUS_LABEL_KEY[period.status])}</Badge>
              ),
            },
            ...(isAdmin
              ? [{
                  header: t('common.actions'),
                  align: 'center' as const,
                  accessor: (period: ManagedPeriod) => {
                    const now = new Date();
                    const currentYear = now.getFullYear();
                    const currentMonth = now.getMonth() + 1;
                    const isCurrentMonth = period.year === currentYear && period.month === currentMonth;
                    const isPastMonth = period.year < currentYear || (period.year === currentYear && period.month < currentMonth);
                    const isUpdating = updating === period.id;
                    return (
                      <div className="flex justify-center gap-1">
                        {isUpdating ? (
                          <span className="text-xs text-muted-foreground">Actualizando...</span>
                        ) : (
                          <>
                            {period.status === 'open' && (
                              <button
                                onClick={() => changeStatus(period.id, 'closed')}
                                className="px-2.5 py-1 text-xs rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                              >
                                {t('periods.close')}
                              </button>
                            )}
                            {period.status === 'closed' && (
                              <button
                                onClick={() => changeStatus(period.id, 'open')}
                                className="px-2.5 py-1 text-xs rounded-md bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-400 dark:hover:bg-emerald-900/50 transition-colors"
                              >
                                {t('periods.reopen')}
                              </button>
                            )}
                            {period.status === 'in_progress' && isPastMonth && (
                              <button
                                onClick={() => changeStatus(period.id, 'closed')}
                                className="px-2.5 py-1 text-xs rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                              >
                                {t('periods.closeMonth')}
                              </button>
                            )}
                            {period.status === 'in_progress' && isCurrentMonth && (
                              <span className="text-xs text-muted-foreground">{t('periods.monthInProgress')}</span>
                            )}
                          </>
                        )}
                      </div>
                    );
                  },
                }]
              : []),
          ]}
        />
      </Card>

      {/* Diálogo de CIERRE con checklist de pendientes. */}
      {closeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Cerrar ${closeTarget.label}`}
            className="w-full max-w-md rounded-xl border border-border bg-card shadow-[var(--elevation-3)] p-5 space-y-4 max-h-[85vh] overflow-y-auto"
          >
            <h2 className="font-semibold">Cerrar {closeTarget.label}</h2>
            <p className="text-sm text-muted-foreground">
              Al cerrar, los totales se congelan y el mes queda bloqueado para
              edición. Antes de confirmar, esto es lo que quedó pendiente:
            </p>

            {!checklist && <p className="text-sm text-muted-foreground">Revisando pendientes…</p>}

            {checklist?.failed && (
              <p className="text-sm text-amber-600">
                No se pudo revisar los pendientes — podés cerrar igual.
              </p>
            )}

            {checklist && !checklist.failed && (
              checklist.clean ? (
                <p className="text-sm text-positive font-medium">
                  ✓ Sin pendientes: egresos con respaldo, liquidez conciliada,
                  sin órdenes aprobadas por pagar ni inversiones mixtas.
                </p>
              ) : (
                <ul className="space-y-2">
                  {checklist.items.filter((i) => i.count > 0).map((i) => (
                    <li key={i.key} className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
                      <p className="font-medium">
                        {i.count} · {i.label}
                      </p>
                      {i.detail && (
                        <p className="text-xs text-muted-foreground mt-1 break-words">{i.detail}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setCloseTarget(null)}
                className="px-4 py-2 rounded-lg border border-border text-sm hover:bg-muted"
              >
                Cancelar
              </button>
              <button
                onClick={confirmClose}
                disabled={closing || !checklist}
                className="px-4 py-2 rounded-lg bg-negative text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {closing
                  ? 'Cerrando…'
                  : checklist && !checklist.clean
                    ? 'Cerrar de todos modos'
                    : 'Cerrar período'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Diálogo de reapertura con motivo obligatorio (reemplaza al
          window.prompt nativo). El motivo queda en el Registro de Actividad
          junto a quién reabrió. */}
      {reopenTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Reabrir ${reopenTarget.label}`}
            className="w-full max-w-md rounded-xl border border-border bg-card shadow-[var(--elevation-3)] p-5 space-y-4"
          >
            <h2 className="font-semibold">Reabrir {reopenTarget.label}</h2>
            <p className="text-sm text-muted-foreground">
              Reabrir desbloquea la edición de ese mes y puede cambiar el saldo ya
              distribuido a los socios. El motivo queda registrado junto a tu nombre.
            </p>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Motivo (obligatorio)</span>
              <textarea
                rows={2}
                autoFocus
                value={reopenReason}
                onChange={(e) => setReopenReason(e.target.value)}
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-base sm:text-sm"
                placeholder="Ej.: corregir el egreso de la oficina duplicado"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setReopenTarget(null)}
                className="px-4 py-2 rounded-lg border border-border text-sm hover:bg-muted"
              >
                Cancelar
              </button>
              <button
                onClick={confirmReopen}
                disabled={reopening || !reopenReason.trim()}
                className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {reopening ? 'Reabriendo…' : 'Reabrir período'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
