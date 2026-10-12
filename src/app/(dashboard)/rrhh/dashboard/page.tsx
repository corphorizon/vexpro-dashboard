'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { Notice } from '@/components/ui/notice';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { NUM_CLASS, moneyText } from '@/components/ui/money';
import { PeriodSelector } from '@/components/period-selector';
import { usePeriod } from '@/lib/period-context';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { features } from '@/lib/business-model';
import { hrRoleLabel } from '@/lib/hr/domain';
import { mesDePeriodo } from '@/lib/hr/period-filter';
import { HrPeriodProvider, useHrPeriod } from '../_components/hr-period-context';
import { alertsKpi, headcount, payrollOfPeriod, teamNetKpi } from '../_components/hr-view';

// ─────────────────────────────────────────────────────────────────────────────
// /rrhh/dashboard — resumen del módulo («Libro mayor», 2026-10-12).
//
// Qué cambió (sólo presentación; ningún número se calcula distinto):
//   · Cuatro StatCard con ícono de color → UNA franja de KPIs: headcount,
//     nómina del período (hero), net deposit del equipo y alertas del mes.
//   · Net deposit del equipo y alertas son NUEVOS en esta pantalla y salen del
//     MISMO overview que las pestañas de /rrhh (HrPeriodProvider, con el mes
//     del período elegido acá). Si el slice `net` no llegó, el KPI es «—» con
//     badge `stale` y un aviso arriba lo dice — nunca $0 (reglas §1.3).
//   · Nómina: con CERO filas guardadas en el período el total era $0.00; ahora
//     es «—» + «sin calcular» y un aviso con el enlace a /comisiones. Un mes que
//     nadie calculó no es un mes que pagó cero.
//   · Top performers y equipos en FinTable; el rol es metadato gris bajo el
//     nombre (antes tres colores de badge por rol, que no significaban nada:
//     spec §2.1). El ND del equipo se pinta por signo — ahí el signo SÍ es la
//     noticia.
//
// Medición (sin comentarios, script de conteo de la tanda): antes 24 clases de
// paleta cruda, 8 `dark:` de color, 3 `text-[10px]`, 14 tokens legados y 5
// `?? 0`; después 0 / 0 / 0 / 0 y 2 `?? 0` acá (el conteo por departamento
// y el ND personal del head, intactos) + 2 movidos a hr-view.ts
// (`payrollOfPeriod`, la misma suma de antes). Ninguno nuevo.
//
// DESCARTADO:
//   · Sumar el ND guardado (`net_deposit_current`) de todos los perfiles como
//     «net del equipo»: los heads aparecen en la fila de su propio grupo Y en la
//     de su sales manager, y la suma contaría dos veces. El overview ya trae el
//     total atribuido a la estructura, calculado una vez (RPC).
//   · Quitar el PeriodSelector del contenido (spec §6.2): las pantallas
//     migradas lo conservan hasta que la topbar lo absorba.
// ─────────────────────────────────────────────────────────────────────────────

// recharts (~350KB) on-demand — mismo patrón PERF-03 de resumen-general.
const chartLoading = () => <div className="flex h-[260px] items-center justify-center text-[13px] text-text-3">…</div>;
const PayrollTrendChart = dynamic(
  () => import('@/components/charts/hr-charts').then((m) => m.PayrollTrendChart),
  { ssr: false, loading: chartLoading },
);
const EmployeePayrollChart = dynamic(
  () => import('@/components/charts/hr-charts').then((m) => m.EmployeePayrollChart),
  { ssr: false, loading: chartLoading },
);
const DepartmentDonut = dynamic(
  () => import('@/components/charts/hr-charts').then((m) => m.DepartmentDonut),
  { ssr: false, loading: chartLoading },
);

type TopRow = { key: string; rank: number; name: string; role: string; commission: number; nd: number };
type TeamRow = {
  id: string;
  name: string;
  role: string;
  membersCount: number;
  teamND: number;
  teamCommissions: number;
};

const countFmt = (n: number) => String(n);

export default function DashboardPage() {
  const { t } = useI18n();
  const { selectedPeriodId } = usePeriod();
  const { company, commercialProfiles, employees, getResultsByPeriod, getProfilesByHead, periods, monthlyResults } =
    useData();

  // Sin equipo comercial no hay perfiles, comisiones, top performers ni
  // equipos: RRHH es la ficha de empleados y nada más.
  const { commercialTeam } = features(company?.business_model);

  // ─── Employee stats ───
  const empStats = useMemo(() => {
    const active = employees.filter((e) => e.status === 'active');
    // Group by department
    const deptMap = new Map<string, number>();
    for (const e of active) {
      const dept = e.department || 'Sin departamento';
      deptMap.set(dept, (deptMap.get(dept) ?? 0) + 1);
    }
    const departments = [...deptMap.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
    // Nómina mensual comprometida: el sueldo de quien está trabajando hoy
    // (el período de prueba se cobra igual).
    const monthlySalaries = employees
      .filter((e) => e.status !== 'inactive')
      .reduce((sum, e) => sum + (Number(e.salary) || 0), 0);
    return { departments, monthlySalaries };
  }, [employees]);

  const people = useMemo(() => headcount(employees, commercialProfiles), [employees, commercialProfiles]);

  // ─── Period results ───
  const periodResults = useMemo(() => {
    if (!selectedPeriodId) return [];
    return getResultsByPeriod(selectedPeriodId);
  }, [selectedPeriodId, getResultsByPeriod]);

  const payroll = useMemo(() => payrollOfPeriod(periodResults), [periodResults]);

  // ─── Top performers (by real_payment this period) ───
  const topPerformers = useMemo<TopRow[]>(() => {
    return periodResults
      .filter((r) => r.real_payment > 0)
      .sort((a, b) => b.real_payment - a.real_payment)
      .slice(0, 5)
      .map((r, i) => {
        const profile = commercialProfiles.find((p) => p.id === r.profile_id);
        return {
          key: `${r.profile_id}-${r.head_id ?? ''}-${i}`,
          rank: i + 1,
          name: profile?.name ?? '—',
          role: profile?.role ?? 'bdm',
          commission: r.real_payment,
          nd: r.net_deposit_current,
        };
      });
  }, [periodResults, commercialProfiles]);
  const withPayment = useMemo(() => periodResults.filter((r) => r.real_payment > 0).length, [periodResults]);

  // ─── Team summary (HEAD teams) ───
  const teamSummary = useMemo<TeamRow[]>(() => {
    const headProfiles = commercialProfiles.filter(
      (p) => (p.role === 'head' || p.role === 'sales_manager') && p.status === 'active',
    );
    return headProfiles
      .map((head) => {
        const members = getProfilesByHead(head.id).filter((p) => p.status === 'active');
        // HEAD's own result in their OWN team context (head_id = their own id)
        const headResult = periodResults.find((r) => r.profile_id === head.id && r.head_id === head.id);
        // Sum ND and commissions from direct team members
        let teamND = 0;
        let teamCommissions = 0;
        for (const m of members) {
          const mr = periodResults.find((r) => r.profile_id === m.id && r.head_id === head.id);
          if (mr) {
            teamND += mr.net_deposit_current;
            teamCommissions += mr.real_payment;
          }
        }
        // Include HEAD's own personal ND
        if (headResult) {
          // If HEAD has parent, their personal ND is in net_deposit_accumulated
          // If HEAD has no parent, it's in net_deposit_current
          const headPersonalND = head.head_id
            ? (headResult.net_deposit_accumulated ?? 0)
            : headResult.net_deposit_current;
          teamND += headPersonalND;
          teamCommissions += headResult.real_payment;
        }
        return {
          id: head.id,
          name: head.name,
          role: head.role,
          membersCount: members.length + 1,
          teamND,
          teamCommissions,
        };
      })
      .sort((a, b) => b.teamND - a.teamND);
  }, [commercialProfiles, getProfilesByHead, periodResults]);

  // El overview del mes del PERÍODO elegido arriba (no el «mes anterior» por
  // defecto de /rrhh): los cuatro KPIs hablan del mismo mes.
  const selectedPeriod = periods.find((p) => p.id === selectedPeriodId) ?? null;
  const month = selectedPeriod ? mesDePeriodo(selectedPeriod) : undefined;

  const topColumns: FinColumn<TopRow>[] = [
    {
      key: 'rank',
      header: '#',
      width: '48px',
      cell: (r) => <span className={`${NUM_CLASS} text-text-3`}>{r.rank}</span>,
      hideSm: true,
    },
    {
      key: 'name',
      header: t('common.name'),
      cell: (r) => r.name,
      meta: (r) => hrRoleLabel(r.role),
    },
    { key: 'nd', header: t('hrv.ndShort'), kind: 'money', value: (r) => r.nd, hideSm: true, subtotal: false },
    { key: 'commission', header: t('hrDash.totalCommissions'), kind: 'money', value: (r) => r.commission, subtotal: false },
  ];

  const teamColumns: FinColumn<TeamRow>[] = [
    { key: 'name', header: t('hrDash.team'), cell: (r) => r.name, meta: (r) => hrRoleLabel(r.role) },
    {
      key: 'members',
      header: t('hrDash.members'),
      kind: 'number',
      value: (r) => r.membersCount,
      hideSm: true,
    },
    {
      key: 'teamND',
      header: t('hrDash.teamND'),
      kind: 'money',
      value: (r) => r.teamND,
      // El signo del ND de un equipo es la noticia (plata que entró o se fue).
      money: { tone: 'sign' },
      subtotal: false,
    },
    {
      key: 'teamCommissions',
      header: t('hrDash.teamCommissions'),
      kind: 'money',
      value: (r) => r.teamCommissions,
      hideSm: true,
      subtotal: false,
    },
  ];

  const serviceKpis: KpiItem[] = [
    {
      key: 'headcount',
      label: t('hrv.headcount'),
      value: people.admin,
      format: 'count',
      sub: people.probation > 0 ? t('hrv.probationSub', { n: countFmt(people.probation) }) : undefined,
    },
    {
      key: 'salaries',
      label: t('hrDash.monthlySalaries'),
      value: empStats.monthlySalaries,
      hero: true,
      sub: t('hrDash.monthlySalariesHint'),
    },
    {
      key: 'departments',
      label: t('hrDash.departmentsCount'),
      value: empStats.departments.length,
      format: 'count',
      sub: empStats.departments[0]
        ? t('hrDash.largestDepartment', {
            name: empStats.departments[0].name,
            count: String(empStats.departments[0].count),
          })
        : undefined,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('hrDash.title')}
        subtitle={t('hrDash.subtitle')}
        // El período solo alimenta comisiones y equipos: sin equipo comercial
        // no queda nada en la pantalla que reaccione al cambiarlo.
        actions={commercialTeam ? <PeriodSelector /> : undefined}
      />

      {commercialTeam ? (
        <HrPeriodProvider month={month}>
          <CommercialKpis
            people={people}
            payroll={payroll}
            hasPeriod={selectedPeriod != null}
            periodLabel={selectedPeriod?.label ?? null}
          />
        </HrPeriodProvider>
      ) : (
        <KpiStrip items={serviceKpis} />
      )}

      <div className="grid grid-cols-1 gap-4 min-[1100px]:grid-cols-2">
        <Panel title={t('hrDash.payrollByPeriod')}>
          {commercialTeam ? (
            <PayrollTrendChart periods={periods} monthlyResults={monthlyResults} />
          ) : (
            <EmployeePayrollChart
              periods={periods}
              employees={employees}
              seriesLabel={t('hrDash.totalSalaries')}
              emptyTitle={t('hrDash.noPayroll')}
              emptyDescription={t('hrDash.noPayrollHint')}
            />
          )}
        </Panel>
        <Panel title={t('hrDash.employeesByDept')}>
          <DepartmentDonut departments={empStats.departments} />
        </Panel>
      </div>

      {commercialTeam && (
        <div className="grid grid-cols-1 gap-4 min-[1100px]:grid-cols-2">
          <Panel
            title={t('hrDash.topPerformers')}
            hint={selectedPeriod?.label}
            flush
            // Recorte contado: «top 5 de 23 con pago» (reglas §1.2).
            footer={
              withPayment > topPerformers.length
                ? t('hrv.topShowing', { shown: String(topPerformers.length), total: String(withPayment) })
                : undefined
            }
          >
            <FinTable
              columns={topColumns}
              rows={topPerformers}
              rowKey={(r) => r.key}
              caption={t('hrDash.topPerformers')}
              empty={t('hrDash.noData')}
            />
          </Panel>

          <Panel title={t('hrDash.teamSummary')} hint={selectedPeriod?.label} flush>
            <FinTable
              columns={teamColumns}
              rows={teamSummary}
              rowKey={(r) => r.id}
              caption={t('hrDash.teamSummary')}
              empty={t('hrDash.noData')}
            />
          </Panel>
        </div>
      )}
    </div>
  );
}

/** La franja con equipo comercial. Vive dentro del provider para leer el overview. */
function CommercialKpis({
  people,
  payroll,
  hasPeriod,
  periodLabel,
}: {
  people: ReturnType<typeof headcount>;
  payroll: ReturnType<typeof payrollOfPeriod>;
  hasPeriod: boolean;
  periodLabel: string | null;
}) {
  const { t } = useI18n();
  const { overview, loading, error } = useHrPeriod();
  const net = teamNetKpi(overview, loading && !error);
  const alerts = alertsKpi(overview, loading && !error);

  const loadingBadge = { kind: 'stale' as const, label: t('hrv.crmLoading') };
  const missingNetBadge = { kind: 'stale' as const, label: t('hrv.netNoData') };

  const items: KpiItem[] = [
    {
      key: 'headcount',
      label: t('hrv.headcount'),
      value: people.total,
      format: 'count',
      sub: t('hrv.headcountSub', { admin: String(people.admin), commercial: String(people.commercial) }),
    },
    {
      key: 'payroll',
      label: t('hrv.payrollOfPeriod'),
      value: payroll.total,
      hero: true,
      missingBadge: { kind: 'pend', label: t('hrv.notCalculated') },
      sub:
        payroll.total == null
          ? hasPeriod
            ? t('hrv.payrollNoRows')
            : t('hrv.noPeriodSelected')
          : t('hrv.payrollSub', {
              commissions: moneyText(payroll.commissions, { compact: true }),
              salaries: moneyText(payroll.salaries, { compact: true }),
            }),
    },
    {
      key: 'teamNet',
      label: t('hrv.teamNet'),
      value: net.assigned,
      tone: 'sign',
      missingBadge: net.state === 'loading' ? loadingBadge : missingNetBadge,
      sub:
        net.state === 'ok' && net.unassigned != null && net.unassigned !== 0
          ? t('hrv.unassignedSub', { amount: moneyText(net.unassigned, { compact: true }) })
          : net.state === 'ok'
            ? t('hrv.teamNetSub')
            : undefined,
    },
    {
      key: 'alerts',
      label: t('hrv.alerts'),
      value: alerts.ofMonth,
      format: 'count',
      missingBadge: alerts.state === 'loading' ? loadingBadge : { kind: 'stale', label: t('hrv.alertsNoData') },
      sub:
        alerts.state === 'ok'
          ? t('hrv.alertsSub', { suggested: String(alerts.suggested), repeat: String(alerts.repeat) })
          : undefined,
    },
  ];

  return (
    <>
      <KpiStrip items={items} />
      {net.state === 'missing' && (
        <Notice
          kind="stale"
          title={t('hrv.netNoDataTitle')}
          action={
            <Link href="/rrhh" className="text-[13px] font-medium text-brand-ink underline-offset-2 hover:underline">
              {t('hrv.review')}
            </Link>
          }
        >
          {t('hrv.netNoDataBody', { month: overview?.month?.slice(0, 7) ?? periodLabel ?? '—' })}
        </Notice>
      )}
      {hasPeriod && payroll.total == null && (
        <Notice
          kind="pend"
          title={t('hrv.payrollNoRowsTitle', { period: periodLabel ?? '' })}
          action={
            <Link href="/comisiones" className="text-[13px] font-medium text-brand-ink underline-offset-2 hover:underline">
              {t('hrv.goToCommissions')}
            </Link>
          }
        >
          {t('hrv.payrollNoRowsBody')}
        </Notice>
      )}
    </>
  );
}
