'use client';

import { Badge } from '@/components/ui/badge';
import { Plus, Trash2, Edit2, Check, X } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { computeIncomePending } from '@/lib/income-lines';
import type { UseIncomeLinesResult } from './use-income-lines';

export interface IncomeLinesSectionProps {
  /** Lo que devuelve `useIncomeLines` en el padre. */
  income: UseIncomeLinesResult;
  userCanAdd: boolean;
  userCanEdit: boolean;
  userCanDelete: boolean;
  /** Período cerrado: deshabilita el alta igual que antes. */
  periodIsClosed: boolean;
}

/**
 * Detalle por concepto — mismas columnas, alta inline y edición por fila que
 * la tabla de Egresos, para que el equipo no tenga que aprender dos tablas
 * distintas.
 */
export function IncomeLinesSection({
  income,
  userCanAdd,
  userCanEdit,
  userCanDelete,
  periodIsClosed,
}: IncomeLinesSectionProps) {
  const { t } = useI18n();
  const {
    incomeLines,
    incomeTotals,
    incomeByClient,
    savingIncomeLines,
    newIncomeLine,
    setNewIncomeLine,
    editingIncomeLineId,
    setEditingIncomeLineId,
    editIncomeLine,
    setEditIncomeLine,
    addIncomeLine,
    startEditIncomeLine,
    saveEditIncomeLine,
    markIncomeCollected,
    deleteIncomeLine,
  } = income;

  return (
    <div className="pt-4 border-t border-border">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h3 className="text-sm font-semibold">{t('income.detailTitle')}</h3>
        {savingIncomeLines && (
          <span className="text-xs text-muted-foreground">{t('common.saving')}</span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground mb-3">{t('income.detailHint')}</p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
          <p className="text-[11px] text-muted-foreground">{t('income.invoiced')}</p>
          <p className="text-base font-bold tabular-nums">{formatCurrency(incomeTotals.amount)}</p>
        </div>
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
          <p className="text-[11px] text-muted-foreground">{t('income.received')}</p>
          <p className="text-base font-bold tabular-nums text-positive">{formatCurrency(incomeTotals.received)}</p>
        </div>
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
          <p className="text-[11px] text-muted-foreground">{t('income.pendingAmount')}</p>
          <p className="text-base font-bold tabular-nums">{formatCurrency(incomeTotals.pending)}</p>
        </div>
      </div>

      {incomeByClient.length > 0 && (
        <details className="mb-4 rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium select-none">
            {t('income.byClient')}
          </summary>
          <ul className="border-t border-border divide-y divide-border/50">
            {incomeByClient.map(({ client, totals }) => (
              <li key={client} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2 text-sm">
                {/* groupByClient rotula en español los sin cliente; acá
                    se traduce para no filtrar ese literal a la UI. */}
                <span className="font-medium">{client === 'Sin asignar' ? t('income.unassignedClient') : client}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {t('income.invoiced')} {formatCurrency(totals.amount)} · {t('income.received')} {formatCurrency(totals.received)} · {t('income.pendingAmount')} {formatCurrency(totals.pending)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
        <table className="w-full text-sm min-w-[560px]">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">#</th>
              <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('income.concept')}</th>
              <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('income.client')}</th>
              <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('income.invoiced')}</th>
              <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('income.received')}</th>
              <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('income.pendingAmount')}</th>
              <th className="text-center py-2.5 px-3 text-muted-foreground font-medium">{t('common.status')}</th>
              {(userCanEdit || userCanDelete) && <th className="w-24 text-center py-2.5 px-3 text-muted-foreground font-medium">{t('common.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {incomeLines.length === 0 && (
              <tr>
                <td colSpan={8} className="py-8 text-center text-muted-foreground">
                  {t('income.empty')} {userCanAdd && t('income.emptyHint')}
                </td>
              </tr>
            )}
            {incomeLines.map((line, i) => (
              <tr key={line.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                {editingIncomeLineId === line.id ? (
                  <>
                    <td className="py-2.5 px-3 text-muted-foreground">{i + 1}</td>
                    <td className="py-2.5 px-3">
                      <input aria-label={t('income.conceptAria')} value={editIncomeLine.concept} onChange={e => setEditIncomeLine(p => ({ ...p, concept: e.target.value }))} className="w-full px-2 py-1 rounded border border-border text-base sm:text-sm bg-background" />
                    </td>
                    <td className="py-2.5 px-3">
                      <input aria-label={t('income.clientAria')} value={editIncomeLine.client} onChange={e => setEditIncomeLine(p => ({ ...p, client: e.target.value }))} placeholder={t('income.clientPlaceholder')} className="w-full px-2 py-1 rounded border border-border text-base sm:text-sm bg-background" />
                    </td>
                    <td className="py-2.5 px-3">
                      <input type="number" step="0.01" aria-label={t('income.amountAria')} value={editIncomeLine.amount} onChange={e => setEditIncomeLine(p => ({ ...p, amount: e.target.value }))} className="w-full text-right px-2 py-1 rounded border border-border text-base sm:text-sm bg-background" />
                    </td>
                    <td className="py-2.5 px-3">
                      <input type="number" step="0.01" aria-label={t('income.receivedAria')} value={editIncomeLine.received} onChange={e => setEditIncomeLine(p => ({ ...p, received: e.target.value }))} className="w-full text-right px-2 py-1 rounded border border-border text-base sm:text-sm bg-background" />
                    </td>
                    <td className="py-2.5 px-3">
                      <input type="number" step="0.01" aria-label={t('income.pendingAria')} value={editIncomeLine.pending} onChange={e => setEditIncomeLine(p => ({ ...p, pending: e.target.value }))} className="w-full text-right px-2 py-1 rounded border border-border text-base sm:text-sm bg-background" />
                      {/* Lo que se guardará si el pendiente queda vacío. */}
                      <p className="text-right text-[11px] text-muted-foreground mt-0.5 tabular-nums">
                        {formatCurrency(computeIncomePending(editIncomeLine.amount, editIncomeLine.received, editIncomeLine.pending))}
                      </p>
                    </td>
                    <td></td>
                    <td className="py-2.5 px-3 text-center">
                      <div className="flex justify-center gap-1">
                        <button onClick={saveEditIncomeLine} disabled={savingIncomeLines} className="p-2 sm:p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 rounded disabled:opacity-50" aria-label={t('common.save')}><Check className="w-4 h-4" /></button>
                        <button onClick={() => setEditingIncomeLineId(null)} className="p-2 sm:p-1 text-muted-foreground hover:bg-muted rounded" aria-label={t('common.cancel')}><X className="w-4 h-4" /></button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="py-2.5 px-3 text-muted-foreground">{i + 1}</td>
                    <td className="py-2.5 px-3 font-medium">{line.concept}</td>
                    <td className="py-2.5 px-3">
                      {line.client ? (
                        <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                          {line.client}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-right font-medium tabular-nums">{formatCurrency(line.amount)}</td>
                    <td className="py-2.5 px-3 text-right tabular-nums">{formatCurrency(line.received)}</td>
                    <td className="py-2.5 px-3 text-right tabular-nums">{formatCurrency(line.pending)}</td>
                    <td className="py-2.5 px-3 text-center">
                      <Badge variant={line.pending === 0 ? 'success' : 'warning'}>
                        {line.pending === 0 ? t('income.collectedStatus') : t('income.pendingStatus')}
                      </Badge>
                    </td>
                    {(userCanEdit || userCanDelete) && (
                      <td className="py-2.5 px-3 text-center">
                        <div className="flex justify-center gap-1">
                          {userCanEdit && line.pending > 0 && (
                            <button onClick={() => markIncomeCollected(line.id)} className="p-2 sm:p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 rounded" title={t('income.markCollected')} aria-label={t('income.markCollectedAria', { concept: line.concept })}><Check className="w-3.5 h-3.5" /></button>
                          )}
                          {userCanEdit && (
                            <button onClick={() => startEditIncomeLine(line)} className="p-2 sm:p-1 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded" title={t('common.edit')} aria-label={t('common.edit')}><Edit2 className="w-3.5 h-3.5" /></button>
                          )}
                          {userCanDelete && (
                            <button onClick={() => deleteIncomeLine(line.id)} className="p-2 sm:p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50 rounded" title={t('common.delete')} aria-label={t('common.delete')}><Trash2 className="w-3.5 h-3.5" /></button>
                          )}
                        </div>
                      </td>
                    )}
                  </>
                )}
              </tr>
            ))}
          </tbody>
          {incomeLines.length > 0 && (
            <tfoot>
              <tr className="font-bold bg-muted/50">
                <td className="py-3 px-3" colSpan={3}>{t('common.total')}</td>
                <td className="py-2.5 px-3 text-right tabular-nums">{formatCurrency(incomeTotals.amount)}</td>
                <td className="py-2.5 px-3 text-right tabular-nums">{formatCurrency(incomeTotals.received)}</td>
                <td className="py-2.5 px-3 text-right tabular-nums">{formatCurrency(incomeTotals.pending)}</td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {userCanAdd && (
        <div className="mt-4 pt-4 border-t border-border">
          <h4 className="text-sm font-semibold flex items-center gap-2 mb-3"><Plus className="w-4 h-4" /> {t('income.addLine')}</h4>
          <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
            <div className="md:col-span-2">
              <input
                aria-label={t('income.conceptAria')}
                value={newIncomeLine.concept}
                onChange={e => setNewIncomeLine(p => ({ ...p, concept: e.target.value }))}
                placeholder={t('income.conceptPlaceholder')}
                className="w-full px-3 py-2 rounded-lg border border-border text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <input
              aria-label={t('income.clientAria')}
              value={newIncomeLine.client}
              onChange={e => setNewIncomeLine(p => ({ ...p, client: e.target.value }))}
              placeholder={t('income.clientPlaceholder')}
              className="w-full px-3 py-2 rounded-lg border border-border text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <input
              type="number" step="0.01"
              aria-label={t('income.amountAria')}
              value={newIncomeLine.amount}
              onChange={e => setNewIncomeLine(p => ({ ...p, amount: e.target.value }))}
              placeholder={t('income.invoiced')}
              className="w-full px-3 py-2 rounded-lg border border-border text-base sm:text-sm text-right focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <input
              type="number" step="0.01"
              aria-label={t('income.receivedAria')}
              value={newIncomeLine.received}
              onChange={e => setNewIncomeLine(p => ({ ...p, received: e.target.value }))}
              placeholder={t('income.received')}
              className="w-full px-3 py-2 rounded-lg border border-border text-base sm:text-sm text-right focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button
              onClick={addIncomeLine}
              disabled={!newIncomeLine.concept || !newIncomeLine.amount || savingIncomeLines || periodIsClosed}
              className="min-h-[44px] px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
            >
              {savingIncomeLines ? t('common.saving') : t('common.add')}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2 tabular-nums">
            {t('income.pendingAmount')}: {formatCurrency(computeIncomePending(newIncomeLine.amount, newIncomeLine.received, newIncomeLine.pending))}
          </p>
        </div>
      )}
    </div>
  );
}
