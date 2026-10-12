'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Tablas del tab Individual — Net Deposit, PnL, PnL Especial y Comisión por
// lote («Libro mayor», spec §5.3).
//
// POR QUÉ (2026-10-12): eran cuatro `<table>` copiadas con 12 columnas a mano
// cada una, el «Pago real» siempre verde (también negativo = deuda, §2.1 #1),
// la deuda arrastrada en naranja dentro de la celda Total y el Total sin
// tono. Ahora:
//   · «Deuda arr.» es su propia columna (el `bonus` negativo del mes anterior,
//     §2.1 #6): se lee de un vistazo quién arrastra y cuánto; sin deuda, «—».
//   · Pago real y Total en tono `sign`: negativo = `neg`, nunca clampeado.
//   · El pie es el mismo de antes, con los MISMOS números (ver DESCARTADO).
//
// Cada fila llega ARMADA desde page.tsx (`prevDebt`, `total`, `finalReal`):
// las llamadas a `applyTotalEarnedDebt` siguen viviendo en page.tsx, al lado
// del guardado y del PDF, para que los tres sigan saliendo del mismo camino
// (invariante A3, reglas §2.1).
//
// DESCARTADO:
//   · Corregir el pie para que descuente la deuda: el «Total» del pie suma
//     `realPayment + salary` SIN deuda (así estaba) mientras cada fila muestra
//     el total CON deuda. Cambiarlo es cambiar un número — fuera del alcance
//     de esta tanda (sólo presentación). Queda reportado.
//   · Sticky de la primera columna: FinTable no lo trae y es `ui/`.
// ─────────────────────────────────────────────────────────────────────────────

import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money } from '@/components/ui/money';
import type { CommissionCalcResult, PnlSpecialCalcResult } from '@/lib/commission-calculator';
import type { CommercialProfile } from '@/lib/types';
import { useI18n } from '@/lib/i18n';
import {
  DebtCell,
  LotsBreakdown,
  NdInputCell,
  PctOverrideInput,
  PersonName,
  PlainTag,
  PnlCrmHint,
  personMeta,
} from './commission-ui';
import type { InputControls, PctControls } from './teams-table';

interface RowBase {
  profile: CommercialProfile;
  /** Nombre del head; `undefined` si su head no está en la lista. */
  headName: string | undefined;
  /** `bonus` del mes anterior (negativo = deuda). */
  prevDebt: number;
  /** Total CON deuda — `applyTotalEarnedDebt(...).finalTotalEarned`, calculado en page.tsx. */
  total: number;
}

export type NdRow = RowBase & { calc: CommissionCalcResult & { commissionPctAuto: number } };
export type PnlRow = RowBase & { calc: CommissionCalcResult; lotComm: number; finalReal: number };
export type PnlSpecialRow = RowBase & { calc: Omit<PnlSpecialCalcResult, 'profileId'> & { profileId: string } };

type PnlInfo = (id: string) => { usuariosRed: number | null; sinDatoCrm: boolean } | undefined;

function useNameColumns<R extends RowBase>(special = false): FinColumn<R>[] {
  const { t } = useI18n();
  const masterLabel = t('hr.masterIb');
  return [
    {
      key: 'name',
      header: t('common.name'),
      cell: (r) => (
        <PersonName
          profile={r.profile}
          tags={
            <>
              {r.profile.role === 'bdm_global' && <PlainTag label="GLOBAL" />}
              {special && <PlainTag label={t('comm.specialBadge')} />}
            </>
          }
        />
      ),
      meta: (r) => personMeta(r.profile, masterLabel),
    },
    {
      key: 'head',
      header: 'HEAD',
      hideSm: true,
      cell: (r) => <span className="text-text-2">{r.headName ?? '—'}</span>,
    },
  ];
}

const debtColumn = <R extends RowBase>(header: string): FinColumn<R> => ({
  key: 'debt',
  header,
  align: 'right',
  cardSide: 'right',
  hideSm: true,
  cell: (r) => <DebtCell prevDebt={r.prevDebt} />,
});

const totalColumn = <R extends RowBase>(header: string): FinColumn<R> => ({
  key: 'total',
  header,
  kind: 'money',
  value: (r) => r.total,
  money: { tone: 'sign', signed: true },
});

export interface IndTableCommon<R> {
  rows: R[];
  totalCount: number;
  nd: InputControls;
  renderActions: (row: R) => React.ReactNode;
}

// ── Net Deposit ─────────────────────────────────────────────────────────────

export function NdIndividualTable({
  rows,
  totalCount,
  nd,
  pct,
  renderActions,
  footer,
}: IndTableCommon<NdRow> & {
  pct: PctControls;
  footer: { nd: number; commission: number; realPayment: number; salary: number; total: number };
}) {
  const { t } = useI18n();
  const columns: FinColumn<NdRow>[] = [
    ...useNameColumns<NdRow>(),
    {
      key: 'nd',
      header: t('comm.ndCurrent'),
      align: 'right',
      cell: (r) => (
        <NdInputCell
          value={nd.display(r.profile.id)}
          onChange={(v) => nd.change(r.profile.id, v)}
          source={nd.source(r.profile.id)}
          auto={nd.auto(r.profile.id)}
          ariaLabel={t('comm.ndProfileAria')}
        />
      ),
    },
    { key: 'accIn', header: t('comm.accumulated'), kind: 'money', value: (r) => r.calc.accumulatedIn, hideSm: true },
    { key: 'division', header: t('comm.division'), kind: 'money', value: (r) => r.calc.division, hideSm: true },
    {
      key: 'pct',
      header: '%',
      align: 'center',
      cardSide: 'left',
      // Vacío = automático (el placeholder lo muestra); un valor —0 incluido— manda este mes.
      cell: (r) => (
        <PctOverrideInput
          value={pct.display(r.profile.id)}
          auto={r.calc.commissionPctAuto}
          disabled={pct.disabled}
          onChange={(v) => pct.change(r.profile.id, v)}
        />
      ),
    },
    { key: 'commission', header: t('comm.commission'), kind: 'money', value: (r) => r.calc.commission, money: { tone: 'sign', signed: true }, hideSm: true },
    { key: 'realPayment', header: t('comm.realPayment'), kind: 'money', value: (r) => r.calc.realPayment, money: { tone: 'sign', signed: true }, hideSm: true },
    { key: 'salary', header: t('comm.salary'), kind: 'money', value: (r) => r.calc.salary, hideSm: true },
    debtColumn<NdRow>(t('comm.prevDebtCol')),
    totalColumn<NdRow>(t('comm.total')),
    { key: 'accOut', header: t('comm.accNext'), kind: 'money', value: (r) => r.calc.accumulatedOut, hideSm: true },
  ];
  return (
    <FinTable<NdRow>
      caption={t('comm.sectionND')}
      columns={columns}
      rows={rows}
      rowKey={(r) => r.profile.id}
      totalCount={totalCount}
      rowActions={renderActions}
      footer={{ label: t('comm.groupTotal'), values: footer }}
      empty={t('comm.noBdmsInSection')}
    />
  );
}

// ── PnL ─────────────────────────────────────────────────────────────────────

export function PnlIndividualTable({
  rows,
  totalCount,
  nd,
  lots,
  pnlInfo,
  renderActions,
  footer,
}: IndTableCommon<PnlRow> & {
  lots: InputControls;
  pnlInfo: PnlInfo;
  footer: { nd: number; realPayment: number; total: number };
}) {
  const { t } = useI18n();
  const columns: FinColumn<PnlRow>[] = [
    ...useNameColumns<PnlRow>(),
    {
      key: 'nd',
      header: 'PnL',
      align: 'right',
      cell: (r) => (
        <NdInputCell
          value={nd.display(r.profile.id)}
          onChange={(v) => nd.change(r.profile.id, v)}
          source={nd.source(r.profile.id)}
          auto={nd.auto(r.profile.id)}
          ariaLabel={t('comm.pnlAria')}
        >
          <PnlCrmHint info={pnlInfo(r.profile.id)} />
        </NdInputCell>
      ),
    },
    {
      key: 'lots',
      header: t('comm.lotCommShort'),
      align: 'right',
      hideSm: true,
      cell: (r) => (
        <NdInputCell
          value={lots.display(r.profile.id)}
          onChange={(v) => lots.change(r.profile.id, v)}
          source={lots.source(r.profile.id)}
          auto={lots.auto(r.profile.id)}
          ariaLabel={t('comm.lotCommShort')}
          width="w-24"
        />
      ),
    },
    { key: 'accIn', header: t('comm.accumulated'), kind: 'money', value: (r) => r.calc.accumulatedIn, hideSm: true },
    { key: 'division', header: t('comm.division'), kind: 'money', value: (r) => r.calc.division, hideSm: true },
    {
      key: 'pct',
      header: '%',
      align: 'center',
      hideSm: true,
      cell: (r) => <span className="tabular-nums">{r.calc.commissionPct}%</span>,
    },
    { key: 'commission', header: t('comm.commission'), kind: 'money', value: (r) => r.calc.commission, money: { tone: 'sign', signed: true }, hideSm: true },
    {
      key: 'realPayment',
      header: t('comm.realPayment'),
      kind: 'money',
      value: (r) => r.finalReal,
      money: { tone: 'sign', signed: true },
      hideSm: true,
      cell: (r) => (
        <div className="flex flex-col items-end">
          <Money value={r.finalReal} tone="sign" signed className="font-medium" />
          {r.lotComm > 0 && <LotsBreakdown base={r.calc.realPayment} lots={r.lotComm} />}
        </div>
      ),
    },
    debtColumn<PnlRow>(t('comm.prevDebtCol')),
    totalColumn<PnlRow>(t('comm.total')),
    { key: 'accOut', header: t('comm.accNext'), kind: 'money', value: (r) => r.calc.accumulatedOut, hideSm: true },
  ];
  return (
    <FinTable<PnlRow>
      caption={t('comm.sectionPnL')}
      columns={columns}
      rows={rows}
      rowKey={(r) => r.profile.id}
      totalCount={totalCount}
      rowActions={renderActions}
      footer={{ label: t('comm.groupTotal'), values: footer }}
      empty={t('comm.noBdmsInSection')}
    />
  );
}

// ── PnL Especial ────────────────────────────────────────────────────────────
// Columnas reducidas (sin División, Acumulado, Acc → Sig.): el modo Especial
// no acumula.

export function PnlSpecialTable({
  rows,
  totalCount,
  nd,
  lots,
  pnlInfo,
  renderActions,
  footer,
}: IndTableCommon<PnlSpecialRow> & {
  lots: InputControls;
  pnlInfo: PnlInfo;
  footer: { nd: number; realPayment: number; total: number };
}) {
  const { t } = useI18n();
  const columns: FinColumn<PnlSpecialRow>[] = [
    ...useNameColumns<PnlSpecialRow>(true),
    {
      key: 'nd',
      header: 'PnL',
      align: 'right',
      cell: (r) => (
        <NdInputCell
          value={nd.display(r.profile.id)}
          onChange={(v) => nd.change(r.profile.id, v)}
          source={nd.source(r.profile.id)}
          auto={nd.auto(r.profile.id)}
          ariaLabel={t('comm.pnlAria')}
        >
          <PnlCrmHint info={pnlInfo(r.profile.id)} />
        </NdInputCell>
      ),
    },
    {
      key: 'lots',
      header: t('comm.lotCommShort'),
      align: 'right',
      hideSm: true,
      cell: (r) => (
        <NdInputCell
          value={lots.display(r.profile.id)}
          onChange={(v) => lots.change(r.profile.id, v)}
          source={lots.source(r.profile.id)}
          auto={lots.auto(r.profile.id)}
          ariaLabel={t('comm.lotCommShort')}
          width="w-24"
        />
      ),
    },
    {
      key: 'pct',
      header: '%',
      align: 'center',
      hideSm: true,
      cell: (r) => <span className="tabular-nums">{r.calc.commissionPct}%</span>,
    },
    { key: 'commission', header: t('comm.commission'), kind: 'money', value: (r) => r.calc.commission, money: { tone: 'sign', signed: true }, hideSm: true },
    {
      key: 'realPayment',
      header: t('comm.realPayment'),
      kind: 'money',
      value: (r) => r.calc.realPayment,
      money: { tone: 'sign', signed: true },
      hideSm: true,
      cell: (r) => (
        <div className="flex flex-col items-end">
          <Money value={r.calc.realPayment} tone="sign" signed className="font-medium" />
          {r.calc.lotCommissions > 0 && <LotsBreakdown base={r.calc.commission} lots={r.calc.lotCommissions} />}
        </div>
      ),
    },
    debtColumn<PnlSpecialRow>(t('comm.prevDebtCol')),
    totalColumn<PnlSpecialRow>(t('comm.total')),
  ];
  return (
    <FinTable<PnlSpecialRow>
      caption={t('comm.sectionPnLSpecial')}
      columns={columns}
      rows={rows}
      rowKey={(r) => r.profile.id}
      totalCount={totalCount}
      rowActions={renderActions}
      footer={{ label: t('comm.groupTotal'), values: footer }}
      empty={t('comm.noBdmsInSection')}
    />
  );
}

// ── Comisión por lote ───────────────────────────────────────────────────────
// Sólo informativa: la comisión no se calcula acá (columna «—», como antes).

export interface LotRow {
  profile: CommercialProfile;
  headName: string | undefined;
}

export function LotTable({ rows, totalCount }: { rows: LotRow[]; totalCount: number }) {
  const { t } = useI18n();
  const masterLabel = t('hr.masterIb');
  const columns: FinColumn<LotRow>[] = [
    {
      key: 'name',
      header: t('common.name'),
      cell: (r) => (
        <PersonName profile={r.profile} tags={r.profile.role === 'bdm_global' ? <PlainTag label="GLOBAL" /> : null} />
      ),
      meta: (r) => personMeta(r.profile, masterLabel),
    },
    {
      key: 'head',
      header: 'HEAD',
      hideSm: true,
      cell: (r) => <span className="text-text-2">{r.headName ?? '—'}</span>,
    },
    // `commission_per_lot` no es null acá (la lista ya filtra por != null);
    // si lo fuera, Money muestra «—», nunca $0.
    {
      key: 'perLot',
      header: t('comm.usdPerLot'),
      kind: 'money',
      value: (r) => r.profile.commission_per_lot,
      subtotal: false,
    },
    {
      key: 'commission',
      header: t('comm.commission'),
      align: 'right',
      hideSm: true,
      cell: () => <span className="text-text-3">—</span>,
    },
  ];
  return (
    <FinTable<LotRow>
      caption={t('comm.sectionLot')}
      columns={columns}
      rows={rows}
      rowKey={(r) => r.profile.id}
      totalCount={totalCount}
      empty={t('comm.noBdmsInSection')}
    />
  );
}
