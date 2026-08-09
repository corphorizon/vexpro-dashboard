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
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Banknote, Receipt, Scale, Users } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { apiFetch } from '@/lib/api-fetch';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { formatCurrency, periodLabel } from '@/lib/utils';
import { cardsFromLines } from '@/lib/clients';
import type { IncomeLine } from '@/lib/income-lines';
import type { ChannelConfigRow } from '@/lib/channel-configs';
import {
  DEFAULT_LOCATION_TYPE,
  LOCATION_TYPE_LABELS,
  normalizeLocationType,
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
  periodsInRange,
  type CompanyReport,
} from '@/lib/reports/company-report';

interface ChannelBalanceRow {
  key: string;
  label: string;
  amount: number;
}

/**
 * Arma el reporte de la empresa para el rango elegido. Devuelve `null`
 * mientras carga la facturación — el resto ya está en memoria.
 */
export function useCompanyReport(
  from: string,
  to: string,
  channels: ChannelBalanceRow[],
  enabled: boolean,
): CompanyReport | null {
  const { periods, getPeriodSummary, computeSaldoChain } = useData();

  const [lines, setLines] = useState<IncomeLine[] | null>(null);
  const [configRows, setConfigRows] = useState<ChannelConfigRow[]>([]);
  const [units, setUnits] = useState<BusinessUnit[]>([]);

  // Sin `period_id` el endpoint devuelve el histórico completo; el recorte al
  // rango se hace acá, así cambiar de fechas no vuelve a pegarle a la red.
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    apiFetch('/api/admin/income-lines')
      .then((res) => res.json())
      .then((json: { success?: boolean; lines?: IncomeLine[] }) => {
        if (alive) setLines(json?.success ? json.lines ?? [] : []);
      })
      .catch(() => {
        if (alive) setLines([]);
      });
    return () => {
      alive = false;
    };
  }, [enabled]);

  // La clasificación de cada ubicación (tipo, unidad, a quién se le prestó)
  // es de administración: quien no la tenga ve igual los saldos, con el tipo
  // por defecto — mejor eso que esconderle dónde está la plata.
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    Promise.all([
      apiFetch('/api/admin/channel-configs')
        .then((res) => res.json())
        .then((json: { success?: boolean; rows?: ChannelConfigRow[] }) => json?.rows ?? [])
        .catch(() => [] as ChannelConfigRow[]),
      apiFetch('/api/admin/business-units')
        .then((res) => res.json())
        .then((json: { success?: boolean; units?: BusinessUnit[] }) => json?.units ?? [])
        .catch(() => [] as BusinessUnit[]),
    ]).then(([rows, us]) => {
      if (!alive) return;
      setConfigRows(rows);
      setUnits(us);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);

  const covered = useMemo(() => periodsInRange(periods, from, to), [periods, from, to]);

  return useMemo(() => {
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
}

// ─── Render ──────────────────────────────────────────────────────────────

export function CompanyReportSections({ report }: { report: CompanyReport }) {
  const { t, locale } = useI18n();
  const { company } = useData();
  const lang = locale === 'en' ? 'en' : 'es';
  const money = (n: number) => formatCurrency(n, company?.currency || 'USD');

  const periodsLabel = report.periods.map((p) => p.label).join(' · ');

  return (
    <>
      {/* Facturación */}
      <Card>
        <SectionHeader
          icon={<Users className="w-5 h-5 text-muted-foreground" />}
          title={t('companyReports.billingTitle')}
          aside={periodsLabel || t('companyReports.noPeriods')}
        />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
          <StatCard label={t('companyReports.billed')} value={money(report.billing.billed)} tone="info" />
          <StatCard
            label={t('companyReports.collected')}
            value={money(report.billing.collected)}
            tone="positive"
          />
          <StatCard
            label={t('companyReports.pending')}
            value={money(report.billing.pending)}
            tone={report.billing.pending > 0 ? 'warning' : 'neutral'}
            hint={t('companyReports.clientsWithDebt', {
              count: String(report.billing.withDebt),
              total: String(report.billing.clientCount),
            })}
          />
        </div>
        {report.billing.clients.length === 0 ? (
          <EmptyLine text={t('companyReports.noBilling')} />
        ) : (
          <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="text-left py-2.5 px-3 font-medium">{t('companyReports.client')}</th>
                  <th className="text-right py-2.5 px-3 font-medium">{t('companyReports.billed')}</th>
                  <th className="text-right py-2.5 px-3 font-medium">{t('companyReports.collected')}</th>
                  <th className="text-right py-2.5 px-3 font-medium">{t('companyReports.pending')}</th>
                </tr>
              </thead>
              <tbody>
                {report.billing.clients.map((c) => (
                  <tr key={c.key} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                    <td className="px-3 py-2">
                      {c.key === UNASSIGNED_CLIENT_KEY ? t('companyReports.unassignedClient') : c.name}
                    </td>
                    <td className="px-3 py-2 text-right font-medium">{money(c.billed)}</td>
                    <td className="px-3 py-2 text-right text-positive">{money(c.collected)}</td>
                    <td className={`px-3 py-2 text-right ${c.pending > 0 ? 'text-warning' : ''}`}>
                      {money(c.pending)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-muted/30 font-bold">
                <tr className="border-t border-border">
                  <td className="px-3 py-2">{t('common.total')}</td>
                  <td className="px-3 py-2 text-right">{money(report.billing.billed)}</td>
                  <td className="px-3 py-2 text-right">{money(report.billing.collected)}</td>
                  <td className="px-3 py-2 text-right">{money(report.billing.pending)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      {/* Egresos */}
      <Card>
        <SectionHeader
          icon={<Receipt className="w-5 h-5 text-muted-foreground" />}
          title={t('companyReports.expensesTitle')}
        />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
          <StatCard label={t('companyReports.expensesTotal')} value={money(report.expenses.total)} tone="neutral" />
          <StatCard label={t('companyReports.expensesPaid')} value={money(report.expenses.paid)} tone="positive" />
          <StatCard
            label={t('companyReports.expensesPending')}
            value={money(report.expenses.pending)}
            tone={report.expenses.pending > 0 ? 'warning' : 'neutral'}
          />
        </div>
        {report.expenses.categories.length === 0 ? (
          <EmptyLine text={t('companyReports.noExpenses')} />
        ) : (
          <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="text-left py-2.5 px-3 font-medium">{t('companyReports.category')}</th>
                  <th className="text-right py-2.5 px-3 font-medium">#</th>
                  <th className="text-right py-2.5 px-3 font-medium">{t('companyReports.expensesTotal')}</th>
                  <th className="text-right py-2.5 px-3 font-medium">{t('companyReports.expensesPending')}</th>
                </tr>
              </thead>
              <tbody>
                {report.expenses.categories.map((c) => (
                  <tr key={c.category} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                    <td className="px-3 py-2">
                      {c.category === UNCATEGORIZED ? t('companyReports.uncategorized') : c.category}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{c.count}</td>
                    <td className="px-3 py-2 text-right font-medium">{money(c.amount)}</td>
                    <td className={`px-3 py-2 text-right ${c.pending > 0 ? 'text-warning' : ''}`}>
                      {money(c.pending)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-muted/30 font-bold">
                <tr className="border-t border-border">
                  <td className="px-3 py-2" colSpan={2}>
                    {t('common.total')}
                  </td>
                  <td className="px-3 py-2 text-right">{money(report.expenses.total)}</td>
                  <td className="px-3 py-2 text-right">{money(report.expenses.pending)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      {/* Resultado */}
      <Card>
        <SectionHeader
          icon={<Scale className="w-5 h-5 text-muted-foreground" />}
          title={t('companyReports.resultTitle')}
        />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard
            label={t('companyReports.cashResult')}
            value={money(report.result.cashResult)}
            tone={report.result.cashResult >= 0 ? 'positive' : 'negative'}
            hint={t('companyReports.cashResultHint')}
          />
          <StatCard
            label={t('companyReports.saldoAFavor')}
            value={money(report.result.saldoAFavor)}
            tone={report.result.saldoAFavor >= 0 ? 'positive' : 'negative'}
            hint={t('companyReports.saldoAFavorHint', {
              income: money(report.result.ingresosNetos),
              expenses: money(report.result.egresosNetos),
            })}
          />
          <StatCard
            label={t('companyReports.toDistribute')}
            value={money(report.result.montoDistribuir)}
            tone="primary"
            hint={t('companyReports.reserveHint', { amount: money(report.result.reserveThisPeriod) })}
          />
        </div>
      </Card>

      {/* Dónde está el dinero */}
      <Card>
        <SectionHeader
          icon={<Banknote className="w-5 h-5 text-muted-foreground" />}
          title={t('companyReports.cashTitle')}
        />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
          <StatCard label={t('companyReports.available')} value={money(report.cash.summary.liquid)} tone="positive" />
          <StatCard
            label={t('companyReports.lent')}
            value={money(report.cash.summary.lent)}
            tone={report.cash.summary.lent > 0 ? 'warning' : 'neutral'}
            hint={t('companyReports.lentHint')}
          />
          <StatCard label={t('companyReports.totalCash')} value={money(report.cash.summary.total)} tone="primary" />
        </div>
        {report.cash.byType.length === 0 ? (
          <EmptyLine text={t('companyReports.noLocations')} />
        ) : (
          <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="text-left py-2.5 px-3 font-medium">{t('companyReports.location')}</th>
                  <th className="text-left py-2.5 px-3 font-medium">{t('companyReports.locationType')}</th>
                  <th className="text-left py-2.5 px-3 font-medium">{t('companyReports.unit')}</th>
                  <th className="text-right py-2.5 px-3 font-medium">{t('companyReports.balance')}</th>
                </tr>
              </thead>
              <tbody>
                {report.cash.byUnit.flatMap((group) =>
                  group.locations.map((l) => (
                    <tr key={l.channel_key} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                      <td className="px-3 py-2">
                        {l.label}
                        {l.holder && <span className="text-xs text-muted-foreground"> · {l.holder}</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {LOCATION_TYPE_LABELS[l.location_type][lang]}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {group.unit?.name ?? t('companyReports.noUnit')}
                      </td>
                      <td className={`px-3 py-2 text-right font-medium ${l.balance < 0 ? 'text-negative' : ''}`}>
                        {money(l.balance)}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
              <tfoot className="bg-muted/30 font-bold">
                <tr className="border-t border-border">
                  <td className="px-3 py-2" colSpan={3}>
                    {t('common.total')}
                  </td>
                  <td className="px-3 py-2 text-right text-positive">{money(report.cash.summary.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function SectionHeader({ icon, title, aside }: { icon: React.ReactNode; title: string; aside?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-4">
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>
      {aside && <span className="text-xs text-muted-foreground truncate">{aside}</span>}
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground py-6 text-center">{text}</p>;
}
