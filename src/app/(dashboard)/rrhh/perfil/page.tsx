'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Card, CardTitle, CardValue } from '@/components/ui/card';
import { getProfileById, getMonthlyResults, getProfilesByHead, ROLE_LABELS_HR, getTotalCommissions, DEMO_COMMERCIAL_PROFILES } from '@/lib/hr-data';
import { DEMO_PERIODS } from '@/lib/demo-data';
import { formatCurrency } from '@/lib/utils';
import { downloadCSV } from '@/lib/csv-export';
import { useI18n } from '@/lib/i18n';
import type { CommercialProfile, CommercialMonthlyResult } from '@/lib/types';
import { ArrowLeft, Download, Mail, DollarSign, TrendingUp, UserCircle, Users, Calendar, Gift, Plus, Check, Pencil, X } from 'lucide-react';

function formatDateDMY(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export default function PerfilPage() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const profileId = searchParams.get('id');

  if (!profileId) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <p>{t('hr.noProfileSpecified')}</p>
        <Link href="/rrhh" className="text-[var(--color-primary)] hover:underline mt-2 inline-block">{t('hr.backToHr')}</Link>
      </div>
    );
  }

  const profile = getProfileById(profileId);
  if (!profile) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <p>{t('hr.profileNotFound')}</p>
        <Link href="/rrhh" className="text-[var(--color-primary)] hover:underline mt-2 inline-block">{t('hr.backToHr')}</Link>
      </div>
    );
  }

  const initialResults = getMonthlyResults(profileId);
  const [results, setResults] = useState<CommercialMonthlyResult[]>(initialResults);
  const [showAddForm, setShowAddForm] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [profileData, setProfileData] = useState<CommercialProfile>(profile);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [editName, setEditName] = useState(profile.name);
  const [editEmail, setEditEmail] = useState(profile.email);
  const [editRole, setEditRole] = useState(profile.role);
  const [editHeadId, setEditHeadId] = useState(profile.head_id || '');
  const [editNdPct, setEditNdPct] = useState(profile.net_deposit_pct?.toString() || '');
  const [editPnlPct, setEditPnlPct] = useState(profile.pnl_pct?.toString() || '');
  const [editCommLot, setEditCommLot] = useState(profile.commission_per_lot?.toString() || '');
  const [editSalary, setEditSalary] = useState(profile.salary?.toString() || '');
  const [editBenefits, setEditBenefits] = useState(profile.benefits || '');
  const [editComments, setEditComments] = useState(profile.comments || '');
  const [editHireDate, setEditHireDate] = useState(profile.hire_date || '');
  const [editBirthday, setEditBirthday] = useState(profile.birthday || '');
  const [editStatus, setEditStatus] = useState(profile.status);

  const possibleHeads = DEMO_COMMERCIAL_PROFILES.filter(p => p.role === 'sales_manager' || p.role === 'head');

  const handleSaveProfile = () => {
    const updated: CommercialProfile = {
      ...profileData,
      name: editName,
      email: editEmail,
      role: editRole,
      head_id: editHeadId || null,
      net_deposit_pct: editNdPct ? parseFloat(editNdPct) : null,
      pnl_pct: editPnlPct ? parseFloat(editPnlPct) : null,
      commission_per_lot: editCommLot ? parseFloat(editCommLot) : null,
      salary: editSalary ? parseFloat(editSalary) : null,
      benefits: editBenefits || null,
      comments: editComments || null,
      hire_date: editHireDate || null,
      birthday: editBirthday || null,
      status: editStatus,
    };
    setProfileData(updated);
    setIsEditingProfile(false);
  };

  const handleCancelEdit = () => {
    setEditName(profileData.name);
    setEditEmail(profileData.email);
    setEditRole(profileData.role);
    setEditHeadId(profileData.head_id || '');
    setEditNdPct(profileData.net_deposit_pct?.toString() || '');
    setEditPnlPct(profileData.pnl_pct?.toString() || '');
    setEditCommLot(profileData.commission_per_lot?.toString() || '');
    setEditSalary(profileData.salary?.toString() || '');
    setEditBenefits(profileData.benefits || '');
    setEditComments(profileData.comments || '');
    setEditHireDate(profileData.hire_date || '');
    setEditBirthday(profileData.birthday || '');
    setEditStatus(profileData.status);
    setIsEditingProfile(false);
  };

  // Add form state
  const [formPeriod, setFormPeriod] = useState(DEMO_PERIODS[DEMO_PERIODS.length - 1]?.id || '');
  const [formNetDepCurrent, setFormNetDepCurrent] = useState(0);
  const [formNetDepAccum, setFormNetDepAccum] = useState(0);
  const [formNetDepTotal, setFormNetDepTotal] = useState(0);
  const [formPnlCurrent, setFormPnlCurrent] = useState(0);
  const [formPnlAccum, setFormPnlAccum] = useState(0);
  const [formPnlTotal, setFormPnlTotal] = useState(0);
  const [formCommissions, setFormCommissions] = useState(0);
  const [formBonus, setFormBonus] = useState(0);
  const [formSalary, setFormSalary] = useState(0);

  const formTotalEarned = formCommissions + formBonus + formSalary;

  const subordinates = getProfilesByHead(profileId);
  const totalEarned = results.reduce((s, r) => s + r.total_earned, 0);
  const totalCommissions = results.reduce((s, r) => s + r.commissions_earned, 0);
  const totalPnlCurrent = results.reduce((s, r) => s + r.pnl_current, 0);
  const totalBonus = results.reduce((s, r) => s + r.bonus, 0);
  const totalSalary = results.reduce((s, r) => s + r.salary_paid, 0);
  const totalNetDeposit = results.reduce((s, r) => s + r.net_deposit_current, 0);

  const getPeriodLabel = (periodId: string) => {
    const p = DEMO_PERIODS.find(pp => pp.id === periodId);
    return p?.label || periodId;
  };

  const handleExport = () => {
    const headers = [t('hr.period'), t('hr.netDepCurrent'), t('hr.accumulated'), t('hr.total'), t('hr.pnlCurrent'), t('hr.pnlAccumulated'), t('hr.pnlTotal'), t('hr.commissions'), t('hr.bonus'), t('hr.salary'), t('hr.totalEarned')];
    const rows = results.map(r => [
      getPeriodLabel(r.period_id),
      r.net_deposit_current, r.net_deposit_accumulated, r.net_deposit_total,
      r.pnl_current, r.pnl_accumulated, r.pnl_total, r.commissions_earned, r.bonus, r.salary_paid, r.total_earned,
    ] as (string | number)[]);
    rows.push(['TOTAL', totalNetDeposit, '', '', totalPnlCurrent, '', '', totalCommissions, totalBonus, totalSalary, totalEarned]);
    downloadCSV(`resultados_${profileData.name.replace(/\s/g, '_')}.csv`, headers, rows);
  };

  const handleSaveResult = () => {
    const newResult: CommercialMonthlyResult = {
      id: `mr-${Date.now()}`,
      profile_id: profileId,
      period_id: formPeriod,
      net_deposit_current: formNetDepCurrent,
      net_deposit_accumulated: formNetDepAccum,
      net_deposit_total: formNetDepTotal,
      pnl_current: formPnlCurrent,
      pnl_accumulated: formPnlAccum,
      pnl_total: formPnlTotal,
      commissions_earned: formCommissions,
      bonus: formBonus,
      salary_paid: formSalary,
      total_earned: formTotalEarned,
    };
    setResults(prev => [...prev, newResult]);
    setShowAddForm(false);
    setSuccessMsg(t('hr.resultSaved'));
    setTimeout(() => setSuccessMsg(''), 3000);
    // Reset form
    setFormNetDepCurrent(0);
    setFormNetDepAccum(0);
    setFormNetDepTotal(0);
    setFormPnlCurrent(0);
    setFormPnlAccum(0);
    setFormPnlTotal(0);
    setFormCommissions(0);
    setFormBonus(0);
    setFormSalary(0);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/rrhh" className="p-2 rounded-lg hover:bg-muted transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-violet-100 dark:bg-violet-950/50 flex items-center justify-center">
              <UserCircle className="w-7 h-7 text-violet-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">{profileData.name}</h1>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="px-2 py-0.5 rounded-full bg-violet-50 dark:bg-violet-950/50 text-violet-700 text-xs font-medium">
                  {ROLE_LABELS_HR[profileData.role]}
                </span>
                <Mail className="w-3 h-3" />
                <span>{profileData.email}</span>
              </div>
              {(profileData.hire_date || profileData.birthday) && (
                <div className="flex items-center gap-4 text-xs text-muted-foreground mt-1">
                  {profileData.hire_date && (
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {t('hr.hireDate')}: {formatDateDMY(profileData.hire_date)}
                    </span>
                  )}
                  {profileData.birthday && (
                    <span className="flex items-center gap-1">
                      <Gift className="w-3 h-3" />
                      {t('hr.birthday')}: {formatDateDMY(profileData.birthday)}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        <button
          onClick={handleExport}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
          title={t('hr.downloadCsv')}
        >
          <Download className="w-4 h-4" />
          CSV
        </button>
      </div>

      {/* Profile Info Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950/50"><TrendingUp className="w-5 h-5 text-blue-500" /></div>
            <CardTitle>{t('hr.netDepPct')}</CardTitle>
          </div>
          <CardValue>{profileData.net_deposit_pct != null ? `${profileData.net_deposit_pct}%` : 'N/A'}</CardValue>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/50"><TrendingUp className="w-5 h-5 text-emerald-500" /></div>
            <CardTitle>{t('hr.pnlPct')}</CardTitle>
          </div>
          <CardValue>{profileData.pnl_pct != null ? `${profileData.pnl_pct}%` : 'N/A'}</CardValue>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950/50"><DollarSign className="w-5 h-5 text-amber-500" /></div>
            <CardTitle>{t('hr.fixedSalary')}</CardTitle>
          </div>
          <CardValue>{profileData.salary != null ? formatCurrency(profileData.salary) : 'N/A'}</CardValue>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-violet-50 dark:bg-violet-950/50"><DollarSign className="w-5 h-5 text-violet-500" /></div>
            <CardTitle>{t('hr.totalEarned')}</CardTitle>
          </div>
          <CardValue>{formatCurrency(totalEarned)}</CardValue>
        </Card>
      </div>

      {/* Profile Details */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">{t('hr.profileDetails')}</h2>
          {!isEditingProfile ? (
            <button
              onClick={() => setIsEditingProfile(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
              {t('hr.editProfile')}
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button onClick={handleCancelEdit} className="px-3 py-1.5 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors">
                <X className="w-4 h-4" />
              </button>
              <button onClick={handleSaveProfile} className="px-4 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90">
                {t('common.save')}
              </button>
            </div>
          )}
        </div>

        {isEditingProfile ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">{t('common.name')}</label>
              <input value={editName} onChange={e => setEditName(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">{t('common.email')}</label>
              <input value={editEmail} onChange={e => setEditEmail(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">{t('hr.role')}</label>
              <select value={editRole} onChange={e => setEditRole(e.target.value as CommercialProfile['role'])} className="px-3 py-2 rounded-lg border border-border bg-card text-sm">
                <option value="sales_manager">Sales Manager</option>
                <option value="head">HEAD</option>
                <option value="bdm">BDM</option>
              </select>
            </div>
            {editRole === 'bdm' && (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">{t('hr.supervisor')}</label>
                <select value={editHeadId} onChange={e => setEditHeadId(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm">
                  <option value="">{t('hr.noSupervisor')}</option>
                  {possibleHeads.map(h => (
                    <option key={h.id} value={h.id}>{h.name} ({ROLE_LABELS_HR[h.role]})</option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">{t('hr.netDepPct')}</label>
              <input type="number" value={editNdPct} onChange={e => setEditNdPct(e.target.value)} placeholder={t('hr.ndPctPlaceholder')} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">{t('hr.pnlPct')}</label>
              <input type="number" value={editPnlPct} onChange={e => setEditPnlPct(e.target.value)} placeholder={t('hr.pnlPctPlaceholder')} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">{t('hr.commissionPerLot')}</label>
              <input type="number" value={editCommLot} onChange={e => setEditCommLot(e.target.value)} placeholder={t('hr.commLotPlaceholder')} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">{t('hr.fixedSalary')}</label>
              <input type="number" value={editSalary} onChange={e => setEditSalary(e.target.value)} placeholder={t('hr.salaryUsdPlaceholder')} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">{t('hr.benefits')}</label>
              <input value={editBenefits} onChange={e => setEditBenefits(e.target.value)} placeholder={t('hr.benefitsPlaceholder')} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">{t('hr.comments')}</label>
              <input value={editComments} onChange={e => setEditComments(e.target.value)} placeholder={t('hr.commentsPlaceholder')} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">{t('hr.hireDate')}</label>
              <input type="date" value={editHireDate} onChange={e => setEditHireDate(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">{t('hr.birthday')}</label>
              <input type="date" value={editBirthday} onChange={e => setEditBirthday(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">{t('hr.status')}</label>
              <select value={editStatus} onChange={e => setEditStatus(e.target.value as 'active' | 'inactive')} className="px-3 py-2 rounded-lg border border-border bg-card text-sm">
                <option value="active">{t('hr.statusActive')}</option>
                <option value="inactive">{t('hr.statusInactive')}</option>
              </select>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-3 text-sm">
            <div>
              <span className="text-muted-foreground">{t('common.name')}:</span>{' '}
              <span className="font-medium">{profileData.name}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('common.email')}:</span>{' '}
              <span className="font-medium">{profileData.email}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('hr.role')}:</span>{' '}
              <span className="font-medium">{ROLE_LABELS_HR[profileData.role]}</span>
            </div>
            {profileData.role === 'bdm' && profileData.head_id && (
              <div>
                <span className="text-muted-foreground">{t('hr.supervisor')}:</span>{' '}
                <span className="font-medium">{possibleHeads.find(h => h.id === profileData.head_id)?.name || '-'}</span>
              </div>
            )}
            <div>
              <span className="text-muted-foreground">{t('hr.netDepPct')}:</span>{' '}
              <span className="font-medium">{profileData.net_deposit_pct != null ? `${profileData.net_deposit_pct}%` : 'N/A'}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('hr.pnlPct')}:</span>{' '}
              <span className="font-medium">{profileData.pnl_pct != null ? `${profileData.pnl_pct}%` : 'N/A'}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('hr.commissionPerLot')}:</span>{' '}
              <span className="font-medium">{profileData.commission_per_lot != null ? `$${profileData.commission_per_lot}` : 'N/A'}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('hr.fixedSalary')}:</span>{' '}
              <span className="font-medium">{profileData.salary != null ? formatCurrency(profileData.salary) : 'N/A'}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('hr.benefits')}:</span>{' '}
              <span className="font-medium">{profileData.benefits || '-'}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('hr.comments')}:</span>{' '}
              <span className="font-medium">{profileData.comments || '-'}</span>
            </div>
            <div className="flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">{t('hr.hireDate')}:</span>{' '}
              <span className="font-medium">{profileData.hire_date ? formatDateDMY(profileData.hire_date) : '-'}</span>
            </div>
            <div className="flex items-center gap-1">
              <Gift className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">{t('hr.birthday')}:</span>{' '}
              <span className="font-medium">{profileData.birthday ? formatDateDMY(profileData.birthday) : '-'}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('hr.status')}:</span>{' '}
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${profileData.status === 'active' ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400' : 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-400'}`}>
                {profileData.status === 'active' ? t('hr.statusActive') : t('hr.statusInactive')}
              </span>
            </div>
          </div>
        )}
      </Card>

      {/* Subordinates */}
      {subordinates.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <Users className="w-5 h-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">{t('hr.team')} ({subordinates.length} BDMs)</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 text-muted-foreground font-medium">{t('common.name')}</th>
                  <th className="text-left py-2 text-muted-foreground font-medium">{t('common.email')}</th>
                  <th className="text-right py-2 text-muted-foreground font-medium">{t('hr.netDepPct')}</th>
                  <th className="text-right py-2 text-muted-foreground font-medium">{t('hr.totalEarned')}</th>
                </tr>
              </thead>
              <tbody>
                {subordinates.map(sub => (
                  <tr key={sub.id} className="border-b border-border/50">
                    <td className="py-2.5">
                      <Link href={`/rrhh/perfil?id=${sub.id}`} className="font-medium hover:text-[var(--color-primary)] transition-colors">
                        {sub.name}
                      </Link>
                    </td>
                    <td className="py-2.5 text-muted-foreground text-xs">{sub.email}</td>
                    <td className="py-2.5 text-right">{sub.net_deposit_pct != null ? `${sub.net_deposit_pct}%` : 'N/A'}</td>
                    <td className="py-2.5 text-right font-medium">{formatCurrency(getTotalCommissions(sub.id))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Add Monthly Result Form */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">{t('hr.addMonthlyResult')}</h2>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
          >
            <Plus className="w-4 h-4" />
            {t('hr.addMonthlyResult')}
          </button>
        </div>

        {successMsg && (
          <div className="flex items-center gap-2 mb-4 p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 text-sm">
            <Check className="w-4 h-4" />
            {successMsg}
          </div>
        )}

        {showAddForm && (
          <div className="border border-border rounded-lg p-4 bg-muted/30">
            <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">{t('hr.selectPeriod')}</label>
                <select value={formPeriod} onChange={e => setFormPeriod(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm">
                  {DEMO_PERIODS.map(p => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">{t('hr.netDepActual')}</label>
                <input type="number" value={formNetDepCurrent} onChange={e => setFormNetDepCurrent(parseFloat(e.target.value) || 0)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">{t('hr.netDepAcumulado')}</label>
                <input type="number" value={formNetDepAccum} onChange={e => setFormNetDepAccum(parseFloat(e.target.value) || 0)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">{t('hr.netDepTotal')}</label>
                <input type="number" value={formNetDepTotal} onChange={e => setFormNetDepTotal(parseFloat(e.target.value) || 0)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">{t('hr.pnlCurrent')}</label>
                <input type="number" value={formPnlCurrent} onChange={e => setFormPnlCurrent(parseFloat(e.target.value) || 0)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">{t('hr.pnlAccumulated')}</label>
                <input type="number" value={formPnlAccum} onChange={e => setFormPnlAccum(parseFloat(e.target.value) || 0)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">{t('hr.pnlTotal')}</label>
                <input type="number" value={formPnlTotal} onChange={e => setFormPnlTotal(parseFloat(e.target.value) || 0)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">{t('hr.comisiones')}</label>
                <input type="number" value={formCommissions} onChange={e => setFormCommissions(parseFloat(e.target.value) || 0)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">{t('hr.bonus')}</label>
                <input type="number" value={formBonus} onChange={e => setFormBonus(parseFloat(e.target.value) || 0)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">{t('hr.salarioLabel')}</label>
                <input type="number" value={formSalary} onChange={e => setFormSalary(parseFloat(e.target.value) || 0)} className="px-3 py-2 rounded-lg border border-border bg-card text-sm" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">{t('hr.totalEarned')} ({t('hr.totalEarnedAuto')})</label>
                <input type="text" value={formatCurrency(formTotalEarned)} readOnly className="px-3 py-2 rounded-lg border border-border bg-muted text-sm font-medium" />
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button onClick={handleSaveResult} className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90">
                {t('common.save')}
              </button>
            </div>
          </div>
        )}
      </Card>

      {/* Monthly Results */}
      <Card>
        <h2 className="text-lg font-semibold mb-4">{t('hr.monthlyResults')}</h2>
        {results.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 text-muted-foreground font-medium" rowSpan={2}>{t('hr.period')}</th>
                  <th className="text-center py-2 text-muted-foreground font-medium border-b border-border" colSpan={3}>{t('hr.netDeposit')}</th>
                  <th className="text-center py-2 text-muted-foreground font-medium border-b border-border" colSpan={3}>PNL</th>
                  <th className="text-right py-2 text-muted-foreground font-medium" rowSpan={2}>{t('hr.commissions')}</th>
                  <th className="text-right py-2 text-muted-foreground font-medium" rowSpan={2}>{t('hr.bonus')}</th>
                  <th className="text-right py-2 text-muted-foreground font-medium" rowSpan={2}>{t('hr.salaryCol')}</th>
                  <th className="text-right py-2 text-muted-foreground font-medium font-bold" rowSpan={2}>{t('hr.totalEarned')}</th>
                </tr>
                <tr className="border-b border-border">
                  <th className="text-right py-1 text-muted-foreground font-medium text-xs">{t('hr.netDepActual')}</th>
                  <th className="text-right py-1 text-muted-foreground font-medium text-xs">{t('hr.accumulated')}</th>
                  <th className="text-right py-1 text-muted-foreground font-medium text-xs">{t('hr.total')}</th>
                  <th className="text-right py-1 text-muted-foreground font-medium text-xs">{t('hr.pnlCurrent')}</th>
                  <th className="text-right py-1 text-muted-foreground font-medium text-xs">{t('hr.pnlAccumulated')}</th>
                  <th className="text-right py-1 text-muted-foreground font-medium text-xs">{t('hr.pnlTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {results.map(r => (
                  <tr key={r.id} className="border-b border-border/50">
                    <td className="py-2.5 font-medium">{getPeriodLabel(r.period_id)}</td>
                    <td className="py-2.5 text-right">{formatCurrency(r.net_deposit_current)}</td>
                    <td className="py-2.5 text-right">{formatCurrency(r.net_deposit_accumulated)}</td>
                    <td className="py-2.5 text-right">{formatCurrency(r.net_deposit_total)}</td>
                    <td className="py-2.5 text-right">{r.pnl_current > 0 ? formatCurrency(r.pnl_current) : '-'}</td>
                    <td className="py-2.5 text-right">{r.pnl_accumulated > 0 ? formatCurrency(r.pnl_accumulated) : '-'}</td>
                    <td className="py-2.5 text-right">{r.pnl_total > 0 ? formatCurrency(r.pnl_total) : '-'}</td>
                    <td className="py-2.5 text-right">{formatCurrency(r.commissions_earned)}</td>
                    <td className="py-2.5 text-right">{r.bonus > 0 ? formatCurrency(r.bonus) : '-'}</td>
                    <td className="py-2.5 text-right">{r.salary_paid > 0 ? formatCurrency(r.salary_paid) : '-'}</td>
                    <td className="py-2.5 text-right font-bold">{formatCurrency(r.total_earned)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-bold border-t-2 border-border">
                  <td className="py-3">TOTAL</td>
                  <td className="py-3 text-right">{formatCurrency(totalNetDeposit)}</td>
                  <td className="py-3 text-right">-</td>
                  <td className="py-3 text-right">-</td>
                  <td className="py-3 text-right">{totalPnlCurrent > 0 ? formatCurrency(totalPnlCurrent) : '-'}</td>
                  <td className="py-3 text-right">-</td>
                  <td className="py-3 text-right">-</td>
                  <td className="py-3 text-right">{formatCurrency(totalCommissions)}</td>
                  <td className="py-3 text-right">{totalBonus > 0 ? formatCurrency(totalBonus) : '-'}</td>
                  <td className="py-3 text-right">{totalSalary > 0 ? formatCurrency(totalSalary) : '-'}</td>
                  <td className="py-3 text-right text-[var(--color-primary)]">{formatCurrency(totalEarned)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <p className="text-center text-muted-foreground py-8">{t('hr.noResults')}</p>
        )}
      </Card>
    </div>
  );
}
