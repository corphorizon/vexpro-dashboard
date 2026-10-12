'use client';

import { Plus, Save, Trash2 } from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Field, Input, Select } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { ALL_WITHDRAWAL_CATEGORIES, withdrawalCategoryLabel } from '@/lib/withdrawal-categories';
import { formatMoney } from '@/lib/money';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  ClosedBadge,
  INPUT_MOBILE,
  INPUT_NUM,
  ROW_BTN,
  ROW_BTN_DANGER,
  SideAmountField,
  SourceBadge,
  btnClass,
} from './upload-ui';
import {
  withdrawalRowFlags,
  withdrawalsFormTotal,
  type WithdrawalAutoContext,
  type WithdrawalLike,
} from './withdrawals-view';

// ─────────────────────────────────────────────────────────────────────────────
// Pestaña Retiros de /upload — SÓLO presentación (ver deposits-panel.tsx).
//
// POR QUÉ (2026-10-12, migración «Libro mayor»): además de bajar page.tsx,
// esta es la pestaña donde conviven el número tecleado y el automático (broker
// derivado de las APIs, IB del espejo del CRM). Antes se distinguían con un
// «auto» de 10 px en verde — verde es «ganancia» (§2.1) y 10 px no se lee.
// Ahora es una etiqueta de fuente `info` (SourceBadge), y lo que el automático
// aporta va como metadato 12 px bajo el input.
//
// El total del pie y las banderas de fila salen de `withdrawals-view.ts`,
// copiados del JSX viejo y fijados con test: el pie no se movió.
//
// Retiros adicionales: panel propio con su formulario y su tabla. El alta
// (`onAddExtra`) y el borrado (`onRemoveExtra`) son el mismo código que estaba
// inline en page.tsx; el estado del formulario (`newExtra`) sigue allá.
//
// DESCARTADO: pintar los montos de retiro en `neg`. Toda la columna son
// salidas; el rojo no agregaría información (§2.1: el color va cuando el signo
// es la noticia). Antes el total y los extras iban en `text-red-600`.
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtraWithdrawalView {
  id: string;
  category: string;
  amount: number;
  description: string;
}

export type ExtraCategory = 'ib_commissions' | 'broker' | 'prop_firm' | 'other';

export interface NewExtraWithdrawal {
  category: ExtraCategory;
  amount: string;
  description: string;
}

export interface WithdrawalsPanelProps {
  rows: WithdrawalLike[];
  periodLabel: string;
  closed: boolean;
  editable: boolean;
  savingIds: ReadonlySet<string>;
  auto: WithdrawalAutoContext;
  onAmountChange: (id: string, raw: string) => void;
  onSaveRow: (id: string, amount: number) => void;
  p2p: { amount: number; crmHint: number | null; onChange: (raw: string) => void };
  extras: ExtraWithdrawalView[];
  newExtra: NewExtraWithdrawal;
  setNewExtra: React.Dispatch<React.SetStateAction<NewExtraWithdrawal>>;
  onAddExtra: () => void;
  onRemoveExtra: (id: string) => void;
}

export function WithdrawalsPanel(props: WithdrawalsPanelProps) {
  return (
    <div className="space-y-4">
      <WithdrawalsTable {...props} />
      <ExtraWithdrawalsPanel {...props} />
    </div>
  );
}

function WithdrawalsTable({
  rows,
  periodLabel,
  closed,
  editable,
  savingIds,
  auto,
  onAmountChange,
  onSaveRow,
  p2p,
}: WithdrawalsPanelProps) {
  const { t } = useI18n();
  const total = withdrawalsFormTotal(rows, auto);

  const columns: FinColumn<WithdrawalLike>[] = [
    {
      key: 'category',
      header: t('upload.category'),
      cell: (w) => {
        const { isBrokerAutoRow, isIbAutoRow } = withdrawalRowFlags(w, auto);
        return (
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{withdrawalCategoryLabel(w.category, t)}</span>
            {(isBrokerAutoRow || isIbAutoRow) && (
              <SourceBadge
                source="auto"
                title={isIbAutoRow ? t('upload.ledger.ibAutoTitle') : t('upload.ledger.brokerAutoTitle')}
              />
            )}
          </span>
        );
      },
    },
    {
      key: 'amount',
      header: t('upload.amountUsd'),
      kind: 'money',
      width: '14rem',
      value: (w) => w.amount,
      cell: (w) => {
        if (!editable) return <Money value={w.amount} className="font-medium" />;
        const { isBrokerAutoRow, isIbAutoRow } = withdrawalRowFlags(w, auto);
        return (
          <div className="flex flex-col items-end gap-0.5">
            <Input
              type="number"
              step="0.01"
              aria-label={`${t('upload.amountUsd')} · ${withdrawalCategoryLabel(w.category, t)}`}
              value={w.amount || ''}
              disabled={savingIds.has(w.id) || closed}
              onChange={(e) => onAmountChange(w.id, e.target.value)}
              className={cn(INPUT_NUM, 'disabled:cursor-progress')}
              placeholder="0.00"
            />
            {/* Broker en período derivado: el monto de la API va AL LADO del
                manual. Conviven: en /movimientos el broker = derivado + este
                input. */}
            {isBrokerAutoRow && (
              <span className="text-[12px] leading-[1.3] text-text-3">
                + API {formatMoney(auto.derivedBrokerAmount)} (auto)
              </span>
            )}
            {isIbAutoRow && (
              <span className="text-[12px] leading-[1.3] text-text-3">
                {t('upload.ibFromCrm', { amount: formatMoney(auto.ibEffective.value) })}
              </span>
            )}
          </div>
        );
      },
    },
  ];
  if (editable) {
    columns.push({
      key: 'save',
      header: <span className="sr-only">{t('common.actions')}</span>,
      width: '3.5rem',
      align: 'right',
      cardSide: 'right',
      cell: (w) => {
        const saving = savingIds.has(w.id);
        return (
          <button
            type="button"
            onClick={() => onSaveRow(w.id, w.amount)}
            disabled={saving || closed}
            className={cn(ROW_BTN, 'disabled:cursor-progress')}
            title={saving ? t('common.saving') : t('common.save')}
            aria-label={t('upload.ledger.saveRow', { name: withdrawalCategoryLabel(w.category, t) })}
            aria-busy={saving}
          >
            <Save aria-hidden className={cn('size-4', saving && 'animate-pulse motion-reduce:animate-none')} />
          </button>
        );
      },
    });
  }

  // Las notas que explican el número automático: un número que aparece solo,
  // sin que nadie lo haya tecleado, tiene que decir de dónde vino y qué NO
  // cambia por su culpa.
  const notes = [
    auto.brokerIsDerived ? t('upload.brokerCoexistNote') : null,
    auto.ibEffective.source === 'api' ? t('upload.ibSplitNote') : null,
  ].filter((n): n is string => n != null);

  return (
    <Panel
      title={t('upload.withdrawals')}
      hint={periodLabel}
      actions={closed ? <ClosedBadge /> : undefined}
      flush
      footer={
        notes.length > 0 ? (
          <div className="space-y-1">
            {notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        ) : undefined
      }
    >
      <FinTable
        columns={columns}
        rows={rows}
        rowKey={(w) => w.id}
        caption={t('upload.withdrawals')}
        footer={{ label: t('common.total'), values: { amount: total } }}
      />
      {/* Transferencias P2P: campo aparte, NO suma al total de arriba. */}
      <div className="border-t border-border px-4 py-3">
        <SideAmountField
          label={t('upload.p2pTransfers')}
          hint={t('upload.notInWithdrawalsTotal')}
          crmHint={p2p.crmHint}
          editable={editable}
          value={p2p.amount}
          disabled={closed}
          onChange={p2p.onChange}
        />
      </div>
    </Panel>
  );
}

// Retiros adicionales manuales: entradas libres que conviven con lo que
// reportan las APIs. Se guardan con `description` no nula en `withdrawals`,
// así se listan aparte de los 4 agregados fijos.
function ExtraWithdrawalsPanel({
  editable,
  extras,
  newExtra,
  setNewExtra,
  onAddExtra,
  onRemoveExtra,
}: WithdrawalsPanelProps) {
  const { t } = useI18n();
  const canSubmit = Boolean(newExtra.description.trim()) && parseFloat(newExtra.amount) > 0;

  const columns: FinColumn<ExtraWithdrawalView>[] = [
    {
      key: 'category',
      header: t('upload.category'),
      cell: (w) => <span className="text-text-2">{withdrawalCategoryLabel(w.category, t)}</span>,
    },
    {
      key: 'description',
      header: t('upload.description'),
      cell: (w) => <span className="text-foreground">{w.description}</span>,
    },
    { key: 'amount', header: t('common.amount'), kind: 'money', value: (w) => w.amount },
  ];
  if (editable) {
    columns.push({
      key: 'actions',
      header: <span className="sr-only">{t('audit.action')}</span>,
      width: '3.5rem',
      align: 'right',
      cardSide: 'right',
      cell: (w) => (
        <button
          type="button"
          onClick={() => onRemoveExtra(w.id)}
          className={ROW_BTN_DANGER}
          title={t('common.delete')}
          aria-label={`${t('common.delete')} · ${w.description}`}
        >
          <Trash2 aria-hidden className="size-4" />
        </button>
      ),
    });
  }

  return (
    <Panel title={t('upload.extraWithdrawalsTitle')} hint={t('upload.extraWithdrawalsDesc')} flush>
      {editable && (
        <div className="grid grid-cols-1 items-end gap-3 border-b border-border p-4 md:grid-cols-5">
          <Field label={t('upload.category')}>
            <Select
              value={newExtra.category}
              onChange={(e) => setNewExtra((p) => ({ ...p, category: e.target.value as typeof p.category }))}
              className={INPUT_MOBILE}
            >
              {/* Del registro único: eran cuatro <option> escritas a mano,
                  con el mismo orden que /movimientos tenía en otra lista. */}
              {ALL_WITHDRAWAL_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {withdrawalCategoryLabel(cat, t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('upload.description')} className="md:col-span-2">
            <Input
              type="text"
              value={newExtra.description}
              onChange={(e) => setNewExtra((p) => ({ ...p, description: e.target.value }))}
              placeholder={t('upload.withdrawalDescPlaceholder')}
              className={INPUT_MOBILE}
            />
          </Field>
          <Field label={t('common.amount')}>
            <Input
              type="number"
              step="0.01"
              value={newExtra.amount}
              onChange={(e) => setNewExtra((p) => ({ ...p, amount: e.target.value }))}
              placeholder={t('upload.amountPlaceholder')}
              className={INPUT_NUM}
            />
          </Field>
          <button type="button" onClick={onAddExtra} disabled={!canSubmit} className={btnClass('secondary')}>
            <Plus aria-hidden className="size-4" /> {t('common.add')}
          </button>
        </div>
      )}
      {extras.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-text-3">
          {editable ? t('upload.extraWithdrawalsEmptyAdd') : t('upload.extraWithdrawalsEmpty')}
        </p>
      ) : (
        <FinTable
          columns={columns}
          rows={extras}
          rowKey={(w) => w.id}
          caption={t('upload.extraWithdrawalsTitle')}
          footer={{ label: t('upload.totalExtras'), values: { amount: extras.reduce((s, w) => s + w.amount, 0) } }}
        />
      )}
    </Panel>
  );
}
