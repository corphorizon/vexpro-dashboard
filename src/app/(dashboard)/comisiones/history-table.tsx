'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Tabla del tab Historial — el total GUARDADO de cada persona por mes
// («Libro mayor», spec §5.3).
//
// POR QUÉ (2026-10-12): cada celda iba en verde por ser ≥ 0 — y TODAS lo son,
// porque el Historial muestra los meses negativos como $0 (ver abajo): una
// tabla entera en verde, el color dejando de significar algo (spec §2.1: «un
// número no se pinta de verde por ser positivo en una columna donde todos son
// positivos»). Ahora van sin color. El corte por rol (una raya de 2 px entre
// Sales Manager / HEAD / BDM) es una fila de grupo con conteo.
//
// El «negativo se muestra como $0» NO es de este componente: lo decide
// `getTotal` en page.tsx («solo visualización», así desde antes). Como es una
// exclusión, el pie del panel lo dice con palabras (reglas §1.2: lo que se
// excluye se avisa).
//
// DESCARTADO:
//   · Subtotales por rol: la columna de cada mes tiene huecos (meses sin
//     registro = «—», §1.3) y un subtotal por grupo sumaría con «N sin dato»
//     en casi todas las filas de grupo. Los totales por mes están en el pie,
//     calculados sobre TODOS los perfiles (no sólo los visibles).
//   · Primera columna sticky al scrollear: FinTable no la trae (ui/, otra
//     tanda). La tabla scrollea horizontal en su contenedor.
// ─────────────────────────────────────────────────────────────────────────────

import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import type { CommercialProfile, Period } from '@/lib/types';
import { useI18n } from '@/lib/i18n';
import { PersonName, PlainTag, personMeta } from './commission-ui';
import { historyGroupKey, historyGroupLabel, periodLabel } from './commission-view';

export interface HistoryTableProps {
  rows: CommercialProfile[];
  totalCount: number;
  periods: Period[];
  /** Total guardado (negativos ya mostrados como 0 por page.tsx); `null` = sin registro. */
  getTotal: (profileId: string, periodId: string) => number | null;
  getProfileTotal: (profileId: string) => number;
  monthTotals: Record<string, number>;
  grandTotal: number;
}

export function HistoryTable({
  rows,
  totalCount,
  periods,
  getTotal,
  getProfileTotal,
  monthTotals,
  grandTotal,
}: HistoryTableProps) {
  const { t } = useI18n();
  const masterLabel = t('hr.masterIb');
  const columns: FinColumn<CommercialProfile>[] = [
    {
      key: 'name',
      header: t('common.name'),
      width: '200px',
      cell: (p) => (
        <PersonName
          profile={p}
          tags={
            <>
              {p.role === 'bdm_global' && <PlainTag label="GLOBAL" />}
              {p.pnl_special_mode && <PlainTag label={t('comm.specialBadge')} />}
            </>
          }
        />
      ),
      meta: (p) => personMeta(p, masterLabel),
    },
    ...periods.map(
      (per): FinColumn<CommercialProfile> => ({
        key: `p:${per.id}`,
        header: periodLabel(per),
        kind: 'money',
        value: (p) => getTotal(p.id, per.id),
        subtotal: false,
        hideSm: true,
      }),
    ),
    {
      key: 'total',
      header: t('comm.totalAll'),
      kind: 'money',
      value: (p) => getProfileTotal(p.id),
      subtotal: false,
    },
  ];

  const footerValues: Record<string, number> = { total: grandTotal };
  for (const per of periods) footerValues[`p:${per.id}`] = monthTotals[per.id];

  return (
    <FinTable<CommercialProfile>
      caption={t('comm.tabHistory')}
      columns={columns}
      rows={rows}
      rowKey={(p) => p.id}
      groupBy={(p) => historyGroupKey(p.role)}
      groupLabel={historyGroupLabel}
      totalCount={totalCount}
      footer={{ label: t('comm.total'), values: footerValues }}
    />
  );
}
