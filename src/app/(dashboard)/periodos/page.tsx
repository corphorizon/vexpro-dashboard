'use client';

import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAuth, canEdit } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import type { Period } from '@/lib/types';
import { useI18n } from '@/lib/i18n';
import { updatePeriodStatus } from '@/lib/supabase/mutations';
import { useConfirm } from '@/lib/use-confirm';
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

  const { confirm, Modal: ConfirmModal } = useConfirm();
  const [successMsg, showSuccessRaw] = useAutoClearMessage(3000);
  const [errorMsg, showErrorRaw] = useAutoClearMessage(4500);
  const [updating, setUpdating] = useState<string | null>(null);

  // Mutually-exclusive surfacing: showing a success clears any error and
  // vice-versa, so the UI never displays both at once.
  const showSuccess = (msg: string) => { showErrorRaw(''); showSuccessRaw(msg); };
  const showError = (msg: string) => { showSuccessRaw(''); showErrorRaw(msg); };

  const changeStatus = (id: string, newStatus: PeriodStatus) => {
    const period = managedPeriods.find(p => p.id === id);
    if (!period) return;

    const statusLabel = t(STATUS_LABEL_KEY[newStatus]);
    confirm(
      t('periods.changeStatusConfirm', { label: period.label, status: statusLabel }) +
        (newStatus === 'closed' ? t('periods.closedWarning') : ''),
      async () => {
        setUpdating(id);
        try {
          const isClosed = newStatus === 'closed';
          await updatePeriodStatus(id, isClosed);
          await refresh();
          showSuccess(t('periods.statusChanged', { label: period.label, status: statusLabel }));
        } catch (err) {
          console.error('Error updating period status:', err);
          showError(`Error: ${err instanceof Error ? err.message : 'Error desconocido'}`);
        } finally {
          setUpdating(null);
        }
      },
      // Closing a period is a consequential (near-destructive) action — use
      // the red tone. Opening back is fine with default styling.
      { tone: newStatus === 'closed' ? 'danger' : 'default' },
    );
  };

  const closedCount = managedPeriods.filter(p => p.status === 'closed').length;
  const openCount = managedPeriods.filter(p => p.status === 'open').length;
  const inProgressCount = managedPeriods.filter(p => p.status === 'in_progress').length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('periods.title')}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t('periods.subtitle')}</p>
      </div>

      {successMsg && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 text-sm font-medium" aria-live="polite">
          <Check className="w-4 h-4" />
          {successMsg}
        </div>
      )}
      {errorMsg && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-400 text-sm font-medium" aria-live="assertive">
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
            <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950/50"><Clock className="w-5 h-5 text-amber-500" /></div>
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
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
        <table className="w-full text-sm min-w-[480px]">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-2 px-2 sm:px-3 text-muted-foreground font-medium">{t('periods.title')}</th>
              <th className="text-left py-2 px-2 sm:px-3 text-muted-foreground font-medium hidden sm:table-cell">{t('periods.year')}</th>
              <th className="text-left py-2 px-2 sm:px-3 text-muted-foreground font-medium hidden sm:table-cell">{t('periods.month')}</th>
              <th className="text-center py-2 px-2 sm:px-3 text-muted-foreground font-medium">{t('common.status')}</th>
              {isAdmin && <th className="text-center py-2 px-2 sm:px-3 text-muted-foreground font-medium">{t('common.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {managedPeriods.map(period => {
              const badge = STATUS_BADGE[period.status];
              const Icon = STATUS_ICON[period.status];
              const now = new Date();
              const currentYear = now.getFullYear();
              const currentMonth = now.getMonth() + 1;
              const isCurrentMonth = period.year === currentYear && period.month === currentMonth;
              const isPastMonth = period.year < currentYear || (period.year === currentYear && period.month < currentMonth);
              const isUpdating = updating === period.id;

              return (
                <tr key={period.id} className="border-b border-border/50 hover:bg-muted/50">
                  <td className="py-3 px-2 sm:px-3 font-medium">
                    <div className="flex items-center gap-2">
                      <Icon className="w-4 h-4 text-muted-foreground" />
                      {period.label}
                    </div>
                  </td>
                  <td className="py-3 px-2 sm:px-3 hidden sm:table-cell">{period.year}</td>
                  <td className="py-3 px-2 sm:px-3 hidden sm:table-cell">{period.month}</td>
                  <td className="py-3 px-2 sm:px-3 text-center">
                    <Badge variant={badge}>{t(STATUS_LABEL_KEY[period.status])}</Badge>
                  </td>
                  {isAdmin && (
                    <td className="py-3 px-3 text-center">
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
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </Card>

      {ConfirmModal}
    </div>
  );
}
