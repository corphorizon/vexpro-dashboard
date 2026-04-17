'use client';

import { useMemo } from 'react';
import { Card, CardTitle, CardValue } from '@/components/ui/card';
import { PeriodSelector } from '@/components/period-selector';
import { usePeriod } from '@/lib/period-context';
import { useData } from '@/lib/data-context';
import { useAuth } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import { formatCurrency, cn } from '@/lib/utils';
import {
  Users,
  UserCheck,
  UserX,
  Briefcase,
  Award,
  DollarSign,
  TrendingUp,
  UserCog,
} from 'lucide-react';

const ROLE_BADGE: Record<string, string> = {
  sales_manager: 'bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400',
  head: 'bg-violet-100 dark:bg-violet-950/50 text-violet-700 dark:text-violet-400',
  bdm: 'bg-blue-100 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400',
};
const ROLE_LABEL: Record<string, string> = { sales_manager: 'Sales Manager', head: 'HEAD', bdm: 'BDM' };

export default function DashboardPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { selectedPeriodId } = usePeriod();
  const {
    commercialProfiles,
    employees,
    getResultsByPeriod,
    getProfilesByHead,
  } = useData();

  // ─── Commercial profiles stats ───
  const profileStats = useMemo(() => {
    const active = commercialProfiles.filter((p) => p.status === 'active');
    const inactive = commercialProfiles.filter((p) => p.status === 'inactive');
    const salesManagers = active.filter((p) => p.role === 'sales_manager');
    const heads = active.filter((p) => p.role === 'head');
    const bdms = active.filter((p) => p.role === 'bdm');
    return { total: commercialProfiles.length, active, inactive, salesManagers, heads, bdms };
  }, [commercialProfiles]);

  // ─── Employee stats ───
  const empStats = useMemo(() => {
    const active = employees.filter((e) => e.status === 'active');
    const inactive = employees.filter((e) => e.status === 'inactive');
    const probation = employees.filter((e) => e.status === 'probation');
    // Group by department
    const deptMap = new Map<string, number>();
    for (const e of active) {
      const dept = e.department || 'Sin departamento';
      deptMap.set(dept, (deptMap.get(dept) ?? 0) + 1);
    }
    const departments = [...deptMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
    return { total: employees.length, active, inactive, probation, departments };
  }, [employees]);

  // ─── Period results ───
  const periodResults = useMemo(() => {
    if (!selectedPeriodId) return [];
    return getResultsByPeriod(selectedPeriodId);
  }, [selectedPeriodId, getResultsByPeriod]);

  // ─── Payroll summary for selected period ───
  const payroll = useMemo(() => {
    let totalCommissions = 0;
    let totalSalaries = 0;
    for (const r of periodResults) {
      totalCommissions += r.real_payment ?? 0;
      totalSalaries += r.salary_paid ?? 0;
    }
    return { totalCommissions, totalSalaries, total: totalCommissions + totalSalaries };
  }, [periodResults]);

  // ─── Top performers (by real_payment this period) ───
  const topPerformers = useMemo(() => {
    return periodResults
      .filter((r) => r.real_payment > 0)
      .sort((a, b) => b.real_payment - a.real_payment)
      .slice(0, 5)
      .map((r) => {
        const profile = commercialProfiles.find((p) => p.id === r.profile_id);
        return {
          name: profile?.name ?? '—',
          role: profile?.role ?? 'bdm',
          commission: r.real_payment,
          salary: r.salary_paid,
          total: r.total_earned,
          nd: r.net_deposit_current,
        };
      });
  }, [periodResults, commercialProfiles]);

  // ─── Team summary (HEAD teams) ───
  const teamSummary = useMemo(() => {
    const headProfiles = commercialProfiles.filter(
      (p) => (p.role === 'head' || p.role === 'sales_manager') && p.status === 'active'
    );
    return headProfiles.map((head) => {
      const members = getProfilesByHead(head.id).filter((p) => p.status === 'active');
      // HEAD's own result in their OWN team context (head_id = their own id)
      const headResult = periodResults.find(
        (r) => r.profile_id === head.id && r.head_id === head.id
      );
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
        totalEarned: headResult?.total_earned ?? 0,
      };
    }).sort((a, b) => b.teamND - a.teamND);
  }, [commercialProfiles, getProfilesByHead, periodResults]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('hrDash.title')}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('hrDash.subtitle')}</p>
        </div>
        <PeriodSelector />
      </div>

      {/* KPI Row 1 — People count */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-violet-50 dark:bg-violet-950/50">
              <Users className="w-5 h-5 text-violet-500" />
            </div>
            <CardTitle>{t('hrDash.totalProfiles')}</CardTitle>
          </div>
          <CardValue>{profileStats.active.length}</CardValue>
          <p className="text-xs text-muted-foreground mt-1">
            {profileStats.inactive.length} {t('hrDash.inactiveProfiles').toLowerCase()}
          </p>
        </Card>

        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950/50">
              <Briefcase className="w-5 h-5 text-blue-500" />
            </div>
            <CardTitle>{t('hrDash.totalEmployees')}</CardTitle>
          </div>
          <CardValue>{empStats.active.length}</CardValue>
          <p className="text-xs text-muted-foreground mt-1">
            {empStats.probation.length > 0 && `${empStats.probation.length} ${t('hrDash.probationEmployees').toLowerCase()} · `}
            {empStats.inactive.length} {t('hrDash.inactiveEmployees').toLowerCase()}
          </p>
        </Card>

        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/50">
              <DollarSign className="w-5 h-5 text-emerald-500" />
            </div>
            <CardTitle>{t('hrDash.totalPayroll')}</CardTitle>
          </div>
          <CardValue>{formatCurrency(payroll.total)}</CardValue>
          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
            <div className="flex justify-between">
              <span>{t('hrDash.totalCommissions')}</span>
              <span>{formatCurrency(payroll.totalCommissions)}</span>
            </div>
            <div className="flex justify-between">
              <span>{t('hrDash.totalSalaries')}</span>
              <span>{formatCurrency(payroll.totalSalaries)}</span>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950/50">
              <UserCog className="w-5 h-5 text-amber-500" />
            </div>
            <CardTitle>{t('hrDash.byRole')}</CardTitle>
          </div>
          <div className="space-y-2 mt-1">
            <div className="flex justify-between items-center">
              <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', ROLE_BADGE.sales_manager)}>
                {t('hrDash.salesManagers')}
              </span>
              <span className="font-semibold text-sm">{profileStats.salesManagers.length}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', ROLE_BADGE.head)}>
                {t('hrDash.heads')}
              </span>
              <span className="font-semibold text-sm">{profileStats.heads.length}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', ROLE_BADGE.bdm)}>
                {t('hrDash.bdms')}
              </span>
              <span className="font-semibold text-sm">{profileStats.bdms.length}</span>
            </div>
          </div>
        </Card>
      </div>

      {/* Row 2 — Top Performers + Team Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Top Performers */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-yellow-50 dark:bg-yellow-950/50">
              <Award className="w-5 h-5 text-yellow-500" />
            </div>
            <h2 className="font-semibold">{t('hrDash.topPerformers')}</h2>
          </div>
          {topPerformers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('hrDash.noData')}</p>
          ) : (
            <div className="space-y-3">
              {topPerformers.map((p, i) => (
                <div key={i} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="w-6 h-6 flex items-center justify-center rounded-full bg-muted text-xs font-bold">
                      {i + 1}
                    </span>
                    <div>
                      <p className="text-sm font-medium">{p.name}</p>
                      <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium', ROLE_BADGE[p.role] || ROLE_BADGE.bdm)}>
                        {ROLE_LABEL[p.role] || p.role}
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-emerald-600">{formatCurrency(p.commission)}</p>
                    <p className="text-[10px] text-muted-foreground">ND: {formatCurrency(p.nd)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Team Summary */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-indigo-50 dark:bg-indigo-950/50">
              <TrendingUp className="w-5 h-5 text-indigo-500" />
            </div>
            <h2 className="font-semibold">{t('hrDash.teamSummary')}</h2>
          </div>
          {teamSummary.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('hrDash.noData')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left py-2 font-medium">{t('hrDash.team')}</th>
                    <th className="text-center py-2 font-medium">{t('hrDash.members')}</th>
                    <th className="text-right py-2 font-medium">{t('hrDash.teamND')}</th>
                    <th className="text-right py-2 font-medium">{t('hrDash.teamCommissions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {teamSummary.map((team) => (
                    <tr key={team.id} className="border-b last:border-0">
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{team.name}</span>
                          <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium', ROLE_BADGE[team.role] || ROLE_BADGE.head)}>
                            {ROLE_LABEL[team.role] || team.role}
                          </span>
                        </div>
                      </td>
                      <td className="py-2 text-center">{team.membersCount}</td>
                      <td className={cn('py-2 text-right font-medium', team.teamND >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                        {formatCurrency(team.teamND)}
                      </td>
                      <td className="py-2 text-right">{formatCurrency(team.teamCommissions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
