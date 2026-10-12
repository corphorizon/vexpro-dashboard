'use client';

import { Plus, Trash2, Edit2, Check, X } from 'lucide-react';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Field, Input } from '@/components/ui/field';
import { KpiStrip } from '@/components/ui/kpi-strip';
import { Money } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { useI18n } from '@/lib/i18n';
import { computeIncomePending, type IncomeLine } from '@/lib/income-lines';
import { INPUT_MOBILE, INPUT_NUM, ROW_BTN, ROW_BTN_DANGER, btnClass } from './upload-ui';
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
 *
 * «Libro mayor» (2026-10-12): los tres totales pasan a una <KpiStrip> (antes
 * tres tarjetas `bg-muted/30` con «Cobrado» en verde — no era una ganancia,
 * era una columna); la tabla a <FinTable> con el pie de doble raya; el estado
 * Cobrado/Pendiente a <StatusBadge> (ok / pend); los inputs a la primitiva
 * <Input> (antes la edición inline no tenía foco visible propio). La lógica
 * (useIncomeLines) no se tocó: este archivo sólo pinta lo que el hook devuelve.
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

  const isEditing = (line: IncomeLine) => editingIncomeLineId === line.id;
  const numberOf = new Map(incomeLines.map((l, i) => [l.id, i + 1]));

  const columns: FinColumn<IncomeLine>[] = [
    {
      key: 'n',
      header: '#',
      width: '3rem',
      hideSm: true,
      cell: (line) => <span className="tabular-nums text-text-3">{numberOf.get(line.id)}</span>,
    },
    {
      key: 'concept',
      header: t('income.concept'),
      cell: (line) =>
        isEditing(line) ? (
          <Input
            aria-label={t('income.conceptAria')}
            value={editIncomeLine.concept}
            onChange={(e) => setEditIncomeLine((p) => ({ ...p, concept: e.target.value }))}
            className={INPUT_MOBILE}
          />
        ) : (
          <span className="font-medium text-foreground">{line.concept}</span>
        ),
    },
    {
      key: 'client',
      header: t('income.client'),
      cell: (line) =>
        isEditing(line) ? (
          <Input
            aria-label={t('income.clientAria')}
            value={editIncomeLine.client}
            onChange={(e) => setEditIncomeLine((p) => ({ ...p, client: e.target.value }))}
            placeholder={t('income.clientPlaceholder')}
            className={INPUT_MOBILE}
          />
        ) : line.client ? (
          <span className="text-text-2">{line.client}</span>
        ) : (
          <span className="text-text-3">—</span>
        ),
    },
    {
      key: 'amount',
      header: t('income.invoiced'),
      kind: 'money',
      value: (line) => line.amount,
      cell: (line) =>
        isEditing(line) ? (
          <Input
            type="number"
            step="0.01"
            aria-label={t('income.amountAria')}
            value={editIncomeLine.amount}
            onChange={(e) => setEditIncomeLine((p) => ({ ...p, amount: e.target.value }))}
            className={INPUT_NUM}
          />
        ) : (
          <Money value={line.amount} className="font-medium" />
        ),
    },
    {
      key: 'received',
      header: t('income.received'),
      kind: 'money',
      value: (line) => line.received,
      cell: (line) =>
        isEditing(line) ? (
          <Input
            type="number"
            step="0.01"
            aria-label={t('income.receivedAria')}
            value={editIncomeLine.received}
            onChange={(e) => setEditIncomeLine((p) => ({ ...p, received: e.target.value }))}
            className={INPUT_NUM}
          />
        ) : (
          <Money value={line.received} />
        ),
    },
    {
      key: 'pending',
      header: t('income.pendingAmount'),
      kind: 'money',
      value: (line) => line.pending,
      cell: (line) =>
        isEditing(line) ? (
          <div className="flex flex-col items-end gap-0.5">
            <Input
              type="number"
              step="0.01"
              aria-label={t('income.pendingAria')}
              value={editIncomeLine.pending}
              onChange={(e) => setEditIncomeLine((p) => ({ ...p, pending: e.target.value }))}
              className={INPUT_NUM}
            />
            {/* Lo que se guardará si el pendiente queda vacío. */}
            <Money
              value={computeIncomePending(editIncomeLine.amount, editIncomeLine.received, editIncomeLine.pending)}
              className="text-[12px] text-text-3"
            />
          </div>
        ) : (
          <Money value={line.pending} />
        ),
    },
    {
      key: 'status',
      header: t('common.status'),
      align: 'center',
      cardSide: 'left',
      cell: (line) =>
        isEditing(line) ? null : (
          <StatusBadge
            kind={line.pending === 0 ? 'ok' : 'pend'}
            label={line.pending === 0 ? t('income.collectedStatus') : t('income.pendingStatus')}
          />
        ),
    },
  ];

  if (userCanEdit || userCanDelete) {
    columns.push({
      key: 'actions',
      header: <span className="sr-only">{t('common.actions')}</span>,
      width: '7rem',
      align: 'right',
      cardSide: 'right',
      cell: (line) =>
        isEditing(line) ? (
          <span className="inline-flex gap-1">
            <button
              type="button"
              onClick={saveEditIncomeLine}
              disabled={savingIncomeLines}
              className={ROW_BTN}
              aria-label={t('common.save')}
            >
              <Check aria-hidden className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setEditingIncomeLineId(null)}
              className={ROW_BTN}
              aria-label={t('common.cancel')}
            >
              <X aria-hidden className="size-4" />
            </button>
          </span>
        ) : (
          <span className="inline-flex gap-1">
            {userCanEdit && line.pending > 0 && (
              <button
                type="button"
                onClick={() => markIncomeCollected(line.id)}
                className={ROW_BTN}
                title={t('income.markCollected')}
                aria-label={t('income.markCollectedAria', { concept: line.concept })}
              >
                <Check aria-hidden className="size-3.5" />
              </button>
            )}
            {userCanEdit && (
              <button
                type="button"
                onClick={() => startEditIncomeLine(line)}
                className={ROW_BTN}
                title={t('common.edit')}
                aria-label={t('common.edit')}
              >
                <Edit2 aria-hidden className="size-3.5" />
              </button>
            )}
            {userCanDelete && (
              <button
                type="button"
                onClick={() => deleteIncomeLine(line.id)}
                className={ROW_BTN_DANGER}
                title={t('common.delete')}
                aria-label={t('common.delete')}
              >
                <Trash2 aria-hidden className="size-3.5" />
              </button>
            )}
          </span>
        ),
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[13.5px] font-semibold text-foreground">{t('income.detailTitle')}</h3>
          {savingIncomeLines && <span className="text-[12px] text-text-3">{t('common.saving')}</span>}
        </div>
        <p className="mt-0.5 text-[12.5px] text-text-3">{t('income.detailHint')}</p>
      </div>

      <KpiStrip
        items={[
          { key: 'invoiced', label: t('income.invoiced'), value: incomeTotals.amount, format: 'money' },
          { key: 'received', label: t('income.received'), value: incomeTotals.received, format: 'money' },
          { key: 'pending', label: t('income.pendingAmount'), value: incomeTotals.pending, format: 'money' },
        ]}
      />

      {incomeByClient.length > 0 && (
        <details className="rounded-ui-md border border-border">
          <summary className="cursor-pointer select-none px-3 py-2.5 text-[13px] font-medium text-foreground">
            {t('income.byClient')}
          </summary>
          <ul className="divide-y divide-border border-t border-border">
            {incomeByClient.map(({ client, totals }) => (
              <li key={client} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2 text-[13px]">
                {/* groupByClient rotula en español los sin cliente; acá
                    se traduce para no filtrar ese literal a la UI. */}
                <span className="font-medium text-foreground">
                  {client === 'Sin asignar' ? t('income.unassignedClient') : client}
                </span>
                <span className="text-[12px] text-text-3">
                  {t('income.invoiced')} <Money value={totals.amount} /> · {t('income.received')}{' '}
                  <Money value={totals.received} /> · {t('income.pendingAmount')} <Money value={totals.pending} />
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="overflow-hidden rounded-ui-md border border-border">
        <FinTable
          columns={columns}
          rows={incomeLines}
          rowKey={(line) => line.id}
          caption={t('income.detailTitle')}
          empty={`${t('income.empty')}${userCanAdd ? ` ${t('income.emptyHint')}` : ''}`}
          footer={
            incomeLines.length > 0
              ? {
                  label: t('common.total'),
                  values: { amount: incomeTotals.amount, received: incomeTotals.received, pending: incomeTotals.pending },
                }
              : undefined
          }
        />
      </div>

      {userCanAdd && (
        <div>
          <h4 className="mb-3 flex items-center gap-2 text-[13.5px] font-semibold text-foreground">
            <Plus aria-hidden className="size-4" /> {t('income.addLine')}
          </h4>
          <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-6">
            <Field label={t('income.concept')} className="md:col-span-2">
              <Input
                aria-label={t('income.conceptAria')}
                value={newIncomeLine.concept}
                onChange={(e) => setNewIncomeLine((p) => ({ ...p, concept: e.target.value }))}
                placeholder={t('income.conceptPlaceholder')}
                className={INPUT_MOBILE}
              />
            </Field>
            <Field label={t('income.client')}>
              <Input
                aria-label={t('income.clientAria')}
                value={newIncomeLine.client}
                onChange={(e) => setNewIncomeLine((p) => ({ ...p, client: e.target.value }))}
                placeholder={t('income.clientPlaceholder')}
                className={INPUT_MOBILE}
              />
            </Field>
            <Field label={t('income.invoiced')}>
              <Input
                type="number"
                step="0.01"
                aria-label={t('income.amountAria')}
                value={newIncomeLine.amount}
                onChange={(e) => setNewIncomeLine((p) => ({ ...p, amount: e.target.value }))}
                placeholder={t('income.invoiced')}
                className={INPUT_NUM}
              />
            </Field>
            <Field label={t('income.received')}>
              <Input
                type="number"
                step="0.01"
                aria-label={t('income.receivedAria')}
                value={newIncomeLine.received}
                onChange={(e) => setNewIncomeLine((p) => ({ ...p, received: e.target.value }))}
                placeholder={t('income.received')}
                className={INPUT_NUM}
              />
            </Field>
            <button
              type="button"
              onClick={addIncomeLine}
              disabled={!newIncomeLine.concept || !newIncomeLine.amount || savingIncomeLines || periodIsClosed}
              className={btnClass('secondary')}
            >
              {savingIncomeLines ? t('common.saving') : t('common.add')}
            </button>
          </div>
          <p className="mt-2 text-[12px] text-text-3">
            {t('income.pendingAmount')}:{' '}
            <Money
              value={computeIncomePending(newIncomeLine.amount, newIncomeLine.received, newIncomeLine.pending)}
            />
          </p>
        </div>
      )}
    </div>
  );
}
