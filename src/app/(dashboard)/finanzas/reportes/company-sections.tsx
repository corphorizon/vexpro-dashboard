'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Secciones del reporte para una empresa de servicios ('company').
//
// Las del broker (depósitos, retiros, P&L, prop firm) no aplican y las dos que
// quedaban en pie —balances por canal y usuarios del CRM— no le decían nada a
// una consultora. Acá las cuatro preguntas que sí tiene: a quién le facturé,
// qué gasté, qué quedó y dónde está la plata.
//
// Todo sale de datos que ya existen: las líneas de ingreso del endpoint de
// facturación, los egresos del data-context, la cadena de distribución y el
// libro de cada ubicación. Nada se recalcula acá: los números los arma
// src/lib/reports/company-report.ts, que es el mismo objeto que se exporta a
// CSV y a PDF.
//
// ── «LIBRO MAYOR» (2026-10-12) ────────────────────────────────────────────
//   · Cada sección es un `Panel` con su `KpiStrip` arriba y su `FinTable`
//     al ras (antes: `Card` + 3 `StatCard` con color por tarjeta + tabla a
//     mano). Los totales del pie son los de company-report.ts, no sumas de
//     la pantalla.
//   · Color = significado: «Cobrado» ya no va en verde ni «Por cobrar» en
//     ámbar por ser montos; el resultado de caja y el saldo a favor sí
//     llevan signo de color (`sign`), porque ahí el signo es la noticia.
//   · «Dónde está el dinero» con la semántica de Balances: Total neto es el
//     hero; Prestado es plata de la empresa que NO es caja (sin color);
//     Deuda con terceros aparece sólo si hay, NEGATIVA (pasivo, `neg`) y con
//     la definición del glosario; el pie del panel repite los avisos de
//     Balances (`cash.lentNotice` / `cash.owedNotice`). La tabla agrupa por
//     unidad con el subtotal NETO de `groupByUnit` (antes la unidad era una
//     columna más y no había subtotal).
//   · Dos lecturas que fallaban EN SILENCIO ahora se dicen:
//       - la facturación (`/api/admin/income-lines`): el catch dejaba `[]`,
//         y la sección decía «No se facturó nada en este período» — falso.
//         Ahora `billingFailed` y un Notice `bad`; los montos de facturación
//         se muestran «—» (el objeto del reporte, y por lo tanto el CSV/PDF,
//         no cambia: ver DESCARTADO).
//       - la clasificación de ubicaciones (tipo / unidad / a quién se le
//         prestó): sin ella todo cae al tipo por defecto y una deuda se lee
//         como disponible. Notice `pend` con esa consecuencia.
//   Medido antes/después en este archivo: 0 clases de paleta cruda (ya no
//   había); 29 tokens legados (`text-positive`, `text-warning`,
//   `text-negative`, `muted-foreground`, `bg-muted`) → 0.
//
// DESCARTADO:
//   · Meter `billingFailed` dentro de `CompanyReport`: ese objeto es el mismo
//     que va al CSV y al PDF (company-report.ts) y la tanda no cambia
//     exportes. Queda anotado como duda en el reporte de la migración.
//   · Cascada con `buildCloseWaterfall`: este reporte nunca la usó; el
//     resultado son tres cifras de la cadena, no un desglose.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Panel } from '@/components/ui/panel';
import { Notice } from '@/components/ui/notice';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { InfoTip } from '@/components/ui/info-tip';
import { apiFetch } from '@/lib/api-fetch';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { GLOSSARY } from '@/lib/glossary';
import { formatMoney } from '@/lib/money';
import { periodLabel } from '@/lib/utils';
import { cardsFromLines } from '@/lib/clients';
import type { IncomeLine } from '@/lib/income-lines';
import type { ChannelConfigRow } from '@/lib/channel-configs';
import {
  DEFAULT_LOCATION_TYPE,
  LOCATION_TYPE_LABELS,
  normalizeLocationType,
  signedBalance,
  type AllocatedLocation,
  type BusinessUnit,
  type CashLocation,
} from '@/lib/cash-locations';
import {
  UNASSIGNED_CLIENT_KEY,
  UNCATEGORIZED,
  buildBilling,
  buildCash,
  buildExpenses,
  buildResult,
  formatShare,
  periodsInRange,
  type BillingClientRow,
  type CompanyReport,
  type ExpenseCategoryRow,
} from '@/lib/reports/company-report';

interface ChannelBalanceRow {
  key: string;
  label: string;
  amount: number;
}

export interface CompanyReportState {
  /** `null` mientras carga la facturación — el resto ya está en memoria. */
  report: CompanyReport | null;
  /** La facturación no se pudo leer: los montos de facturación del reporte son 0 por falta de dato, no por no haber facturado. */
  billingFailed: boolean;
  /** La clasificación de ubicaciones no se pudo leer: todas quedan con el tipo por defecto. */
  classificationFailed: boolean;
}

/**
 * Arma el reporte de la empresa para el rango elegido. `report` es `null`
 * mientras carga la facturación — el resto ya está en memoria.
 */
export function useCompanyReport(
  from: string,
  to: string,
  channels: ChannelBalanceRow[],
  enabled: boolean,
): CompanyReportState {
  const { periods, getPeriodSummary, computeSaldoChain } = useData();

  const [lines, setLines] = useState<IncomeLine[] | null>(null);
  const [billingFailed, setBillingFailed] = useState(false);
  const [configRows, setConfigRows] = useState<ChannelConfigRow[]>([]);
  const [units, setUnits] = useState<BusinessUnit[]>([]);
  const [classificationFailed, setClassificationFailed] = useState(false);

  // Sin `period_id` el endpoint devuelve el histórico completo; el recorte al
  // rango se hace acá, así cambiar de fechas no vuelve a pegarle a la red.
  // Si falla, el reporte se sigue armando con `[]` (el CSV/PDF no cambian),
  // pero `billingFailed` lo avisa: «no se facturó nada» sería falso.
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    apiFetch('/api/admin/income-lines')
      .then((res) => res.json())
      .then((json: { success?: boolean; lines?: IncomeLine[] }) => {
        if (!alive) return;
        setLines(json?.success ? json.lines ?? [] : []);
        setBillingFailed(!json?.success);
      })
      .catch(() => {
        if (!alive) return;
        setLines([]);
        setBillingFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [enabled]);

  // La clasificación de cada ubicación (tipo, unidad, a quién se le prestó)
  // es de administración: quien no la tenga ve igual los saldos, con el tipo
  // por defecto — mejor eso que esconderle dónde está la plata. Pero se avisa:
  // con el tipo por defecto, una deuda se lee como disponible.
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let failed = false;
    Promise.all([
      apiFetch('/api/admin/channel-configs')
        .then((res) => res.json())
        .then((json: { success?: boolean; rows?: ChannelConfigRow[] }) => {
          if (!json?.success) failed = true;
          return json?.rows ?? [];
        })
        .catch(() => {
          failed = true;
          return [] as ChannelConfigRow[];
        }),
      apiFetch('/api/admin/business-units')
        .then((res) => res.json())
        .then((json: { success?: boolean; units?: BusinessUnit[] }) => {
          if (!json?.success) failed = true;
          return json?.units ?? [];
        })
        .catch(() => {
          failed = true;
          return [] as BusinessUnit[];
        }),
    ]).then(([rows, us]) => {
      if (!alive) return;
      setConfigRows(rows);
      setUnits(us);
      setClassificationFailed(failed);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);

  const covered = useMemo(() => periodsInRange(periods, from, to), [periods, from, to]);

  const report = useMemo(() => {
    if (!enabled || lines === null) return null;

    const coveredIds = new Set(covered.map((p) => p.id));
    const meta = new Map(
      covered.map((p) => [p.id, { label: p.label || periodLabel(p.year, p.month), order: p.year * 12 + p.month }]),
    );

    const cards = cardsFromLines(
      lines
        .filter((l) => coveredIds.has(l.period_id))
        .map((l) => {
          const m = meta.get(l.period_id);
          return { ...l, periodLabel: m?.label ?? '—', periodOrder: m?.order ?? 0 };
        }),
    );

    const expenses = covered.flatMap((p) => getPeriodSummary(p.id)?.expenses ?? []);

    const chain = computeSaldoChain();
    const chainSlices = covered
      .map((p) => chain.get(p.id))
      .filter((s): s is NonNullable<typeof s> => !!s);

    const billing = buildBilling(cards);
    const expenseReport = buildExpenses(expenses);

    const rowByKey = new Map(configRows.map((r) => [r.channel_key, r]));
    const locations: CashLocation[] = channels.map((c) => {
      const row = rowByKey.get(c.key);
      return {
        channel_key: c.key,
        label: c.label,
        location_type: row?.location_type
          ? normalizeLocationType(row.location_type)
          : DEFAULT_LOCATION_TYPE,
        business_unit_id: row?.business_unit_id ?? null,
        // Sin esto el reparto no llegaba hasta acá y `groupByUnit` atribuía la
        // ubicación entera a su unidad principal: el total cerraba pero el
        // desglose por unidad mentía, y contradecía a /balances (auditoría
        // 2026-08, B1). Viene en la misma fila del endpoint de configuración.
        unit_shares: row?.unit_shares ?? null,
        holder: row?.holder ?? null,
        is_visible: true,
        sort_order: row?.sort_order ?? 0,
        balance: c.amount,
      };
    });

    return {
      range: { from, to },
      periods: covered.map((p) => ({ id: p.id, label: p.label || periodLabel(p.year, p.month) })),
      billing,
      expenses: expenseReport,
      result: buildResult(billing.collected, expenseReport.paid, chainSlices),
      cash: buildCash(locations, units),
    };
  }, [enabled, lines, covered, channels, configRows, units, from, to, getPeriodSummary, computeSaldoChain]);

  return { report, billingFailed, classificationFailed };
}

// ─── Render ──────────────────────────────────────────────────────────────

interface CashRow extends AllocatedLocation {
  rowKey: string;
  unitKey: string;
}

const NO_UNIT = '__none__';

export function CompanyReportSections({
  report,
  billingFailed = false,
  classificationFailed = false,
}: {
  report: CompanyReport;
  billingFailed?: boolean;
  classificationFailed?: boolean;
}) {
  const { t, locale } = useI18n();
  const { company } = useData();
  const lang = locale === 'en' ? 'en' : 'es';
  const currency = company?.currency || 'USD';
  const money = (n: number) => formatMoney(n, { currency });

  const periodsLabel = report.periods.map((p) => p.label).join(' · ');
  // Sin facturación leída, sus montos no son cero: son «no lo sabemos».
  const billed = (n: number) => (billingFailed ? null : n);

  // ── Facturación ──
  const billingKpis: KpiItem[] = [
    {
      key: 'pending',
      label: t('companyReports.pending'),
      value: billed(report.billing.pending),
      format: 'money',
      currency,
      hero: true,
      sub: billingFailed
        ? undefined
        : t('companyReports.clientsWithDebt', {
            count: String(report.billing.withDebt),
            total: String(report.billing.clientCount),
          }),
    },
    { key: 'billed', label: t('companyReports.billed'), value: billed(report.billing.billed), format: 'money', currency },
    {
      key: 'collected',
      label: t('companyReports.collected'),
      value: billed(report.billing.collected),
      format: 'money',
      currency,
    },
  ];
  const billingColumns: FinColumn<BillingClientRow>[] = [
    {
      key: 'client',
      header: t('companyReports.client'),
      cell: (c) => (c.key === UNASSIGNED_CLIENT_KEY ? t('companyReports.unassignedClient') : c.name),
    },
    { key: 'billed', header: t('companyReports.billed'), kind: 'money', value: (c) => c.billed, money: { currency }, hideSm: true },
    {
      key: 'collected',
      header: t('companyReports.collected'),
      kind: 'money',
      value: (c) => c.collected,
      money: { currency },
      hideSm: true,
    },
    { key: 'pending', header: t('companyReports.pending'), kind: 'money', value: (c) => c.pending, money: { currency } },
  ];

  // ── Egresos ──
  const expenseKpis: KpiItem[] = [
    {
      key: 'total',
      label: t('companyReports.expensesTotal'),
      value: report.expenses.total,
      format: 'money',
      currency,
      hero: true,
    },
    { key: 'paid', label: t('companyReports.expensesPaid'), value: report.expenses.paid, format: 'money', currency },
    {
      key: 'pending',
      label: t('companyReports.expensesPending'),
      value: report.expenses.pending,
      format: 'money',
      currency,
    },
  ];
  const expenseColumns: FinColumn<ExpenseCategoryRow>[] = [
    {
      key: 'category',
      header: t('companyReports.category'),
      cell: (c) => (c.category === UNCATEGORIZED ? t('companyReports.uncategorized') : c.category),
      meta: (c) => t('companyReports.lm.expenseCount', { count: String(c.count) }),
    },
    { key: 'count', header: '#', kind: 'number', value: (c) => c.count, hideSm: true },
    {
      key: 'amount',
      header: t('companyReports.expensesTotal'),
      kind: 'money',
      value: (c) => c.amount,
      money: { currency },
    },
    {
      key: 'pending',
      header: t('companyReports.expensesPending'),
      kind: 'money',
      value: (c) => c.pending,
      money: { currency },
      hideSm: true,
    },
  ];

  // ── Resultado ──
  const resultKpis: KpiItem[] = [
    {
      key: 'cash',
      label: t('companyReports.cashResult'),
      value: billed(report.result.cashResult),
      format: 'money',
      currency,
      tone: 'sign',
      hero: true,
      sub: t('companyReports.cashResultHint'),
    },
    {
      key: 'saldo',
      label: t('companyReports.saldoAFavor'),
      value: report.result.saldoAFavor,
      format: 'money',
      currency,
      tone: 'sign',
      sub: t('companyReports.saldoAFavorHint', {
        income: money(report.result.ingresosNetos),
        expenses: money(report.result.egresosNetos),
      }),
    },
    {
      key: 'distribute',
      label: t('companyReports.toDistribute'),
      value: report.result.montoDistribuir,
      format: 'money',
      currency,
      sub: t('companyReports.reserveHint', { amount: money(report.result.reserveThisPeriod) }),
    },
  ];

  // ── Dónde está el dinero (semántica de Balances) ──
  const s = report.cash.summary;
  const hasDebt = s.owed !== 0;
  const cashKpis: KpiItem[] = [
    {
      key: 'total',
      label: hasDebt ? t('companyReports.totalNet') : t('companyReports.totalCash'),
      value: s.total,
      format: 'money',
      currency,
      hero: true,
      sub: hasDebt ? t('cash.totalNetHint') : undefined,
    },
    {
      key: 'liquid',
      label: t('companyReports.available'),
      value: s.liquid,
      format: 'money',
      currency,
      sub: t('cash.availableHint'),
    },
    {
      key: 'lent',
      label: t('companyReports.lent'),
      value: s.lent,
      format: 'money',
      currency,
      sub: t('companyReports.lentHint'),
    },
    // Préstamos recibidos (2026-10-05): solo si hay. Pasivo → negativo.
    ...(hasDebt
      ? [
          {
            key: 'owed',
            label: (
              <span className="inline-flex items-center gap-1">
                {t('companyReports.owed')} <InfoTip text={GLOSSARY.deudaConTerceros} />
              </span>
            ),
            value: -s.owed,
            format: 'money' as const,
            currency,
            sub: t('companyReports.owedHint'),
          },
        ]
      : []),
  ];

  // La clave lleva la unidad: una ubicación compartida sale una vez por
  // unidad dueña y con solo `channel_key` React veía dos filas con la misma
  // clave.
  const cashRows: CashRow[] = report.cash.byUnit.flatMap((group) =>
    group.locations.map((l) => ({
      ...l,
      unitKey: group.unit?.id ?? NO_UNIT,
      rowKey: `${group.unit?.id ?? 'none'}-${l.channel_key}`,
    })),
  );
  const unitNames = new Map(report.cash.byUnit.map((g) => [g.unit?.id ?? NO_UNIT, g.unit?.name ?? null]));
  // Subtotal por unidad: el NETO que ya calcula `groupByUnit`, no una suma
  // de la pantalla.
  const unitTotals = Object.fromEntries(
    report.cash.byUnit.map((g) => [g.unit?.id ?? NO_UNIT, { balance: g.total }]),
  );
  const cashColumns: FinColumn<CashRow>[] = [
    {
      key: 'location',
      header: t('companyReports.location'),
      cell: (l) => l.label,
      meta: (l) => {
        const parts: string[] = [LOCATION_TYPE_LABELS[l.location_type][lang]];
        if (l.holder) parts.push(l.holder);
        if (l.share < 0.9999) {
          parts.push(t('cash.sharedLocation', { percent: formatShare(l.share), total: money(l.fullBalance) }));
        }
        return parts.join(' · ');
      },
    },
    {
      key: 'type',
      header: t('companyReports.locationType'),
      cell: (l) => <span className="text-text-2">{LOCATION_TYPE_LABELS[l.location_type][lang]}</span>,
      hideSm: true,
    },
    // Con signo: una deuda sale en negativo (`neg`) para que las filas
    // cierren contra el total (neto) del pie.
    {
      key: 'balance',
      header: t('companyReports.balance'),
      kind: 'money',
      value: (l) => signedBalance(l),
      money: { currency },
    },
  ];

  const cashNotes: React.ReactNode[] = [];
  if (s.lent !== 0) cashNotes.push(<p key="lent">{t('cash.lentNotice')}</p>);
  if (hasDebt) cashNotes.push(<p key="owed">{t('cash.owedNotice')}</p>);

  return (
    <>
      {/* Facturación */}
      {billingFailed && (
        <Notice kind="bad" title={t('companyReports.lm.billingFailedTitle')}>
          {t('companyReports.lm.billingFailedBody')}
        </Notice>
      )}
      <Panel flush title={t('companyReports.billingTitle')} hint={periodsLabel || t('companyReports.noPeriods')}>
        <div className="p-4">
          <KpiStrip items={billingKpis} />
        </div>
        {billingFailed ? null : report.billing.clients.length === 0 ? (
          <EmptyLine text={t('companyReports.noBilling')} />
        ) : (
          <FinTable
            columns={billingColumns}
            rows={report.billing.clients}
            rowKey={(c) => c.key}
            caption={t('companyReports.billingTitle')}
            footer={{
              label: t('common.total'),
              values: {
                billed: report.billing.billed,
                collected: report.billing.collected,
                pending: report.billing.pending,
              },
            }}
          />
        )}
      </Panel>

      {/* Egresos */}
      <Panel flush title={t('companyReports.expensesTitle')}>
        <div className="p-4">
          <KpiStrip items={expenseKpis} />
        </div>
        {report.expenses.categories.length === 0 ? (
          <EmptyLine text={t('companyReports.noExpenses')} />
        ) : (
          <FinTable
            columns={expenseColumns}
            rows={report.expenses.categories}
            rowKey={(c) => c.category}
            caption={t('companyReports.expensesTitle')}
            footer={{
              label: t('common.total'),
              values: { amount: report.expenses.total, pending: report.expenses.pending },
            }}
          />
        )}
      </Panel>

      {/* Resultado */}
      <Panel title={t('companyReports.resultTitle')}>
        <KpiStrip items={resultKpis} />
      </Panel>

      {/* Dónde está el dinero */}
      {classificationFailed && (
        <Notice kind="pend" title={t('companyReports.lm.classificationFailedTitle')}>
          {t('companyReports.lm.classificationFailedBody')}
        </Notice>
      )}
      <Panel
        flush
        title={t('companyReports.cashTitle')}
        footer={cashNotes.length > 0 ? <div className="space-y-1">{cashNotes}</div> : undefined}
      >
        <div className="p-4">
          <KpiStrip items={cashKpis} />
        </div>
        {report.cash.byType.length === 0 ? (
          <EmptyLine text={t('companyReports.noLocations')} />
        ) : (
          <FinTable
            columns={cashColumns}
            rows={cashRows}
            rowKey={(l) => l.rowKey}
            groupBy={(l) => l.unitKey}
            groupLabel={(k) => unitNames.get(k) ?? t('companyReports.noUnit')}
            groupTotals={unitTotals}
            caption={t('companyReports.cashTitle')}
            footer={{
              label: hasDebt ? t('companyReports.totalNet') : t('common.total'),
              values: { balance: s.total },
            }}
          />
        )}
      </Panel>
    </>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <p className="border-t border-border px-4 py-6 text-center text-[13px] text-text-3">{text}</p>;
}
