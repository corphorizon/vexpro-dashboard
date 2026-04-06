'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAuth, canEdit } from '@/lib/auth-context';
import { DEMO_PERIODS } from '@/lib/demo-data';
import { useI18n } from '@/lib/i18n';
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

function getInitialStatus(p: typeof DEMO_PERIODS[0]): PeriodStatus {
  // Current month (April 2026)
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  if (p.year === currentYear && p.month === currentMonth) return 'in_progress';
  if (p.is_closed) return 'closed';
  // Past months that aren't closed yet
  if (p.year < currentYear || (p.year === currentYear && p.month < currentMonth)) return 'open';
  return 'open';
}

export default function PeríodosPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const isAdmin = canEdit(user);

  const [periods, setPeriods] = useState<ManagedPeriod[]>(
    DEMO_PERIODS.map(p => ({
      id: p.id,
      label: p.label || '',
      year: p.year,
      month: p.month,
      status: getInitialStatus(p),
    }))
  );

  const [confirmAction, setConfirmAction] = useState<{ message: string; onConfirm: () => void } | null>(null);
  const [successMsg, setSuccessMsg] = useState('');

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 3000);
  };

  const changeStatus = (id: string, newStatus: PeriodStatus) => {
    const period = periods.find(p => p.id === id);
    if (!period) return;

    const statusLabel = t(STATUS_LABEL_KEY[newStatus]);
    setConfirmAction({
      message: t('periods.changeStatusConfirm', { label: period.label, status: statusLabel }) + (newStatus === 'closed' ? t('periods.closedWarning') : ''),
      onConfirm: () => {
        setPeriods(prev => prev.map(p => p.id === id ? { ...p, status: newStatus } : p));
        showSuccess(t('periods.statusChanged', { label: period.label, status: statusLabel }));
      },
    });
  };

  const closedCount = periods.filter(p => p.status === 'closed').length;
  const openCount = periods.filter(p => p.status === 'open').length;
  const inProgressCount = periods.filter(p => p.status === 'in_progress').length;

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
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('periods.title')}</th>
              <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('periods.year')}</th>
              <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('periods.month')}</th>
              <th className="text-center py-2 px-3 text-muted-foreground font-medium">{t('common.status')}</th>
              {isAdmin && <th className="text-center py-2 px-3 text-muted-foreground font-medium">{t('common.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {periods.map(period => {
              const badge = STATUS_BADGE[period.status];
              const Icon = STATUS_ICON[period.status];
              const now = new Date();
              const currentYear = now.getFullYear();
              const currentMonth = now.getMonth() + 1;
              const isCurrentMonth = period.year === currentYear && period.month === currentMonth;
              const isPastMonth = period.year < currentYear || (period.year === currentYear && period.month < currentMonth);

              return (
                <tr key={period.id} className="border-b border-border/50 hover:bg-muted/50">
                  <td className="py-3 px-3 font-medium">
                    <div className="flex items-center gap-2">
                      <Icon className="w-4 h-4 text-muted-foreground" />
                      {period.label}
                    </div>
                  </td>
                  <td className="py-3 px-3">{period.year}</td>
                  <td className="py-3 px-3">{period.month}</td>
                  <td className="py-3 px-3 text-center">
                    <Badge variant={badge}>{t(STATUS_LABEL_KEY[period.status])}</Badge>
                  </td>
                  {isAdmin && (
                    <td className="py-3 px-3 text-center">
                      <div className="flex justify-center gap-1">
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
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {/* Confirmation dialog */}
      {confirmAction && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-xl shadow-xl p-6 max-w-md mx-4">
            <h3 className="text-lg font-semibold mb-2">{t('upload.confirm')}</h3>
            <p className="text-sm text-muted-foreground mb-6">{confirmAction.message}</p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmAction(null)}
                className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => { confirmAction.onConfirm(); setConfirmAction(null); }}
                className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
              >
                {t('users.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
