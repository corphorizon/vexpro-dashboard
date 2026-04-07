'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { ROLE_LABELS_HR } from '@/lib/hr-data';
import { useData } from '@/lib/data-context';
import { formatCurrency } from '@/lib/utils';
import { downloadCSV } from '@/lib/csv-export';
import { cn } from '@/lib/utils';
import type { Employee, CommercialProfile, CommercialMonthlyResult } from '@/lib/types';
import { useI18n } from '@/lib/i18n';
import { Users, Briefcase, Download, ChevronRight, UserCircle, Plus, X, Pencil } from 'lucide-react';

type Tab = 'employees' | 'commercial';

const STATUS_BADGE_CLASSES: Record<string, string> = {
  active: 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400',
  inactive: 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-400',
  probation: 'bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400',
};

const STATUS_LABEL_KEYS: Record<string, string> = {
  active: 'hr.statusActive',
  inactive: 'hr.statusInactive',
  probation: 'hr.statusProbation',
};

const ROLE_BADGE_COLORS: Record<string, string> = {
  sales_manager: 'bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400',
  head: 'bg-violet-50 dark:bg-violet-950/50 text-violet-700 dark:text-violet-400',
  bdm: 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400',
};

// ─── Period filter logic ───
type FilterPreset = 'total' | 'month' | 'quarter' | 'semester' | 'annual' | 'custom';

function getFilteredPeriodIds(periods: { id: string; year: number; month: number }[], preset: FilterPreset, selectedMonth: string, customIds: string[]): string[] {
  switch (preset) {
    case 'total':
      return periods.map(p => p.id);
    case 'month':
      return selectedMonth ? [selectedMonth] : [];
    case 'quarter': {
      const ref = periods.find(p => p.id === selectedMonth);
      if (!ref) return [];
      const q = Math.ceil(ref.month / 3);
      const startM = (q - 1) * 3 + 1;
      return periods.filter(p => p.year === ref.year && p.month >= startM && p.month <= startM + 2).map(p => p.id);
    }
    case 'semester': {
      const ref2 = periods.find(p => p.id === selectedMonth);
      if (!ref2) return [];
      const half = ref2.month <= 6 ? [1, 6] : [7, 12];
      return periods.filter(p => p.year === ref2.year && p.month >= half[0] && p.month <= half[1]).map(p => p.id);
    }
    case 'annual': {
      const ref3 = periods.find(p => p.id === selectedMonth);
      if (!ref3) return [];
      return periods.filter(p => p.year === ref3.year).map(p => p.id);
    }
    case 'custom':
      return customIds;
  }
}

// ─── Employee Form ───
function EmployeeForm({ onClose, onSave, editing }: { onClose: () => void; onSave: (e: Employee) => void; editing?: Employee }) {
  const { t } = useI18n();
  const [name, setName] = useState(editing?.name || '');
  const [email, setEmail] = useState(editing?.email || '');
  const [position, setPosition] = useState(editing?.position || '');
  const [department, setDepartment] = useState(editing?.department || '');
  const [startDate, setStartDate] = useState(editing?.start_date || '');
  const [salary, setSalary] = useState(editing?.salary?.toString() || '');
  const [status, setStatus] = useState<'active' | 'inactive' | 'probation'>(editing?.status || 'active');
  const [birthday, setBirthday] = useState(editing?.birthday || '');
  const [supervisor, setSupervisor] = useState(editing?.supervisor || '');
  const [comments, setComments] = useState(editing?.comments || '');

  const handleSubmit = () => {
    if (!name || !email) return;
    onSave({
      id: editing?.id || `emp-${Date.now()}`,
      company_id: 'vexpro-001',
      name, email, position, department, start_date: startDate,
      salary: salary ? parseFloat(salary) : null,
      status, phone: null, country: null, notes: null,
      birthday: birthday || null,
      supervisor: supervisor || null,
      comments: comments || null,
    });
    onClose();
  };

  return (
    <div className="border border-border rounded-lg p-4 mb-4 bg-muted/30">
      <div className="flex justify-between items-center mb-3">
        <h3 className="font-semibold text-sm">{editing ? t('hr.editEmployee') : t('hr.newEmployee')}</h3>
        <button onClick={onClose} aria-label="Close"><X className="w-4 h-4" /></button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <input placeholder={t('hr.namePlaceholder')} value={name} onChange={e => setName(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
        <input placeholder={t('hr.emailPlaceholder')} value={email} onChange={e => setEmail(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
        <input placeholder={t('hr.positionPlaceholder')} value={position} onChange={e => setPosition(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
        <input placeholder={t('hr.departmentPlaceholder')} value={department} onChange={e => setDepartment(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
        <input type="date" placeholder={t('hr.startDatePlaceholder')} value={startDate} onChange={e => setStartDate(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
        <input type="number" placeholder={t('hr.salaryPlaceholder')} value={salary} onChange={e => setSalary(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
        <select value={status} onChange={e => setStatus(e.target.value as 'active' | 'inactive' | 'probation')} className="px-3 py-2 rounded-lg border border-border bg-card text-sm">
          <option value="active">{t('hr.statusActive')}</option>
          <option value="inactive">{t('hr.statusInactive')}</option>
          <option value="probation">{t('hr.statusProbation')}</option>
        </select>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">{t('hr.birthday')}</label>
          <input type="date" value={birthday} onChange={e => setBirthday(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
        </div>
        <input placeholder={t('hr.supervisorPlaceholder')} value={supervisor} onChange={e => setSupervisor(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
        <input placeholder={t('hr.commentsPlaceholder')} value={comments} onChange={e => setComments(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
      </div>
      <div className="mt-3 flex justify-end">
        <button onClick={handleSubmit} className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90">
          {editing ? t('common.save') : t('common.add')}
        </button>
      </div>
    </div>
  );
}

// ─── Commercial Profile Form ───
function ProfileForm({ onClose, onSave, editing }: { onClose: () => void; onSave: (p: CommercialProfile) => void; editing?: CommercialProfile }) {
  const { t } = useI18n();
  const { commercialProfiles } = useData();
  const [name, setName] = useState(editing?.name || '');
  const [email, setEmail] = useState(editing?.email || '');
  const [role, setRole] = useState<'sales_manager' | 'head' | 'bdm'>(editing?.role || 'bdm');
  const [headId, setHeadId] = useState(editing?.head_id || '');
  const [ndPct, setNdPct] = useState(editing?.net_deposit_pct?.toString() || '');
  const [pnlPct, setPnlPct] = useState(editing?.pnl_pct?.toString() || '');
  const [commLot, setCommLot] = useState(editing?.commission_per_lot?.toString() || '');
  const [salary, setSalary] = useState(editing?.salary?.toString() || '');
  const [benefits, setBenefits] = useState(editing?.benefits || '');
  const [comments, setComments] = useState(editing?.comments || '');
  const [hireDate, setHireDate] = useState(editing?.hire_date || '');
  const [birthday, setBirthday] = useState(editing?.birthday || '');
  const [status, setStatus] = useState<'active' | 'inactive'>(editing?.status || 'active');

  const possibleHeads = commercialProfiles.filter(p => p.role === 'sales_manager' || p.role === 'head');

  const handleSubmit = () => {
    if (!name || !email) return;
    onSave({
      id: editing?.id || `cp-${Date.now()}`,
      company_id: 'vexpro-001',
      name, email, role,
      head_id: headId || null,
      net_deposit_pct: ndPct ? parseFloat(ndPct) : null,
      pnl_pct: pnlPct ? parseFloat(pnlPct) : null,
      commission_per_lot: commLot ? parseFloat(commLot) : null,
      salary: salary ? parseFloat(salary) : null,
      benefits: benefits || null,
      comments: comments || null,
      hire_date: hireDate || null,
      birthday: birthday || null,
      status,
    });
    onClose();
  };

  return (
    <div className="border border-border rounded-lg p-4 mb-4 bg-muted/30">
      <div className="flex justify-between items-center mb-3">
        <h3 className="font-semibold text-sm">{editing ? t('hr.editProfile') : t('hr.newProfile')}</h3>
        <button onClick={onClose} aria-label="Close"><X className="w-4 h-4" /></button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <input placeholder={t('hr.namePlaceholder')} value={name} onChange={e => setName(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
        <input placeholder={t('hr.emailPlaceholder')} value={email} onChange={e => setEmail(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
        <select value={role} onChange={e => setRole(e.target.value as 'sales_manager' | 'head' | 'bdm')} className="px-3 py-2 rounded-lg border border-border bg-card text-sm">
          <option value="sales_manager">Sales Manager</option>
          <option value="head">HEAD</option>
          <option value="bdm">BDM</option>
        </select>
        {role === 'bdm' && (
          <select value={headId} onChange={e => setHeadId(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm">
            <option value="">{t('hr.noSupervisor')}</option>
            {possibleHeads.map(h => (
              <option key={h.id} value={h.id}>{h.name} ({ROLE_LABELS_HR[h.role]})</option>
            ))}
          </select>
        )}
        <input type="number" placeholder={t('hr.ndPctPlaceholder')} value={ndPct} onChange={e => setNdPct(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
        <input type="number" placeholder={t('hr.pnlPctPlaceholder')} value={pnlPct} onChange={e => setPnlPct(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
        <input type="number" placeholder={t('hr.commLotPlaceholder')} value={commLot} onChange={e => setCommLot(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
        <input type="number" placeholder={t('hr.salaryUsdPlaceholder')} value={salary} onChange={e => setSalary(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
        <input placeholder={t('hr.benefitsPlaceholder')} value={benefits} onChange={e => setBenefits(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
        <input placeholder={t('hr.commentsPlaceholder')} value={comments} onChange={e => setComments(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">{t('hr.hireDatePlaceholder')}</label>
          <input type="date" value={hireDate} onChange={e => setHireDate(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">{t('hr.birthdayPlaceholder')}</label>
          <input type="date" value={birthday} onChange={e => setBirthday(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
        </div>
        <select value={status} onChange={e => setStatus(e.target.value as 'active' | 'inactive')} className="px-3 py-2 rounded-lg border border-border bg-card text-sm">
          <option value="active">{t('hr.statusActive')}</option>
          <option value="inactive">{t('hr.statusInactive')}</option>
        </select>
      </div>
      <div className="mt-3 flex justify-end">
        <button onClick={handleSubmit} className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90">
          {editing ? t('common.save') : t('common.add')}
        </button>
      </div>
    </div>
  );
}

// ─── Period Filter Component ───
function PeriodFilter({ preset, setPreset, selectedMonth, setSelectedMonth, customIds, setCustomIds }: {
  preset: FilterPreset; setPreset: (p: FilterPreset) => void;
  selectedMonth: string; setSelectedMonth: (m: string) => void;
  customIds: string[]; setCustomIds: (ids: string[]) => void;
}) {
  const { t } = useI18n();
  const { periods } = useData();
  const [showCustom, setShowCustom] = useState(false);

  const filterLabels: Record<FilterPreset, string> = {
    total: t('hr.filterTotal'),
    month: t('hr.filterMonth'),
    quarter: t('hr.filterQuarter'),
    semester: t('hr.filterSemester'),
    annual: t('hr.filterAnnual'),
    custom: t('hr.filterCustom'),
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {(['total', 'month', 'quarter', 'semester', 'annual', 'custom'] as FilterPreset[]).map(p => (
        <button
          key={p}
          onClick={() => {
            setPreset(p);
            if (p === 'custom') setShowCustom(true);
            else setShowCustom(false);
          }}
          className={cn(
            'px-3 py-1.5 text-xs font-medium rounded-md border transition-colors',
            preset === p ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]' : 'border-border hover:bg-muted'
          )}
        >
          {filterLabels[p]}
        </button>
      ))}
      {preset !== 'total' && preset !== 'custom' && (
        <select
          value={selectedMonth}
          onChange={e => setSelectedMonth(e.target.value)}
          className="px-3 py-1.5 text-xs rounded-md border border-border bg-card"
        >
          {periods.map(p => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      )}
      {showCustom && preset === 'custom' && (
        <div className="flex flex-wrap gap-1">
          {periods.map(p => (
            <button
              key={p.id}
              onClick={() => setCustomIds(customIds.includes(p.id) ? customIds.filter(x => x !== p.id) : [...customIds, p.id])}
              className={cn(
                'px-2 py-1 text-xs rounded-md border transition-colors',
                customIds.includes(p.id) ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]' : 'border-border hover:bg-muted'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RRHHPage() {
  const { t } = useI18n();
  const { employees: dataEmployees, commercialProfiles, monthlyResults: dataMonthlyResults, periods } = useData();
  const [tab, setTab] = useState<Tab>('commercial');
  const [employees, setEmployees] = useState<Employee[]>(dataEmployees);
  const [profiles, setProfiles] = useState<CommercialProfile[]>(commercialProfiles);
  const [monthlyResults, setMonthlyResults] = useState<CommercialMonthlyResult[]>(dataMonthlyResults);
  const [showEmpForm, setShowEmpForm] = useState(false);
  const [editingEmp, setEditingEmp] = useState<Employee | undefined>();
  const [showProfileForm, setShowProfileForm] = useState(false);
  const [editingProfile, setEditingProfile] = useState<CommercialProfile | undefined>();

  // Period filter state
  const [filterPreset, setFilterPreset] = useState<FilterPreset>('total');
  const [filterMonth, setFilterMonth] = useState(periods[periods.length - 1]?.id || '');
  const [filterCustomIds, setFilterCustomIds] = useState<string[]>([]);

  const filteredPeriodIds = getFilteredPeriodIds(periods, filterPreset, filterMonth, filterCustomIds);

  // Computed values for filtered periods
  const filteredResults = monthlyResults.filter(r => filteredPeriodIds.includes(r.period_id));

  const getFilteredTotal = useCallback((profileId: string) => {
    return filteredResults.filter(r => r.profile_id === profileId).reduce((s, r) => s + r.total_earned, 0);
  }, [filteredResults]);

  const getFilteredCommissions = useCallback((profileId: string) => {
    return filteredResults.filter(r => r.profile_id === profileId).reduce((s, r) => s + r.commissions_earned, 0);
  }, [filteredResults]);

  const getFilteredPnl = useCallback((profileId: string) => {
    return filteredResults.filter(r => r.profile_id === profileId).reduce((s, r) => s + r.pnl_current, 0);
  }, [filteredResults]);

  const getFilteredBonus = useCallback((profileId: string) => {
    return filteredResults.filter(r => r.profile_id === profileId).reduce((s, r) => s + r.bonus, 0);
  }, [filteredResults]);

  const salesManagers = profiles.filter(p => p.role === 'sales_manager');
  const heads = profiles.filter(p => p.role === 'head');
  const independentBdms = profiles.filter(p => p.role === 'bdm' && !p.head_id);

  const totalCommissionsFiltered = filteredResults.reduce((sum, r) => sum + r.total_earned, 0);
  const activeProfiles = profiles.filter(p => p.status === 'active').length;

  // CRUD handlers
  const handleSaveEmployee = (emp: Employee) => {
    setEmployees(prev => {
      const idx = prev.findIndex(e => e.id === emp.id);
      if (idx >= 0) { const next = [...prev]; next[idx] = emp; return next; }
      return [...prev, emp];
    });
    setEditingEmp(undefined);
  };

  const handleSaveProfile = (profile: CommercialProfile) => {
    setProfiles(prev => {
      const idx = prev.findIndex(p => p.id === profile.id);
      if (idx >= 0) { const next = [...prev]; next[idx] = profile; return next; }
      return [...prev, profile];
    });
    setEditingProfile(undefined);
  };

  const handleExportEmployees = () => {
    const headers = [t('common.name'), t('common.email'), t('hr.position'), t('hr.department'), t('hr.startDate'), t('hr.salary'), t('hr.status')];
    const rows = employees.map(e => [e.name, e.email, e.position, e.department, e.start_date, e.salary ?? 'N/A', t(STATUS_LABEL_KEYS[e.status])] as (string | number)[]);
    downloadCSV('empleados.csv', headers, rows);
  };

  const handleExportCommercial = () => {
    const headers = [t('common.name'), t('common.email'), t('hr.role'), 'Net Deposit %', 'PNL %', t('hr.commLotPlaceholder'), t('hr.salary'), t('hr.total')];
    const rows = profiles.map(p => [
      p.name, p.email, ROLE_LABELS_HR[p.role],
      p.net_deposit_pct != null ? `${p.net_deposit_pct}%` : 'N/A',
      p.pnl_pct != null ? `${p.pnl_pct}%` : 'N/A',
      p.commission_per_lot != null ? p.commission_per_lot : 'N/A',
      p.salary != null ? p.salary : 'N/A',
      getFilteredTotal(p.id),
    ] as (string | number)[]);
    downloadCSV('fuerza_comercial.csv', headers, rows);
  };

  // Render a team card (for sales_manager or head)
  const renderTeamCard = (leader: CommercialProfile) => {
    const bdms = profiles.filter(p => p.head_id === leader.id);
    const leaderTotal = getFilteredTotal(leader.id);
    const roleBadge = ROLE_BADGE_COLORS[leader.role] || 'bg-gray-50 text-gray-700';

    return (
      <Card key={leader.id}>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-violet-100 dark:bg-violet-950/50 flex items-center justify-center shrink-0">
              <UserCircle className="w-6 h-6 text-violet-600" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <Link href={`/rrhh/perfil?id=${leader.id}`} className="text-base sm:text-lg font-semibold hover:text-[var(--color-primary)] transition-colors">
                  {leader.name}
                </Link>
                <button onClick={() => { setEditingProfile(leader); setShowProfileForm(true); }} className="text-muted-foreground hover:text-foreground" aria-label={t('common.edit')}>
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', roleBadge)}>
                  {ROLE_LABELS_HR[leader.role]}
                </span>
                <span className="hidden sm:inline">{leader.email}</span>
              </div>
            </div>
          </div>
          <div className="text-left sm:text-right ml-13 sm:ml-0">
            <p className="text-sm text-muted-foreground">Net Deposit: {leader.net_deposit_pct != null ? `${leader.net_deposit_pct}%` : 'N/A'}</p>
            <p className="font-semibold">{formatCurrency(leaderTotal)}</p>
          </div>
        </div>

        {bdms.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[500px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 text-muted-foreground font-medium">BDM</th>
                  <th className="text-left py-2 text-muted-foreground font-medium hidden sm:table-cell">{t('common.email')}</th>
                  <th className="text-right py-2 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.netDepPct')}</th>
                  <th className="text-right py-2 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.salaryCol')}</th>
                  <th className="text-right py-2 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.pnl')}</th>
                  <th className="text-right py-2 text-muted-foreground font-medium">{t('hr.commissions')}</th>
                  <th className="text-right py-2 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.bonus')}</th>
                  <th className="text-right py-2 text-muted-foreground font-medium">{t('hr.total')}</th>
                  <th className="text-right py-2 text-muted-foreground font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {bdms.map(bdm => {
                  const bdmPnl = getFilteredPnl(bdm.id);
                  const bdmBonus = getFilteredBonus(bdm.id);
                  return (
                  <tr key={bdm.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                    <td className="py-2.5 font-medium">{bdm.name}</td>
                    <td className="py-2.5 text-muted-foreground text-xs hidden sm:table-cell">{bdm.email}</td>
                    <td className="py-2.5 text-right hidden sm:table-cell">{bdm.net_deposit_pct != null ? `${bdm.net_deposit_pct}%` : 'N/A'}</td>
                    <td className="py-2.5 text-right hidden sm:table-cell">{bdm.salary != null ? formatCurrency(bdm.salary) : 'N/A'}</td>
                    <td className="py-2.5 text-right hidden sm:table-cell">{bdmPnl > 0 ? formatCurrency(bdmPnl) : '-'}</td>
                    <td className="py-2.5 text-right">{formatCurrency(getFilteredCommissions(bdm.id))}</td>
                    <td className="py-2.5 text-right hidden sm:table-cell">{bdmBonus > 0 ? formatCurrency(bdmBonus) : '-'}</td>
                    <td className="py-2.5 text-right font-medium">{formatCurrency(getFilteredTotal(bdm.id))}</td>
                    <td className="py-2.5 text-right flex items-center justify-end gap-1">
                      <button onClick={() => { setEditingProfile(bdm); setShowProfileForm(true); }} className="text-muted-foreground hover:text-foreground" aria-label={t('common.edit')}>
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <Link href={`/rrhh/perfil?id=${bdm.id}`} className="text-muted-foreground hover:text-foreground">
                        <ChevronRight className="w-4 h-4" />
                      </Link>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('hr.title')}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('hr.subtitle')}</p>
        </div>
        <button
          onClick={tab === 'employees' ? handleExportEmployees : handleExportCommercial}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors self-start sm:self-auto"
          title={t('common.csv')}
        >
          <Download className="w-4 h-4" />
          <span className="hidden sm:inline">{t('common.csv')}</span>
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950/50"><Users className="w-5 h-5 text-blue-500" /></div>
            <span className="text-sm text-muted-foreground">{t('hr.employees')}</span>
          </div>
          <p className="text-2xl font-bold">{employees.length}</p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-violet-50 dark:bg-violet-950/50"><Briefcase className="w-5 h-5 text-violet-500" /></div>
            <span className="text-sm text-muted-foreground">{t('hr.activeForce')}</span>
          </div>
          <p className="text-2xl font-bold">{activeProfiles}</p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/50"><Briefcase className="w-5 h-5 text-emerald-500" /></div>
            <span className="text-sm text-muted-foreground">{t('hr.totalCommissions')}</span>
          </div>
          <p className="text-2xl font-bold">{formatCurrency(totalCommissionsFiltered)}</p>
        </Card>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-muted p-1 rounded-lg w-fit">
        <button
          onClick={() => setTab('employees')}
          className={cn(
            'px-3 sm:px-4 py-2 rounded-md text-xs sm:text-sm font-medium transition-colors',
            tab === 'employees' ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Users className="w-4 h-4 inline mr-1 sm:mr-2" />
          {t('hr.employees')}
        </button>
        <button
          onClick={() => setTab('commercial')}
          className={cn(
            'px-3 sm:px-4 py-2 rounded-md text-xs sm:text-sm font-medium transition-colors',
            tab === 'commercial' ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Briefcase className="w-4 h-4 inline mr-1 sm:mr-2" />
          {t('hr.commercialForce')}
        </button>
      </div>

      {/* ═══════════ EMPLOYEES TAB ═══════════ */}
      {tab === 'employees' && (
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">{t('hr.employees')}</h2>
            <button
              onClick={() => { setEditingEmp(undefined); setShowEmpForm(true); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
            >
              <Plus className="w-4 h-4" /> {t('hr.addEmployee')}
            </button>
          </div>
          {showEmpForm && (
            <EmployeeForm
              editing={editingEmp}
              onClose={() => { setShowEmpForm(false); setEditingEmp(undefined); }}
              onSave={handleSaveEmployee}
            />
          )}
          <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
            <table className="w-full text-sm min-w-[600px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 text-muted-foreground font-medium">{t('common.name')}</th>
                  <th className="text-left py-2 text-muted-foreground font-medium hidden sm:table-cell">{t('common.email')}</th>
                  <th className="text-left py-2 text-muted-foreground font-medium">{t('hr.position')}</th>
                  <th className="text-left py-2 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.department')}</th>
                  <th className="text-left py-2 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.startDate')}</th>
                  <th className="text-right py-2 text-muted-foreground font-medium">{t('hr.salary')}</th>
                  <th className="text-left py-2 text-muted-foreground font-medium hidden md:table-cell">{t('hr.birthday')}</th>
                  <th className="text-left py-2 text-muted-foreground font-medium hidden md:table-cell">{t('hr.supervisor')}</th>
                  <th className="text-left py-2 text-muted-foreground font-medium">{t('hr.status')}</th>
                  <th className="text-right py-2 text-muted-foreground font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {employees.map(emp => {
                  return (
                    <tr key={emp.id} className="border-b border-border/50">
                      <td className="py-2.5 font-medium">{emp.name}</td>
                      <td className="py-2.5 text-muted-foreground hidden sm:table-cell">{emp.email}</td>
                      <td className="py-2.5">{emp.position}</td>
                      <td className="py-2.5 hidden sm:table-cell">{emp.department}</td>
                      <td className="py-2.5 hidden sm:table-cell">{emp.start_date}</td>
                      <td className="py-2.5 text-right">{emp.salary != null ? formatCurrency(emp.salary) : 'N/A'}</td>
                      <td className="py-2.5 text-muted-foreground text-xs hidden md:table-cell">{emp.birthday || '-'}</td>
                      <td className="py-2.5 text-muted-foreground text-xs hidden md:table-cell">{emp.supervisor || '-'}</td>
                      <td className="py-2.5">
                        <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', STATUS_BADGE_CLASSES[emp.status])}>
                          {t(STATUS_LABEL_KEYS[emp.status])}
                        </span>
                      </td>
                      <td className="py-2.5 text-right">
                        <button onClick={() => { setEditingEmp(emp); setShowEmpForm(true); }} className="text-muted-foreground hover:text-foreground" aria-label={t('common.edit')}>
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {employees.length === 0 && (
            <p className="text-center text-muted-foreground py-8">{t('hr.noEmployees')}</p>
          )}
        </Card>
      )}

      {/* ═══════════ COMMERCIAL FORCE TAB ═══════════ */}
      {tab === 'commercial' && (
        <div className="space-y-6">
          {/* Period Filter */}
          <Card>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">{t('hr.filterPeriod')}</h3>
              <button
                onClick={() => { setEditingProfile(undefined); setShowProfileForm(true); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
              >
                <Plus className="w-4 h-4" /> {t('hr.addProfile')}
              </button>
            </div>
            <PeriodFilter
              preset={filterPreset} setPreset={setFilterPreset}
              selectedMonth={filterMonth} setSelectedMonth={setFilterMonth}
              customIds={filterCustomIds} setCustomIds={setFilterCustomIds}
            />
          </Card>

          {showProfileForm && (
            <ProfileForm
              editing={editingProfile}
              onClose={() => { setShowProfileForm(false); setEditingProfile(undefined); }}
              onSave={handleSaveProfile}
            />
          )}

          {/* Sales Managers */}
          {salesManagers.map(sm => renderTeamCard(sm))}

          {/* HEADs */}
          {heads.map(head => renderTeamCard(head))}

          {/* Independent BDMs */}
          {independentBdms.length > 0 && (
            <Card>
              <h2 className="text-lg font-semibold mb-4">{t('hr.independentBdms')}</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 text-muted-foreground font-medium">{t('common.name')}</th>
                      <th className="text-left py-2 text-muted-foreground font-medium">{t('common.email')}</th>
                      <th className="text-right py-2 text-muted-foreground font-medium">{t('hr.netDepPct')}</th>
                      <th className="text-right py-2 text-muted-foreground font-medium">{t('hr.pnlPct')}</th>
                      <th className="text-right py-2 text-muted-foreground font-medium">{t('hr.salaryCol')}</th>
                      <th className="text-right py-2 text-muted-foreground font-medium">{t('hr.pnl')}</th>
                      <th className="text-right py-2 text-muted-foreground font-medium">{t('hr.commissions')}</th>
                      <th className="text-right py-2 text-muted-foreground font-medium">{t('hr.bonus')}</th>
                      <th className="text-right py-2 text-muted-foreground font-medium">{t('hr.total')}</th>
                      <th className="text-right py-2 text-muted-foreground font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {independentBdms.map(bdm => {
                      const bdmPnl = getFilteredPnl(bdm.id);
                      const bdmBonus = getFilteredBonus(bdm.id);
                      return (
                      <tr key={bdm.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                        <td className="py-2.5 font-medium">{bdm.name}</td>
                        <td className="py-2.5 text-muted-foreground text-xs">{bdm.email}</td>
                        <td className="py-2.5 text-right">{bdm.net_deposit_pct != null ? `${bdm.net_deposit_pct}%` : 'N/A'}</td>
                        <td className="py-2.5 text-right">{bdm.pnl_pct != null ? `${bdm.pnl_pct}%` : 'N/A'}</td>
                        <td className="py-2.5 text-right">{bdm.salary != null ? formatCurrency(bdm.salary) : 'N/A'}</td>
                        <td className="py-2.5 text-right">{bdmPnl > 0 ? formatCurrency(bdmPnl) : '-'}</td>
                        <td className="py-2.5 text-right">{formatCurrency(getFilteredCommissions(bdm.id))}</td>
                        <td className="py-2.5 text-right">{bdmBonus > 0 ? formatCurrency(bdmBonus) : '-'}</td>
                        <td className="py-2.5 text-right font-medium">{formatCurrency(getFilteredTotal(bdm.id))}</td>
                        <td className="py-2.5 text-right flex items-center justify-end gap-1">
                          <button onClick={() => { setEditingProfile(bdm); setShowProfileForm(true); }} className="text-muted-foreground hover:text-foreground" aria-label={t('common.edit')}>
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <Link href={`/rrhh/perfil?id=${bdm.id}`} className="text-muted-foreground hover:text-foreground">
                            <ChevronRight className="w-4 h-4" />
                          </Link>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* ─── Monthly Results Table (all profiles) ─── */}
          <Card>
            <h2 className="text-lg font-semibold mb-4">{t('hr.resultsByPeriod')}</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 text-muted-foreground font-medium">{t('common.name')}</th>
                    <th className="text-left py-2 text-muted-foreground font-medium">{t('hr.role')}</th>
                    <th className="text-right py-2 text-muted-foreground font-medium">{t('hr.netDeposit')}</th>
                    <th className="text-right py-2 text-muted-foreground font-medium">{t('hr.pnl')}</th>
                    <th className="text-right py-2 text-muted-foreground font-medium">{t('hr.commissions')}</th>
                    <th className="text-right py-2 text-muted-foreground font-medium">{t('hr.bonus')}</th>
                    <th className="text-right py-2 text-muted-foreground font-medium">{t('hr.salaryCol')}</th>
                    <th className="text-right py-2 text-muted-foreground font-medium font-bold">{t('hr.total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {profiles
                    .filter(p => {
                      const results = filteredResults.filter(r => r.profile_id === p.id);
                      return results.some(r => r.total_earned > 0 || r.net_deposit_current > 0);
                    })
                    .sort((a, b) => getFilteredTotal(b.id) - getFilteredTotal(a.id))
                    .map(p => {
                      const results = filteredResults.filter(r => r.profile_id === p.id);
                      const nd = results.reduce((s, r) => s + r.net_deposit_total, 0);
                      const pnl = results.reduce((s, r) => s + r.pnl_current, 0);
                      const comm = results.reduce((s, r) => s + r.commissions_earned, 0);
                      const bonus = results.reduce((s, r) => s + r.bonus, 0);
                      const sal = results.reduce((s, r) => s + r.salary_paid, 0);
                      const total = results.reduce((s, r) => s + r.total_earned, 0);
                      return (
                        <tr key={p.id} className="border-b border-border/50">
                          <td className="py-2.5 font-medium">
                            <Link href={`/rrhh/perfil?id=${p.id}`} className="hover:text-[var(--color-primary)]">{p.name}</Link>
                          </td>
                          <td className="py-2.5">
                            <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', ROLE_BADGE_COLORS[p.role])}>
                              {ROLE_LABELS_HR[p.role]}
                            </span>
                          </td>
                          <td className="py-2.5 text-right">{formatCurrency(nd)}</td>
                          <td className="py-2.5 text-right">{pnl > 0 ? formatCurrency(pnl) : '-'}</td>
                          <td className="py-2.5 text-right">{formatCurrency(comm)}</td>
                          <td className="py-2.5 text-right">{bonus > 0 ? formatCurrency(bonus) : '-'}</td>
                          <td className="py-2.5 text-right">{sal > 0 ? formatCurrency(sal) : '-'}</td>
                          <td className="py-2.5 text-right font-bold">{formatCurrency(total)}</td>
                        </tr>
                      );
                    })}
                </tbody>
                <tfoot>
                  <tr className="font-bold border-t-2 border-border">
                    <td className="py-3" colSpan={2}>TOTAL</td>
                    <td className="py-3 text-right">{formatCurrency(filteredResults.reduce((s, r) => s + r.net_deposit_total, 0))}</td>
                    <td className="py-3 text-right">{filteredResults.reduce((s, r) => s + r.pnl_current, 0) > 0 ? formatCurrency(filteredResults.reduce((s, r) => s + r.pnl_current, 0)) : '-'}</td>
                    <td className="py-3 text-right">{formatCurrency(filteredResults.reduce((s, r) => s + r.commissions_earned, 0))}</td>
                    <td className="py-3 text-right">{filteredResults.reduce((s, r) => s + r.bonus, 0) > 0 ? formatCurrency(filteredResults.reduce((s, r) => s + r.bonus, 0)) : '-'}</td>
                    <td className="py-3 text-right">{filteredResults.reduce((s, r) => s + r.salary_paid, 0) > 0 ? formatCurrency(filteredResults.reduce((s, r) => s + r.salary_paid, 0)) : '-'}</td>
                    <td className="py-3 text-right text-[var(--color-primary)]">{formatCurrency(totalCommissionsFiltered)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
