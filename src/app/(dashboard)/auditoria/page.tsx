'use client';

import { useState, useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import {
  getAuditLog,
  exportAuditLogCSV,
  AUDIT_ACTION_LABELS,
  AUDIT_MODULE_LABELS,
  type AuditAction,
  type AuditModule,
  type AuditEntry,
} from '@/lib/audit-log';
import { useI18n } from '@/lib/i18n';
import { ClipboardList, Download, Filter, X } from 'lucide-react';

const ACTION_COLORS: Record<AuditAction, string> = {
  create: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400',
  update: 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400',
  delete: 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400',
  login: 'bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-400',
  logout: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400',
  export: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400',
  view: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-950/50 dark:text-cyan-400',
};

const ALL_ACTIONS: AuditAction[] = ['create', 'update', 'delete', 'login', 'logout', 'export', 'view'];
const ALL_MODULES: AuditModule[] = ['auth', 'deposits', 'withdrawals', 'expenses', 'income', 'liquidity', 'investments', 'partners', 'hr', 'users', 'periods'];

export default function AuditoriaPage() {
  const { t } = useI18n();
  const { user, users } = useAuth();
  const canAccess = useModuleAccess('audit');

  const [filterUser, setFilterUser] = useState('');
  const [filterAction, setFilterAction] = useState('');
  const [filterModule, setFilterModule] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  if (!canAccess) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">{t('common.noAccess')}</p>
      </div>
    );
  }

  const entries = useMemo(() => {
    return getAuditLog({
      userId: filterUser || undefined,
      action: (filterAction as AuditAction) || undefined,
      module: (filterModule as AuditModule) || undefined,
      dateFrom: filterDateFrom || undefined,
      dateTo: filterDateTo || undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterUser, filterAction, filterModule, filterDateFrom, filterDateTo]);

  const handleExportCSV = () => {
    const csv = exportAuditLogCSV(entries);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `auditoria_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const clearFilters = () => {
    setFilterUser('');
    setFilterAction('');
    setFilterModule('');
    setFilterDateFrom('');
    setFilterDateTo('');
  };

  const hasActiveFilters = filterUser || filterAction || filterModule || filterDateFrom || filterDateTo;

  const formatTimestamp = (ts: string) => {
    try {
      return new Date(ts).toLocaleString('es-MX', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return ts;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)] flex items-center justify-center">
            <ClipboardList className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-xl font-bold">{t('audit.title')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('audit.systemActivity')} &mdash; {entries.length} {entries.length !== 1 ? t('audit.entries') : t('audit.entry')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              showFilters || hasActiveFilters
                ? 'bg-[var(--color-primary)] text-white'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            <Filter className="w-4 h-4" />
            {t('common.filter')}
          </button>
          <button
            onClick={handleExportCSV}
            disabled={entries.length === 0}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <Download className="w-4 h-4" />
            {t('audit.exportCsv')}
          </button>
        </div>
      </div>

      {/* Filters */}
      {showFilters && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium">{t('audit.filters')}</span>
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <X className="w-3 h-3" />
                {t('audit.clearFilters')}
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t('audit.filterUser')}</label>
              <select
                value={filterUser}
                onChange={(e) => setFilterUser(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
              >
                <option value="">{t('audit.allMasc')}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t('audit.filterAction')}</label>
              <select
                value={filterAction}
                onChange={(e) => setFilterAction(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
              >
                <option value="">{t('audit.allFem')}</option>
                {ALL_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {AUDIT_ACTION_LABELS[a]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t('audit.filterModule')}</label>
              <select
                value={filterModule}
                onChange={(e) => setFilterModule(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
              >
                <option value="">{t('audit.allMasc')}</option>
                {ALL_MODULES.map((m) => (
                  <option key={m} value={m}>
                    {AUDIT_MODULE_LABELS[m]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t('audit.filterFrom')}</label>
              <input
                type="date"
                value={filterDateFrom}
                onChange={(e) => setFilterDateFrom(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t('audit.filterTo')}</label>
              <input
                type="date"
                value={filterDateTo}
                onChange={(e) => setFilterDateTo(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
              />
            </div>
          </div>
        </Card>
      )}

      {/* Table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">{t('audit.date')}</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">{t('audit.user')}</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">{t('audit.action')}</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">{t('audit.module')}</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">{t('audit.details')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-muted-foreground">
                    {t('audit.noRecords')}
                    {hasActiveFilters ? t('audit.noRecordsFiltered') : ''}
                  </td>
                </tr>
              ) : (
                entries.map((entry) => (
                  <tr key={entry.id} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                    <td className="py-2.5 px-4 text-muted-foreground whitespace-nowrap">
                      {formatTimestamp(entry.timestamp)}
                    </td>
                    <td className="py-2.5 px-4 font-medium">{entry.user_name}</td>
                    <td className="py-2.5 px-4">
                      <Badge variant="neutral" className={`text-xs ${ACTION_COLORS[entry.action] || 'bg-gray-100 text-gray-700'}`}>
                        {AUDIT_ACTION_LABELS[entry.action] || entry.action}
                      </Badge>
                    </td>
                    <td className="py-2.5 px-4 text-muted-foreground">
                      {AUDIT_MODULE_LABELS[entry.module] || entry.module}
                    </td>
                    <td className="py-2.5 px-4 text-muted-foreground max-w-xs truncate" title={entry.details}>
                      {entry.details}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
