'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Tabla del tab Equipos — la fila propia del líder y, debajo, una fila por
// línea con el diferencial que cobra el líder («Libro mayor», spec §5.3).
//
// POR QUÉ (2026-10-12): la tabla vieja pintaba la fila del líder en violeta y
// el «Pago real» SIEMPRE en verde — también cuando era negativo, o sea cuando
// es DEUDA (§2.1 #1: `realPayment` sin clamp). Ahora:
//   · la jerarquía es estructura, no color: dos filas de grupo («Propio del
//     líder · 1», «Diferencial por línea · N») con su subtotal real;
//   · comisión y pago real en tono `sign` — un negativo se ve `neg`, nunca
//     verde, y nunca se lleva a 0;
//   · el pie dice la cuenta completa: total del grupo, + salario, − deuda
//     arrastrada, = total con salario (el mismo `totalWithSalary` del KPI).
//
// Los números llegan calculados desde page.tsx (`headOwnCalc`, `bdmCalcs`,
// `teamSummary`): este componente no suma ni resta nada salvo lo que FinTable
// muestra. Los subtotales de grupo se pasan explícitos (`groupTotals`) porque
// el buscador oculta filas y la suma de lo visible tendría cara de total.
//
// DESCARTADO: subtotales del Acumulado / División / Acc → Sig. — sumar
// acumulados de líneas distintas no es un número que alguien concilie.
// ─────────────────────────────────────────────────────────────────────────────

import { FinTable, type FinColumn, type FinTableFooter } from '@/components/ui/fin-table';
import { Money } from '@/components/ui/money';
import type { CommissionCalcResult } from '@/lib/commission-calculator';
import type { NetDepositSource } from '@/lib/hr/net-deposit-input';
import type { CommercialProfile } from '@/lib/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { NdInputCell, PctOverrideInput, PersonName, PlainTag, personMeta } from './commission-ui';

export type BdmCalc = CommissionCalcResult & {
  bdmOwnPct: number;
  bdmOwnPctAuto: number;
  diffPct: number;
  pctLinea: number | null;
};

export type TeamRow =
  | { kind: 'lead'; profile: CommercialProfile; calc: CommissionCalcResult }
  | { kind: 'line'; profile: CommercialProfile; calc: BdmCalc; hasOwnTeam: boolean };

/** Lectura/escritura de un insumo editable, tal como la expone page.tsx. */
export interface InputControls {
  display: (id: string) => string;
  change: (id: string, v: string) => void;
  source: (id: string) => NetDepositSource;
  auto: (id: string) => number | null;
}

export interface PctControls {
  display: (id: string) => string;
  change: (id: string, v: string) => void;
  disabled: boolean;
}

export interface TeamsTableProps {
  rows: TeamRow[];
  /** Filas que existen sin el buscador (si es mayor, FinTable lo avisa). */
  totalCount: number;
  nd: InputControls;
  /** El carril de ND de un Master IB (nunca `nd`: para un perfil PnL es su campo PnL). */
  masterNd: InputControls;
  pct: PctControls;
  liderEsBdm: boolean;
  headPctAuto: number;
  groupTotals: Partial<Record<TeamRow['kind'], { commission: number; realPayment: number }>>;
  totals: {
    teamTotalND: number;
    totalPayment: number;
    autoSalary: number;
    prevDebt: number;
    totalWithSalary: number;
  };
}

export function TeamsTable({
  rows,
  totalCount,
  nd,
  masterNd,
  pct,
  liderEsBdm,
  headPctAuto,
  groupTotals,
  totals,
}: TeamsTableProps) {
  const { t } = useI18n();
  const masterLabel = t('hr.masterIb');

  const columns: FinColumn<TeamRow>[] = [
    {
      key: 'name',
      header: t('common.name'),
      cell: (r) => (
        <PersonName
          profile={r.profile}
          tags={
            r.kind === 'line' ? (
              <>
                {r.hasOwnTeam && <PlainTag label={t('comm.hasTeamTag')} />}
                {r.profile.role === 'bdm_global' && <PlainTag label="GLOBAL" />}
              </>
            ) : null
          }
        />
      ),
      meta: (r) => personMeta(r.profile, masterLabel),
    },
    {
      key: 'nd',
      header: t('comm.ndCurrent'),
      align: 'right',
      cell: (r) => {
        // La línea de un master lee/escribe SU carril de ND — jamás `nd`.
        const c = r.kind === 'line' && r.profile.is_master_ib ? masterNd : nd;
        return (
          <NdInputCell
            value={c.display(r.profile.id)}
            onChange={(v) => c.change(r.profile.id, v)}
            source={c.source(r.profile.id)}
            auto={c.auto(r.profile.id)}
            ariaLabel={r.kind === 'lead' ? t('comm.ndHeadAria') : t('comm.ndProfileAria')}
          />
        );
      },
    },
    {
      key: 'accIn',
      header: t('comm.accumulated'),
      kind: 'money',
      value: (r) => r.calc.accumulatedIn,
      subtotal: false,
      hideSm: true,
    },
    {
      key: 'division',
      header: t('comm.division'),
      kind: 'money',
      value: (r) => r.calc.division,
      subtotal: false,
      hideSm: true,
    },
    {
      key: 'pct',
      header: '%',
      align: 'center',
      cardSide: 'left',
      cell: (r) => {
        if (r.kind === 'lead') {
          // Un head cobra su % pactado y no hay nada que editar; un BDM-líder
          // conserva sus tramos y su % manual del mes (en Individual ya no aparece).
          return liderEsBdm ? (
            <span className="inline-flex items-center gap-1">
              <PctOverrideInput
                value={pct.display(r.profile.id)}
                auto={headPctAuto}
                disabled={pct.disabled}
                onChange={(v) => pct.change(r.profile.id, v)}
              />
              <span className="text-[12px] text-text-3">{t('comm.pctBase')}</span>
            </span>
          ) : (
            <span className="tabular-nums">{r.calc.commissionPct}%</span>
          );
        }
        // Arriba el diferencial que cobra el líder (derivado); abajo el % BASE
        // de la línea, que es el editable. Un % pisado por `pct_linea` y uno
        // derivado NO se ven igual (§1.2): el pisado lleva etiqueta y peso.
        const pisado = r.calc.pctLinea !== null;
        return (
          <div className="flex flex-col items-center gap-0.5 py-0.5">
            <span
              className={cn('inline-flex items-center gap-1 tabular-nums', pisado ? 'font-semibold text-foreground' : 'text-text-2')}
              title={pisado ? t('comm.pctLineaHint') : undefined}
            >
              {r.calc.diffPct}%
              {pisado && <PlainTag label={t('comm.pctLineaTag')} />}
            </span>
            <span className="inline-flex items-center gap-1">
              <PctOverrideInput
                value={pct.display(r.profile.id)}
                auto={r.calc.bdmOwnPctAuto}
                disabled={pct.disabled}
                onChange={(v) => pct.change(r.profile.id, v)}
              />
              <span className="text-[12px] text-text-3">{t('comm.pctBase')}</span>
            </span>
          </div>
        );
      },
    },
    {
      key: 'commission',
      header: t('comm.commission'),
      kind: 'money',
      value: (r) => r.calc.commission,
      money: { tone: 'sign', signed: true },
      hideSm: true,
    },
    {
      key: 'realPayment',
      header: t('comm.realPayment'),
      kind: 'money',
      value: (r) => r.calc.realPayment,
      money: { tone: 'sign', signed: true },
    },
    {
      key: 'accOut',
      header: t('comm.accNext'),
      kind: 'money',
      value: (r) => r.calc.accumulatedOut,
      subtotal: false,
      hideSm: true,
    },
  ];

  const footerRows: FinTableFooter[] = [
    {
      label: t('comm.groupTotal'),
      values: { nd: totals.teamTotalND, commission: totals.totalPayment, realPayment: totals.totalPayment },
    },
  ];
  if (totals.autoSalary > 0) {
    footerRows.push({ label: t('comm.autoSalary'), values: { realPayment: totals.autoSalary } });
  }
  if (totals.prevDebt < 0) {
    footerRows.push({ label: t('comm.footPrevDebt'), values: { realPayment: totals.prevDebt } });
  }

  return (
    <FinTable<TeamRow>
      caption={t('comm.tabTeams')}
      columns={columns}
      rows={rows}
      rowKey={(r) => `${r.kind}:${r.profile.id}`}
      groupBy={(r) => r.kind}
      groupLabel={(k) => (k === 'lead' ? t('comm.groupLead') : t('comm.groupLines'))}
      groupTotals={groupTotals}
      totalCount={totalCount}
      footerRows={footerRows}
      footer={{ label: t('comm.totalWithSalary'), values: { realPayment: totals.totalWithSalary } }}
      empty={t('comm.noData')}
    />
  );
}

/** Para la tarjeta KPI: «$X − $Y deuda = $Z». */
export function DebtEquation({ raw, debt, total }: { raw: number; debt: number; total: number }) {
  const { t } = useI18n();
  return (
    <span>
      <Money value={raw} /> − <Money value={Math.abs(debt)} /> {t('comm.debtWord')} = <Money value={total} />
    </span>
  );
}
