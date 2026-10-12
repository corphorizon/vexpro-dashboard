'use client';

import { Save } from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Input } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { CHANNEL_LABELS } from '@/lib/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ClosedBadge, INPUT_NUM, ROW_BTN, SideAmountField } from './upload-ui';

// ─────────────────────────────────────────────────────────────────────────────
// Pestaña Depósitos de /upload — SÓLO presentación.
//
// POR QUÉ (2026-10-12, migración «Libro mayor»): page.tsx tenía 3.913 líneas
// con las seis pestañas inline. Esta pieza no tiene estado ni efectos: recibe
// las filas y los callbacks del padre, que son el MISMO código que estaba en
// los `onChange`/`onClick` del JSX (ver page.tsx). El estado, el guardado por
// fila (`updateDeposit`), el dirty-tracking y el autosave no se movieron.
//
// Lo que cambió a la vista:
//   · tabla → <FinTable> (cabecera 11.5 MAYÚSCULAS, filas 36 px, tarjeta en
//     < 720 px) con el total en el pie de doble raya, en gris: antes iba en
//     azul, y un total de una columna de positivos no se pinta (§2.1);
//   · input de monto → <Input> de la primitiva (36 px, borde control-border,
//     el foco global — antes `focus:ring-accent` propio);
//   · botón guardar → ícono gris de fila (antes verde esmeralda crudo).
//
// DESCARTADO: mover el botón de guardar a `rowActions` de FinTable — allí
// aparece sólo al hover y es la ÚNICA forma de guardar una fila sin esperar
// el autosave; va en una columna propia, siempre visible.
// ─────────────────────────────────────────────────────────────────────────────

export interface DepositRowView {
  id: string;
  channel: string;
  amount: number;
}

export interface DepositsPanelProps {
  rows: DepositRowView[];
  periodLabel: string;
  /** Período cerrado: inputs y botones apagados. */
  closed: boolean;
  /** Puede cargar (canAdd): inputs en vez de montos de lectura. */
  editable: boolean;
  /** Filas con un guardado en vuelo. */
  savingIds: ReadonlySet<string>;
  /** Texto crudo del input de la fila. */
  onAmountChange: (id: string, raw: string) => void;
  onSaveRow: (id: string, amount: number) => void;
  propFirm: {
    amount: number;
    crmHint: number | null;
    onChange: (raw: string) => void;
  };
}

export function DepositsPanel({
  rows,
  periodLabel,
  closed,
  editable,
  savingIds,
  onAmountChange,
  onSaveRow,
  propFirm,
}: DepositsPanelProps) {
  const { t } = useI18n();
  const total = rows.reduce((s, d) => s + d.amount, 0);

  const columns: FinColumn<DepositRowView>[] = [
    {
      key: 'channel',
      header: t('upload.channel'),
      cell: (d) => <span className="font-medium text-foreground">{CHANNEL_LABELS[d.channel]}</span>,
    },
    {
      key: 'amount',
      header: t('upload.amountUsd'),
      kind: 'money',
      width: '12rem',
      value: (d) => d.amount,
      cell: (d) =>
        editable ? (
          <Input
            type="number"
            step="0.01"
            aria-label={`${t('upload.amountUsd')} · ${CHANNEL_LABELS[d.channel] ?? d.channel}`}
            value={d.amount || ''}
            disabled={savingIds.has(d.id) || closed}
            onChange={(e) => onAmountChange(d.id, e.target.value)}
            className={cn(INPUT_NUM, 'disabled:cursor-progress')}
            placeholder="0.00"
          />
        ) : (
          <Money value={d.amount} className="font-medium" />
        ),
    },
  ];
  if (editable) {
    columns.push({
      key: 'save',
      header: <span className="sr-only">{t('common.actions')}</span>,
      width: '3.5rem',
      align: 'right',
      cardSide: 'right',
      cell: (d) => {
        const saving = savingIds.has(d.id);
        return (
          <button
            type="button"
            onClick={() => onSaveRow(d.id, d.amount)}
            disabled={saving || closed}
            className={cn(ROW_BTN, 'disabled:cursor-progress')}
            title={saving ? t('common.saving') : t('common.save')}
            aria-label={t('upload.ledger.saveRow', { name: CHANNEL_LABELS[d.channel] ?? d.channel })}
            aria-busy={saving}
          >
            <Save aria-hidden className={cn('size-4', saving && 'animate-pulse motion-reduce:animate-none')} />
          </button>
        );
      },
    });
  }

  return (
    <Panel
      title={t('upload.deposits')}
      hint={periodLabel}
      actions={closed ? <ClosedBadge /> : undefined}
      flush
    >
      <FinTable
        columns={columns}
        rows={rows}
        rowKey={(d) => d.id}
        caption={t('upload.deposits')}
        footer={{ label: t('common.total'), values: { amount: total } }}
      />
      {/* Ventas Prop Firm: campo aparte, NO suma al total de arriba. */}
      <div className="border-t border-border px-4 py-3">
        <SideAmountField
          label={t('movements.propFirmSales')}
          hint={t('upload.notInDepositsTotal')}
          crmHint={propFirm.crmHint}
          editable={editable}
          value={propFirm.amount}
          disabled={closed}
          onChange={propFirm.onChange}
        />
      </div>
    </Panel>
  );
}
