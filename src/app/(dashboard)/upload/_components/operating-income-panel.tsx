'use client';

import { Save } from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { Field, Input } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { useI18n } from '@/lib/i18n';
import { ClosedBadge, INPUT_NUM, btnClass } from './upload-ui';

// ─────────────────────────────────────────────────────────────────────────────
// Pestaña Ingresos operativos de /upload — SÓLO presentación (ver
// deposits-panel.tsx).
//
// POR QUÉ (2026-10-12, migración «Libro mayor»): «Otros», el detalle por
// concepto (IncomeLinesSection, que entra como `children`), Prop Firm y el
// total vivían en un IIFE de 150 líneas dentro de page.tsx. Las cuentas
// (`propFirmWithdrawal`, `propFirmNet`, `totalIngresos`) SIGUEN en page.tsx:
// acá llegan hechas. Un número de dinero sale de un solo lugar.
//
// El Broker P&L ya no se teclea (Kevin, 2026-08-31 — ver el comentario largo
// en page.tsx): esta pantalla muestra el total de lo que ELLA carga.
//
// Prop Firm lleva la etiqueta «manual · pendiente Orion CRM» como badge
// neutro (antes `text-[10px] bg-muted/50`): es una fuente, no un estado.
// El resultado de Prop Firm se pinta `neg` sólo si es negativo (Money 'auto'):
// ahí el signo SÍ es la noticia.
//
// DESCARTADO: convertir «Total ingresos» en una franja de KPIs — es un único
// número con su fórmula debajo; una franja de un solo KPI es una tarjeta.
// ─────────────────────────────────────────────────────────────────────────────

export interface OperatingIncomePanelProps {
  periodLabel: string;
  closed: boolean;
  /** Puede cargar (canAdd). */
  editable: boolean;
  other: {
    /** true = se teclea (sin detalle cargado). Con detalle es DERIVADO del servidor. */
    editable: boolean;
    /** Valor del input (income.other). */
    value: number;
    /** Lo que se muestra cuando no es editable (lo cobrado del detalle, o `other`). */
    display: number;
    /** Hay detalle cargado: «Otros» sale de la suma de lo cobrado. */
    fromDetail: boolean;
    onChange: (raw: string) => void;
  };
  /** El detalle por concepto (IncomeLinesSection). */
  children: React.ReactNode;
  propFirm: {
    show: boolean;
    sales: number;
    withdrawal: number;
    net: number;
    onSalesChange: (raw: string) => void;
    onWithdrawalChange: (raw: string) => void;
  };
  total: number;
  onSave: () => void;
}

export function OperatingIncomePanel({
  periodLabel,
  closed,
  editable,
  other,
  children,
  propFirm,
  total,
  onSave,
}: OperatingIncomePanelProps) {
  const { t } = useI18n();
  return (
    <Panel
      title={t('upload.operatingIncome')}
      hint={periodLabel}
      actions={closed ? <ClosedBadge /> : undefined}
      flush
    >
      <div className="divide-y divide-border">
        {/* "Otros ingresos" con detalle cargado es un campo DERIVADO: el
            servidor lo sobreescribe con la suma de lo cobrado en cada
            guardado del detalle, así que editarlo a mano se perdería. */}
        <div className="p-4">
          {other.editable ? (
            <Field label={t('upload.other')} className="sm:max-w-xs">
              <Input
                type="number"
                step="0.01"
                value={other.value || ''}
                disabled={closed}
                onChange={(e) => other.onChange(e.target.value)}
                className={INPUT_NUM}
                placeholder="0.00"
              />
            </Field>
          ) : (
            <div>
              <p className="text-[12.5px] font-medium text-text-2">{t('upload.other')}</p>
              <Money value={other.display} className="text-[18px] font-semibold" />
              {other.fromDetail && <p className="mt-0.5 text-[12px] text-text-3">{t('income.otherFromDetail')}</p>}
            </div>
          )}
        </div>

        <div className="p-4">{children}</div>

        {/* Prop Firm — carga manual mientras el endpoint del CRM Orion no
            esté vivo. El neto entra al total de abajo. Espejo de los mismos
            campos de Depósitos (ventas) y Retiros (retiros), con el mismo
            estado. */}
        {propFirm.show && (
          <div className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[13.5px] font-semibold text-foreground">Prop Firm</h3>
              <StatusBadge kind="neutral" label={t('upload.manualPendingCrm')} />
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {editable ? (
                <Field label={t('movements.propFirmSales')}>
                  <Input
                    type="number"
                    step="0.01"
                    value={propFirm.sales || ''}
                    disabled={closed}
                    onChange={(e) => propFirm.onSalesChange(e.target.value)}
                    className={INPUT_NUM}
                    placeholder="0.00"
                  />
                </Field>
              ) : (
                <ReadAmount label={t('movements.propFirmSales')} value={propFirm.sales} />
              )}
              {editable ? (
                <Field label={t('movements.propFirmWithdrawals')}>
                  <Input
                    type="number"
                    step="0.01"
                    value={propFirm.withdrawal || ''}
                    disabled={closed}
                    onChange={(e) => propFirm.onWithdrawalChange(e.target.value)}
                    className={INPUT_NUM}
                    placeholder="0.00"
                  />
                </Field>
              ) : (
                <ReadAmount label={t('movements.propFirmWithdrawals')} value={propFirm.withdrawal} />
              )}
            </div>
            <p className="flex items-baseline justify-end gap-2 text-[13px]">
              <span className="text-text-2">{t('upload.propFirmResult')}:</span>
              <Money value={propFirm.net} className="font-semibold" />
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-end justify-between gap-3 p-4 shadow-[inset_0_1.5px_0_0_var(--foreground)]">
          <div>
            <p className="text-[12.5px] font-medium text-text-2">{t('upload.totalIncome')}</p>
            <Money value={total} className="text-[22px] font-semibold tracking-[-0.02em]" />
            <p className="mt-0.5 text-[12px] text-text-3">{t('upload.totalIncomeFormula')}</p>
          </div>
          {editable && (
            <button type="button" onClick={onSave} disabled={closed} className={btnClass('secondary')}>
              <Save aria-hidden className="size-4" />
              {t('upload.saveIncomeBtn')}
            </button>
          )}
        </div>
      </div>
    </Panel>
  );
}

function ReadAmount({ label, value }: { label: React.ReactNode; value: number }) {
  return (
    <div>
      <p className="text-[12.5px] font-medium text-text-2">{label}</p>
      <Money value={value} className="text-[18px] font-semibold" />
    </div>
  );
}
