'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { ROLE_LABELS_HR } from '@/lib/hr-data';
import { useData } from '@/lib/data-context';
import { formatCurrency } from '@/lib/utils';
import { formatDate } from '@/lib/dates';
import { downloadCSV } from '@/lib/csv-export';
import { cn } from '@/lib/utils';
import type { Employee, CommercialProfile, CommercialMonthlyResult, Negotiation, NegotiationStatus, CommercialRole } from '@/lib/types';
import { createCommercialProfile, updateCommercialProfile, deleteCommercialProfile, deleteEmployee } from '@/lib/supabase/mutations';
import { withActiveCompany } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { Users, Briefcase, Download, ChevronRight, UserCircle, Plus, X, Pencil, Trash2, CheckCircle, AlertCircle, Upload, FileText, ExternalLink, Handshake, Search, UserX, UserCheck } from 'lucide-react';
import { FireModal } from '@/components/fire-modal';
import { FiredBadge, firedNameClass } from '@/components/fired-badge';

type Tab = 'employees' | 'commercial' | 'negotiations';

const STATUS_BADGE_CLASSES: Record<string, string> = {
  active: 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400',
  inactive: 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-400',
  probation: 'bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400',
  fired: 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400',
};

const STATUS_LABEL_KEYS: Record<string, string> = {
  active: 'hr.statusActive',
  inactive: 'hr.statusInactive',
  probation: 'hr.statusProbation',
  fired: 'hr.statusFired',
};

const ROLE_BADGE_COLORS: Record<string, string> = {
  sales_manager: 'bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400',
  head: 'bg-violet-50 dark:bg-violet-950/50 text-violet-700 dark:text-violet-400',
  bdm: 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400',
};

const DEFAULT_ROLE_BADGE = 'bg-gray-50 dark:bg-gray-900/50 text-gray-700 dark:text-gray-400';
const getRoleBadge = (role: string) => ROLE_BADGE_COLORS[role] || DEFAULT_ROLE_BADGE;

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
function EmployeeForm({ onClose, onSave, editing, companyId }: { onClose: () => void; onSave: (e: Employee) => void; editing?: Employee; companyId: string }) {
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
      company_id: editing?.company_id || companyId,
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
function ProfileForm({ onClose, editing, companyId }: { onClose: () => void; editing?: CommercialProfile; companyId: string }) {
  const { t } = useI18n();
  const { commercialProfiles, refresh } = useData();
  const [name, setName] = useState(editing?.name || '');
  const [email, setEmail] = useState(editing?.email || '');
  const [role, setRole] = useState(editing?.role || 'bdm');
  const [headId, setHeadId] = useState(editing?.head_id || '');
  const [ndPct, setNdPct] = useState(editing?.net_deposit_pct?.toString() || '');
  const [pnlPct, setPnlPct] = useState(editing?.pnl_pct?.toString() || '');
  const [commLot, setCommLot] = useState(editing?.commission_per_lot?.toString() || '');
  const [salary, setSalary] = useState(editing?.salary?.toString() || '');
  const [fixedSalary, setFixedSalary] = useState(editing?.fixed_salary ?? false);
  const [extraPct, setExtraPct] = useState(editing?.extra_pct?.toString() || '');
  const [benefits, setBenefits] = useState(editing?.benefits || '');
  const [comments, setComments] = useState(editing?.comments || '');
  const [hireDate, setHireDate] = useState(editing?.hire_date || '');
  const [birthday, setBirthday] = useState(editing?.birthday || '');
  const [terminationDate, setTerminationDate] = useState(editing?.termination_date || '');
  const [terminationReason, setTerminationReason] = useState(editing?.termination_reason || '');
  const [terminationCategory, setTerminationCategory] = useState<string>(editing?.termination_category || '');
  const { user: authUser } = useAuth();
  const [status, setStatus] = useState<'active' | 'inactive'>(editing?.status || 'active');
  const [contractUrl, setContractUrl] = useState(editing?.contract_url || '');
  const [contractFile, setContractFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [localSaving, setLocalSaving] = useState(false);
  const [error, setError] = useState('');

  const possibleHeads = commercialProfiles.filter(p => p.role === 'sales_manager' || p.role === 'head');

  const uploadContract = async (profileId: string) => {
    if (!contractFile) return;
    setUploading(true);
    const formData = new FormData();
    formData.append('file', contractFile);
    formData.append('profile_id', profileId);
    const res = await fetch(withActiveCompany('/api/admin/upload-contract'), { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Error subiendo contrato');
    setContractUrl(data.url);
    setUploading(false);
  };

  // The form handles save directly — no parent dependency
  const handleSubmit = async () => {
    if (!name || !email || localSaving) return;
    setLocalSaving(true);
    setError('');
    try {
      // Full payload — shared between create and update so both code paths
      // persist the same set of editable fields. Previously the update path
      // omitted commission_per_lot, benefits, comments, hire_date and
      // birthday, so edits to those fields were silently dropped.
      const payload = {
        name, email, role,
        head_id: headId || null,
        net_deposit_pct: ndPct ? parseFloat(ndPct) : null,
        pnl_pct: pnlPct ? parseFloat(pnlPct) : null,
        salary: salary ? parseFloat(salary) : null,
        fixed_salary: fixedSalary,
        extra_pct: extraPct ? parseFloat(extraPct) : null,
        status,
        commission_per_lot: commLot ? parseFloat(commLot) : null,
        benefits: benefits || null,
        comments: comments || null,
        hire_date: hireDate || null,
        birthday: birthday || null,
        termination_date: terminationDate || null,
        termination_reason: terminationReason || null,
        termination_category: terminationCategory || null,
        // `terminated_by` solo se setea desde FireModal (que conoce al
        // usuario que ejecuta el despido). Este form NO lo sobreescribe
        // — preservamos el valor original que ya hay en editing.
        terminated_by: editing?.terminated_by || null,
      };
      let profileId = editing?.id;
      if (profileId) {
        await updateCommercialProfile(profileId, payload);
      } else {
        profileId = await createCommercialProfile(companyId, payload);
      }
      // Upload contract if a file was selected
      if (contractFile && profileId) {
        await uploadContract(profileId);
      }
      onClose();
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar');
      setLocalSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-card rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-lg">{editing ? t('hr.editProfile') : t('hr.newProfile')}</h3>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-muted"><X className="w-5 h-5" /></button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.namePlaceholder')}</label>
            <input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.emailPlaceholder')}</label>
            <input value={email} onChange={e => setEmail(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.role')}</label>
            <select value={role} onChange={e => setRole(e.target.value as 'sales_manager' | 'head' | 'bdm')} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]">
              <option value="sales_manager">Sales Manager</option>
              <option value="head">HEAD</option>
              <option value="bdm">BDM</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.supervisor')}</label>
            <select value={headId} onChange={e => setHeadId(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]">
              <option value="">{t('hr.noSupervisor')}</option>
              {possibleHeads.filter(h => h.id !== editing?.id).map(h => (
                <option key={h.id} value={h.id}>{h.name} ({ROLE_LABELS_HR[h.role]})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.ndPctPlaceholder')}</label>
            <input type="number" value={ndPct} onChange={e => setNdPct(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.pnlPctPlaceholder')}</label>
            <input type="number" value={pnlPct} onChange={e => setPnlPct(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.commLotPlaceholder')}</label>
            <input type="number" value={commLot} onChange={e => setCommLot(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
          </div>
          <p className="text-xs text-muted-foreground italic px-1 -mt-1">{t('hr.commMethodHint')}</p>
          <div>
            <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground mb-1 cursor-pointer">
              <input type="checkbox" checked={fixedSalary} onChange={e => setFixedSalary(e.target.checked)} className="rounded border-border" />
              Salario fijo (no depende de ND)
            </label>
            {fixedSalary && (
              <input type="number" placeholder="Monto USD" value={salary} onChange={e => setSalary(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
            )}
          </div>
          {(role === 'head' || role === 'sales_manager') && (
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.extraPct')}</label>
              <input type="number" step="0.01" value={extraPct} onChange={e => setExtraPct(e.target.value)} placeholder="0" className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.benefitsPlaceholder')}</label>
            <input value={benefits} onChange={e => setBenefits(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.commentsPlaceholder')}</label>
            <input value={comments} onChange={e => setComments(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.hireDatePlaceholder')}</label>
            <input type="date" value={hireDate} onChange={e => setHireDate(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.terminationDate')}</label>
            <input type="date" value={terminationDate} onChange={e => setTerminationDate(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
            <p className="text-[10px] text-muted-foreground mt-1 leading-tight">
              {t('hr.terminationDateHint')}
            </p>
          </div>

          {/* Sección despido — visible siempre que haya termination_date o el
              status esté en 'inactive'. Permite editar razón/categoría y, si
              el caller es admin, reincorporar al empleado en un click. */}
          {(terminationDate || status === 'inactive') && (
            <div className="md:col-span-2 border-t border-border pt-3 mt-2">
              <div className="flex items-center justify-between mb-2">
                <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  {t('hr.terminationSection')}
                </label>
                {editing?.status === 'inactive' && editing?.termination_date && authUser?.effective_role === 'admin' && (
                  <button
                    type="button"
                    onClick={async () => {
                      if (!editing) return;
                      if (!confirm(t('hr.reinstateMessage'))) return;
                      try {
                        await updateCommercialProfile(editing.id, {
                          status: 'active',
                          termination_date: null,
                          termination_reason: null,
                          termination_category: null,
                          terminated_by: null,
                        });
                        onClose();
                        // Consistente con el resto de ProfileForm, que usa
                        // reload en success. El flujo del tab Empleados
                        // (silent refresh) vive aparte en el componente
                        // padre y pasa por handleReinstate/handleFireSuccess.
                        window.location.reload();
                      } catch (err) {
                        setError(err instanceof Error ? err.message : t('hr.fireError'));
                      }
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-emerald-300 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/50"
                  >
                    {t('hr.reinstate')}
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.fireCategoryLabel')}</label>
                  <select
                    value={terminationCategory}
                    onChange={e => setTerminationCategory(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                  >
                    <option value="">—</option>
                    <option value="performance">{t('hr.categoryPerformance')}</option>
                    <option value="misconduct">{t('hr.categoryMisconduct')}</option>
                    <option value="voluntary">{t('hr.categoryVoluntary')}</option>
                    <option value="restructuring">{t('hr.categoryRestructuring')}</option>
                    <option value="other">{t('hr.categoryOther')}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.fireReasonLabel')}</label>
                  <textarea
                    value={terminationReason}
                    onChange={e => setTerminationReason(e.target.value)}
                    rows={2}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm resize-none"
                    placeholder={t('hr.fireReasonPlaceholder')}
                  />
                </div>
              </div>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.birthdayPlaceholder')}</label>
            <input type="date" value={birthday} onChange={e => setBirthday(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.status')}</label>
            <select value={status} onChange={e => setStatus(e.target.value as 'active' | 'inactive')} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]">
              <option value="active">{t('hr.statusActive')}</option>
              <option value="inactive">{t('hr.statusInactive')}</option>
            </select>
          </div>
        </div>
        {/* Contract upload section */}
        <div className="mt-4 border-t border-border pt-4">
          <label className="block text-xs font-medium text-muted-foreground mb-2">Contrato firmado</label>
          {contractUrl && !contractFile && (
            <div className="flex items-center gap-2 mb-2 p-2 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg">
              <FileText className="w-4 h-4 text-emerald-600" />
              <span className="text-sm text-emerald-700 dark:text-emerald-400 flex-1">Contrato cargado</span>
              <a href={contractUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                Ver <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          )}
          <div className="flex items-center gap-2">
            <label className="flex-1 cursor-pointer">
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border hover:border-[var(--color-secondary)] hover:bg-muted/50 transition-colors">
                <Upload className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  {contractFile ? contractFile.name : (contractUrl ? 'Cambiar contrato...' : 'Subir contrato (PDF, máx 10 MB)')}
                </span>
              </div>
              <input type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg" className="hidden" onChange={(e) => setContractFile(e.target.files?.[0] || null)} />
            </label>
            {contractFile && (
              <button onClick={() => setContractFile(null)} className="p-1 rounded hover:bg-muted">
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            )}
          </div>
        </div>
        {error && <p className="mt-4 text-sm text-red-600 bg-red-50 dark:bg-red-950/30 px-3 py-2 rounded-lg">{error}</p>}
        <div className="mt-4 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors">
            {t('common.cancel')}
          </button>
          <button onClick={handleSubmit} disabled={localSaving || uploading} className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50">
            {uploading ? 'Subiendo contrato...' : localSaving ? t('hr.saving') : (editing ? t('common.save') : t('common.add'))}
          </button>
        </div>
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

// ─── Negotiation Form Modal ───
type NegFormData = {
  title: string;
  description: string;
  status: NegotiationStatus;
  profile_id: string;
  newProfile?: { name: string; email: string; role: string };
  contractFile?: File | null;
};

function NegotiationForm({ onClose, onSave, editing, profiles, saving, errorMsg }: {
  onClose: () => void;
  onSave: (n: NegFormData) => void;
  editing?: Negotiation;
  profiles: CommercialProfile[];
  saving?: boolean;
  errorMsg?: string;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(editing?.title || '');
  const [description, setDescription] = useState(editing?.description || '');
  const [status, setStatus] = useState<NegotiationStatus>(editing?.status || 'active');
  const [profileId, setProfileId] = useState(editing?.profile_id || profiles[0]?.id || '');
  const [mode, setMode] = useState<'existing' | 'new'>('existing');

  // New profile fields
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState('');
  const [contractFile, setContractFile] = useState<File | null>(null);

  const canSubmit = title && (mode === 'existing' ? !!profileId : (!!newName && !!newEmail));

  const handleSubmit = () => {
    if (!canSubmit || saving) return;
    if (mode === 'new') {
      onSave({ title, description, status, profile_id: '', newProfile: { name: newName, email: newEmail, role: newRole }, contractFile });
    } else {
      onSave({ title, description, status, profile_id: profileId, contractFile });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-card rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-lg">{editing ? t('hr.editNegotiation') : t('hr.newNegotiation')}</h3>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-muted"><X className="w-5 h-5" /></button>
        </div>
        <div className="space-y-4">
          {/* Profile selection — existing or new */}
          {!editing && (
            <div className="space-y-3">
              <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.selectProfile')}</label>
              {/* Toggle tabs */}
              <div className="flex gap-1 bg-muted p-1 rounded-lg w-fit">
                <button
                  type="button"
                  onClick={() => setMode('existing')}
                  className={cn(
                    'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                    mode === 'existing' ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Users className="w-3.5 h-3.5 inline mr-1" />
                  Existente
                </button>
                <button
                  type="button"
                  onClick={() => setMode('new')}
                  className={cn(
                    'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                    mode === 'new' ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Plus className="w-3.5 h-3.5 inline mr-1" />
                  Crear nuevo
                </button>
              </div>

              {mode === 'existing' ? (
                <select value={profileId} onChange={e => setProfileId(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]">
                  {profiles.map(p => (
                    <option key={p.id} value={p.id}>{p.name} ({p.role.toUpperCase()})</option>
                  ))}
                </select>
              ) : (
                <div className="border border-border rounded-lg p-3 bg-muted/30 space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-medium text-muted-foreground mb-1">{t('common.name')} *</label>
                      <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Nombre completo" className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium text-muted-foreground mb-1">{t('common.email')} *</label>
                      <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="correo@ejemplo.com" className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium text-muted-foreground mb-1">{t('hr.role')}</label>
                    <input value={newRole} onChange={e => setNewRole(e.target.value)} placeholder="Ej: BDM, Closer, Setter, Trader..." className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
                  </div>
                </div>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.negotiationTitle')}</label>
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder={t('hr.titlePlaceholder')} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.negotiationDesc')}</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder={t('hr.descriptionPlaceholder')} rows={3} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)] resize-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.negotiationStatus')}</label>
            <select value={status} onChange={e => setStatus(e.target.value as NegotiationStatus)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]">
              <option value="active">{t('hr.negStatusActive')}</option>
              <option value="pending">{t('hr.negStatusPending')}</option>
              <option value="closed">{t('hr.negStatusClosed')}</option>
            </select>
          </div>

          {/* Contract upload */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Contrato firmado</label>
            <div className="flex items-center gap-2">
              <label className="flex-1 cursor-pointer">
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border hover:border-[var(--color-secondary)] hover:bg-muted/50 transition-colors">
                  <Upload className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">
                    {contractFile ? contractFile.name : 'Subir contrato (PDF, máx 10 MB)'}
                  </span>
                </div>
                <input type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg" className="hidden" onChange={(e) => setContractFile(e.target.files?.[0] || null)} />
              </label>
              {contractFile && (
                <button type="button" onClick={() => setContractFile(null)} className="p-1 rounded hover:bg-muted">
                  <X className="w-4 h-4 text-muted-foreground" />
                </button>
              )}
            </div>
          </div>
        </div>
        {errorMsg && (
          <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800">
            <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
            <span className="text-sm text-red-700 dark:text-red-400">{errorMsg}</span>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-border text-sm hover:bg-muted">{t('common.cancel')}</button>
          <button onClick={handleSubmit} disabled={!canSubmit || saving} className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50">
            {saving ? (
              <span className="flex items-center gap-2">
                <span className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-white" />
                {t('hr.saving')}
              </span>
            ) : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

const NEG_STATUS_BADGE: Record<string, string> = {
  active: 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400',
  pending: 'bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400',
  closed: 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-400',
};

const NEG_STATUS_LABELS: Record<string, string> = {
  active: 'hr.negStatusActive',
  pending: 'hr.negStatusPending',
  closed: 'hr.negStatusClosed',
};

export default function RRHHPage() {
  const { t } = useI18n();
  const { company, employees: dataEmployees, commercialProfiles, monthlyResults: dataMonthlyResults, periods, refresh } = useData();
  const { user } = useAuth();
  // Module gate — other module pages (comisiones, balances, risk, users)
  // all run this check at the top. /rrhh was the outlier: the page used
  // to render unconditionally, so a user of a tenant without `hr` in
  // active_modules could navigate directly to /rrhh and see employees.
  // Superadmin bypass is baked into hasModuleAccess inside the hook.
  const canAccess = useModuleAccess('hr');
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
  const [tab, setTab] = useState<Tab>('commercial');
  const [employees, setEmployees] = useState<Employee[]>(dataEmployees);
  const profiles = commercialProfiles; // always use fresh data from context
  const monthlyResults = dataMonthlyResults;
  const [showEmpForm, setShowEmpForm] = useState(false);
  const [editingEmp, setEditingEmp] = useState<Employee | undefined>();
  const [showProfileForm, setShowProfileForm] = useState(false);
  const [editingProfile, setEditingProfile] = useState<CommercialProfile | undefined>();
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  // Negotiations state
  const [negotiations, setNegotiations] = useState<Negotiation[]>([]);
  const [negLoading, setNegLoading] = useState(false);
  const [showNegForm, setShowNegForm] = useState(false);
  const [editingNeg, setEditingNeg] = useState<Negotiation | undefined>();
  const [negSearch, setNegSearch] = useState('');
  const [negFilterProfile, setNegFilterProfile] = useState('');
  const [negFilterStatus, setNegFilterStatus] = useState<'' | NegotiationStatus>('');

  const fetchNegotiations = useCallback(async () => {
    if (!company?.id) return;
    setNegLoading(true);
    try {
      const res = await fetch(withActiveCompany(`/api/admin/negotiations?company_id=${company.id}`));
      if (res.ok) {
        const data = await res.json();
        setNegotiations(data);
      }
    } catch { /* ignore */ }
    setNegLoading(false);
  }, [company?.id]);

  // Fetch negotiations when tab switches to negotiations
  useEffect(() => {
    if (tab === 'negotiations') fetchNegotiations();
  }, [tab, fetchNegotiations]);

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

  const closeProfileForm = () => {
    setEditingProfile(undefined);
    setShowProfileForm(false);
  };

  const [deletingId, setDeletingId] = useState<string | null>(null);

  // ─── Fire / Reinstate state ───
  // `firingProfile` opens the <FireModal />; `reinstatingProfile` enables
  // the inline OK/No confirm next to the profile's row. Reinstating is
  // admin-only both client-side (button is gated by user.effective_role)
  // and server-side (ALLOWED_FIELDS + RLS). We use the silent refresh() of
  // DataProvider after a fire/reinstate — NOT window.location.reload —
  // so the user keeps scroll, tab, modals, etc.
  const [firingProfile, setFiringProfile] = useState<CommercialProfile | null>(null);
  const [reinstatingProfile, setReinstatingProfile] = useState<CommercialProfile | null>(null);
  const [reinstating, setReinstating] = useState(false);

  const handleFireSuccess = async () => {
    // Cerramos el modal PRIMERO — refresh() del DataProvider recarga
    // ~14 tablas y puede tardar varios segundos; si esperamos a que
    // termine antes de cerrar, el usuario ve el botón "…" colgado y
    // parece que se rompió. Cerramos y dejamos que refresh() corra por
    // detrás: cuando termine, `commercialProfiles` se actualiza y la
    // tabla muestra el badge "Despedido" en la fila correspondiente.
    setFiringProfile(null);
    await refresh();
  };

  const handleReinstate = async (profile: CommercialProfile) => {
    if (user?.effective_role !== 'admin') return;
    setReinstating(true);
    try {
      await updateCommercialProfile(profile.id, {
        status: 'active',
        termination_date: null,
        termination_reason: null,
        termination_category: null,
        terminated_by: null,
      });
      // Igual que en handleFireSuccess: refrescar primero, después limpiar
      // el estado del inline confirm. Evita flash de data stale.
      await refresh();
      setReinstatingProfile(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : t('hr.fireError'));
    } finally {
      setReinstating(false);
    }
  };

  // ─── Empleados tab — unified list (employees + commercial_profiles) ───
  //
  // Merge visual de administrativos (tabla `employees`) + comerciales
  // (tabla `commercial_profiles`) para que el admin vea toda su plantilla
  // en un solo lugar. NO duplicamos datos en BD — los comerciales siguen
  // viviendo solo en `commercial_profiles`; acá solo se PRESENTAN junto
  // a los employees. El botón "Agregar" sigue creando administrativos;
  // los comerciales se crean desde el tab Fuerza Comercial.
  //
  // Regla de despido: un commercial con status='inactive' y
  // `termination_date` seteada se muestra con estado derivado 'fired'
  // (badge gris y fila opaca). El registro NO se borra para que el
  // calculador de comisiones siga pudiendo postear net deposits
  // negativos post-despido vía `profile_id`.
  type UnifiedEmployee = {
    id: string;
    name: string;
    email: string;
    position: string;
    department: string;
    start_date: string;
    termination_date: string | null;
    salary: number | null;
    status: 'active' | 'inactive' | 'probation' | 'fired';
    birthday: string | null;
    supervisor: string | null;
    source: 'employee' | 'commercial';
    originalEmployee?: Employee;
    originalProfile?: CommercialProfile;
  };

  const [searchQuery, setSearchQuery] = useState('');

  const unifiedEmployees = useMemo<UnifiedEmployee[]>(() => {
    const fromEmployees: UnifiedEmployee[] = employees.map(e => ({
      id: e.id,
      name: e.name,
      email: e.email,
      position: e.position,
      department: e.department,
      start_date: e.start_date,
      termination_date: null, // employees no tiene este campo aún
      salary: e.salary,
      status: e.status,
      birthday: e.birthday,
      supervisor: e.supervisor,
      source: 'employee',
      originalEmployee: e,
    }));
    const fromCommercial: UnifiedEmployee[] = commercialProfiles.map(p => {
      // Estado derivado: inactive + termination_date = 'fired' (badge gris)
      const derivedStatus: UnifiedEmployee['status'] =
        p.status === 'inactive' && p.termination_date ? 'fired' : p.status;
      return {
        id: p.id,
        name: p.name,
        email: p.email,
        position: ROLE_LABELS_HR[p.role] || p.role,
        department: 'Comercial',
        start_date: p.hire_date || '',
        termination_date: p.termination_date,
        salary: p.salary,
        status: derivedStatus,
        birthday: p.birthday,
        supervisor: null,
        source: 'commercial',
        originalProfile: p,
      };
    });
    return [...fromEmployees, ...fromCommercial];
  }, [employees, commercialProfiles]);

  const filteredUnifiedEmployees = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return unifiedEmployees;
    return unifiedEmployees.filter(e =>
      e.name.toLowerCase().includes(q) ||
      e.email.toLowerCase().includes(q) ||
      e.position.toLowerCase().includes(q) ||
      e.department.toLowerCase().includes(q)
    );
  }, [unifiedEmployees, searchQuery]);

  const handleDeleteProfile = async (id: string) => {
    try {
      await deleteCommercialProfile(id);
      setDeletingId(null);
      window.location.reload();
    } catch (err) {
      setDeletingId(null);
      setToast({ type: 'error', msg: err instanceof Error ? err.message : 'Error al eliminar' });
      setTimeout(() => setToast(null), 4000);
    }
  };

  const handleDeleteEmployee = async (id: string) => {
    // Local-only rows (not yet persisted) carry a non-UUID id like `emp-<timestamp>`.
    // Skip the API call for those — just drop from state.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    try {
      if (isUuid) await deleteEmployee(id);
      setEmployees(prev => prev.filter(e => e.id !== id));
      setDeletingId(null);
      if (isUuid) await refresh();
    } catch (err) {
      setDeletingId(null);
      setToast({ type: 'error', msg: err instanceof Error ? err.message : 'Error al eliminar' });
      setTimeout(() => setToast(null), 4000);
    }
  };

  const handleExportEmployees = () => verify2FA(() => {
    // Exporta la lista unificada (administrativos + comerciales) con los
    // filtros del buscador aplicados, para que el CSV matchee exactamente
    // lo que el usuario tiene visible en pantalla.
    const headers = [
      t('common.name'), t('common.email'), t('hr.position'), t('hr.department'),
      t('hr.type'), t('hr.hireDate'), t('hr.terminationDate'),
      t('hr.salary'), t('hr.status'),
    ];
    const rows = filteredUnifiedEmployees.map(e => [
      e.name, e.email, e.position, e.department,
      e.source === 'commercial' ? t('hr.typeCommercial') : t('hr.typeAdmin'),
      e.start_date || '',
      e.termination_date || '',
      e.salary ?? 'N/A',
      t(STATUS_LABEL_KEYS[e.status]),
    ] as (string | number)[]);
    downloadCSV('empleados.csv', headers, rows);
  });

  const handleExportCommercial = () => verify2FA(() => {
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
  });

  // ─── Negotiation CRUD handlers ───
  const [savingNeg, setSavingNeg] = useState(false);
  const [negError, setNegError] = useState('');

  const handleSaveNegotiation = async (data: NegFormData) => {
    if (!company?.id) return;
    setSavingNeg(true);
    setNegError('');
    try {
      let resolvedProfileId = data.profile_id;

      // Check if this profile already has a negotiation (only on create, not edit)
      if (!editingNeg) {
        // For existing profile, check directly
        if (resolvedProfileId) {
          const existing = negotiations.find(n => n.profile_id === resolvedProfileId);
          if (existing) {
            const profileName = profiles.find(p => p.id === resolvedProfileId)?.name || '';
            throw new Error(`${profileName} ya tiene una negociacion registrada: "${existing.title}"`);
          }
        }
        // For new profile, check by email
        if (data.newProfile) {
          const existingProfile = profiles.find(p => p.email.toLowerCase() === data.newProfile!.email.toLowerCase());
          if (existingProfile) {
            const existingNeg = negotiations.find(n => n.profile_id === existingProfile.id);
            if (existingNeg) {
              throw new Error(`${existingProfile.name} ya tiene una negociacion registrada: "${existingNeg.title}"`);
            }
          }
        }
      }

      // If creating a new profile first
      if (data.newProfile) {
        const profileRes = await fetch(withActiveCompany('/api/admin/commercial-profiles'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create',
            company_id: company.id,
            name: data.newProfile.name,
            email: data.newProfile.email,
            role: data.newProfile.role,
          }),
        });
        const profileResult = await profileRes.json();
        if (!profileRes.ok || profileResult.error) throw new Error(profileResult.error || 'Error creando perfil');
        resolvedProfileId = profileResult.id;
        // Refresh profiles so the new one appears in the list
        await refresh();
      }

      // Upload contract file if provided
      if (data.contractFile && resolvedProfileId) {
        const formData = new FormData();
        formData.append('file', data.contractFile);
        formData.append('profile_id', resolvedProfileId);
        const uploadRes = await fetch(withActiveCompany('/api/admin/upload-contract'), { method: 'POST', body: formData });
        const uploadResult = await uploadRes.json();
        if (!uploadRes.ok || uploadResult.error) throw new Error(uploadResult.error || 'Error subiendo contrato');
      }

      const body = editingNeg
        ? { action: 'update', id: editingNeg.id, title: data.title, description: data.description, status: data.status }
        : { action: 'create', company_id: company.id, profile_id: resolvedProfileId, title: data.title, description: data.description, status: data.status };
      const res = await fetch(withActiveCompany('/api/admin/negotiations'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await res.json();
      if (!res.ok || result.error) throw new Error(result.error);
      setShowNegForm(false);
      setEditingNeg(undefined);
      const msg = data.newProfile
        ? `${t('hr.profileCreated')} + ${t('hr.negotiationSaved')}`
        : t('hr.negotiationSaved');
      setToast({ type: 'success', msg });
      setTimeout(() => setToast(null), 3000);
      setNegError('');
      fetchNegotiations();
    } catch (err) {
      setNegError(err instanceof Error ? err.message : 'Error');
    }
    setSavingNeg(false);
  };

  const handleDeleteNegotiation = async (id: string) => {
    if (!confirm(t('hr.confirmDelete'))) return;
    try {
      const res = await fetch(withActiveCompany('/api/admin/negotiations'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      });
      const result = await res.json();
      if (!res.ok || result.error) throw new Error(result.error);
      setToast({ type: 'success', msg: t('hr.negotiationDeleted') });
      setTimeout(() => setToast(null), 3000);
      fetchNegotiations();
    } catch (err) {
      setToast({ type: 'error', msg: err instanceof Error ? err.message : 'Error' });
      setTimeout(() => setToast(null), 4000);
    }
  };

  // Filtered negotiations
  const filteredNegotiations = negotiations.filter(n => {
    if (negFilterProfile && n.profile_id !== negFilterProfile) return false;
    if (negFilterStatus && n.status !== negFilterStatus) return false;
    if (negSearch) {
      const s = negSearch.toLowerCase();
      const profile = profiles.find(p => p.id === n.profile_id);
      return n.title.toLowerCase().includes(s) || (n.description || '').toLowerCase().includes(s) || (profile?.name || '').toLowerCase().includes(s) || (profile?.email || '').toLowerCase().includes(s);
    }
    return true;
  });

  // Render a team card (for sales_manager or head)
  const renderTeamCard = (leader: CommercialProfile) => {
    const bdms = profiles.filter(p => p.head_id === leader.id);
    const leaderTotal = getFilteredTotal(leader.id);
    const roleBadge = getRoleBadge(leader.role);

    return (
      <Card key={leader.id}>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-violet-100 dark:bg-violet-950/50 flex items-center justify-center shrink-0">
              <UserCircle className="w-6 h-6 text-violet-600" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <Link
                  href={`/rrhh/perfil?id=${leader.id}`}
                  className={cn(
                    'text-base sm:text-lg font-semibold hover:text-[var(--color-primary)] transition-colors',
                    firedNameClass(leader),
                  )}
                >
                  {leader.name}
                </Link>
                <FiredBadge profile={leader} />
                <button onClick={() => { setEditingProfile(leader); setShowProfileForm(true); }} className="text-muted-foreground hover:text-foreground" aria-label={t('common.edit')}>
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                {deletingId === leader.id ? (
                  <div className="flex items-center gap-1">
                    <button onClick={() => handleDeleteProfile(leader.id)} className="px-2 py-0.5 text-xs rounded bg-red-500 text-white hover:bg-red-600">OK</button>
                    <button onClick={() => setDeletingId(null)} className="px-2 py-0.5 text-xs rounded border border-border hover:bg-muted">No</button>
                  </div>
                ) : (
                  <button onClick={() => setDeletingId(leader.id)} className="text-muted-foreground hover:text-red-500" aria-label={t('common.delete')}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
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
                    <td className={cn('py-2.5 font-medium', firedNameClass(bdm))}>
                      {bdm.name}
                      <FiredBadge profile={bdm} />
                    </td>
                    <td className="py-2.5 text-muted-foreground text-xs hidden sm:table-cell">{bdm.email}</td>
                    <td className="py-2.5 text-right hidden sm:table-cell">{bdm.net_deposit_pct != null ? `${bdm.net_deposit_pct}%` : 'N/A'}</td>
                    <td className="py-2.5 text-right hidden sm:table-cell">{bdm.salary != null ? formatCurrency(bdm.salary) : 'N/A'}</td>
                    <td className="py-2.5 text-right hidden sm:table-cell">{bdmPnl > 0 ? formatCurrency(bdmPnl) : '-'}</td>
                    <td className="py-2.5 text-right">{formatCurrency(getFilteredCommissions(bdm.id))}</td>
                    <td className="py-2.5 text-right hidden sm:table-cell">{bdmBonus > 0 ? formatCurrency(bdmBonus) : '-'}</td>
                    <td className="py-2.5 text-right font-medium">{formatCurrency(getFilteredTotal(bdm.id))}</td>
                    <td className="py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => { setEditingProfile(bdm); setShowProfileForm(true); }} className="text-muted-foreground hover:text-foreground" aria-label={t('common.edit')}>
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        {deletingId === bdm.id ? (
                          <div className="flex items-center gap-1">
                            <button onClick={() => handleDeleteProfile(bdm.id)} className="px-2 py-0.5 text-xs rounded bg-red-500 text-white hover:bg-red-600">OK</button>
                            <button onClick={() => setDeletingId(null)} className="px-2 py-0.5 text-xs rounded border border-border hover:bg-muted">No</button>
                          </div>
                        ) : (
                          <button onClick={() => setDeletingId(bdm.id)} className="text-muted-foreground hover:text-red-500" aria-label={t('common.delete')}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <Link href={`/rrhh/perfil?id=${bdm.id}`} className="text-muted-foreground hover:text-foreground">
                          <ChevronRight className="w-4 h-4" />
                        </Link>
                      </div>
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

  if (!canAccess) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">{t('common.noAccess')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {Modal2FA}
      {/* Toast notification */}
      {toast && (
        <div className={cn('flex items-center gap-2 px-4 py-3 rounded-lg text-sm', toast.type === 'success' ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800' : 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800')}>
          {toast.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {toast.msg}
        </div>
      )}

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
        <button
          onClick={() => setTab('negotiations')}
          className={cn(
            'px-3 sm:px-4 py-2 rounded-md text-xs sm:text-sm font-medium transition-colors',
            tab === 'negotiations' ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Handshake className="w-4 h-4 inline mr-1 sm:mr-2" />
          {t('hr.negotiations')}
        </button>
      </div>

      {/* ═══════════ EMPLOYEES TAB ═══════════ */}
      {tab === 'employees' && (
        <Card>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
            <h2 className="text-lg font-semibold">{t('hr.employees')}</h2>
            <div className="flex items-center gap-2">
              <div className="relative flex-1 sm:w-64">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('hr.searchEmployees')}
                  className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-border bg-card text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                />
              </div>
              <button
                onClick={() => { setEditingEmp(undefined); setShowEmpForm(true); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 whitespace-nowrap"
              >
                <Plus className="w-4 h-4" /> {t('hr.addEmployee')}
              </button>
            </div>
          </div>
          {showEmpForm && company && (
            <EmployeeForm
              editing={editingEmp}
              companyId={company.id}
              onClose={() => { setShowEmpForm(false); setEditingEmp(undefined); }}
              onSave={handleSaveEmployee}
            />
          )}
          <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
            <table className="w-full text-sm min-w-[800px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 text-muted-foreground font-medium">{t('common.name')}</th>
                  <th className="text-left py-2 text-muted-foreground font-medium hidden sm:table-cell">{t('common.email')}</th>
                  <th className="text-left py-2 text-muted-foreground font-medium">{t('hr.position')}</th>
                  <th className="text-left py-2 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.department')}</th>
                  <th className="text-left py-2 text-muted-foreground font-medium hidden md:table-cell">{t('hr.type')}</th>
                  <th className="text-left py-2 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.hireDate')}</th>
                  <th className="text-left py-2 text-muted-foreground font-medium hidden lg:table-cell">{t('hr.terminationDate')}</th>
                  <th className="text-right py-2 text-muted-foreground font-medium">{t('hr.salary')}</th>
                  <th className="text-left py-2 text-muted-foreground font-medium">{t('hr.status')}</th>
                  <th className="text-right py-2 text-muted-foreground font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {filteredUnifiedEmployees.map(emp => {
                  const isFired = emp.status === 'fired';
                  return (
                    <tr key={`${emp.source}-${emp.id}`} className={cn('border-b border-border/50', isFired && 'opacity-60')}>
                      <td className="py-2.5 font-medium">{emp.name}</td>
                      <td className="py-2.5 text-muted-foreground hidden sm:table-cell">{emp.email}</td>
                      <td className="py-2.5">{emp.position}</td>
                      <td className="py-2.5 hidden sm:table-cell">{emp.department}</td>
                      <td className="py-2.5 hidden md:table-cell">
                        <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium',
                          emp.source === 'commercial'
                            ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400'
                            : 'bg-slate-50 dark:bg-slate-900/50 text-slate-700 dark:text-slate-400')}>
                          {emp.source === 'commercial' ? t('hr.typeCommercial') : t('hr.typeAdmin')}
                        </span>
                      </td>
                      <td className="py-2.5 hidden sm:table-cell">{emp.start_date || '-'}</td>
                      <td className="py-2.5 hidden lg:table-cell text-muted-foreground">{emp.termination_date || '-'}</td>
                      <td className="py-2.5 text-right">{emp.salary != null ? formatCurrency(emp.salary) : 'N/A'}</td>
                      <td className="py-2.5">
                        <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', STATUS_BADGE_CLASSES[emp.status])}>
                          {t(STATUS_LABEL_KEYS[emp.status])}
                        </span>
                      </td>
                      <td className="py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {/* Despedir: solo comerciales activos. Los
                              comerciales ya despedidos muestran UserCheck
                              (reincorporar), los administrativos no tienen
                              este flow. */}
                          {emp.source === 'commercial' && emp.originalProfile && emp.status === 'active' && (
                            <button
                              onClick={() => setFiringProfile(emp.originalProfile!)}
                              className="text-muted-foreground hover:text-red-600"
                              aria-label={t('hr.fire')}
                              title={t('hr.fire')}
                            >
                              <UserX className="w-3.5 h-3.5" />
                            </button>
                          )}

                          {/* Reincorporar: admin-only, y solo si está despedido. */}
                          {emp.source === 'commercial' && emp.originalProfile && emp.status === 'fired' && user?.effective_role === 'admin' && (
                            reinstatingProfile?.id === emp.originalProfile.id ? (
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => handleReinstate(emp.originalProfile!)}
                                  disabled={reinstating}
                                  className="px-2 py-0.5 text-xs rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                                >
                                  {reinstating ? '…' : 'OK'}
                                </button>
                                <button
                                  onClick={() => setReinstatingProfile(null)}
                                  disabled={reinstating}
                                  className="px-2 py-0.5 text-xs rounded border border-border hover:bg-muted"
                                >
                                  No
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => setReinstatingProfile(emp.originalProfile!)}
                                className="text-muted-foreground hover:text-emerald-600"
                                aria-label={t('hr.reinstate')}
                                title={t('hr.reinstate')}
                              >
                                <UserCheck className="w-3.5 h-3.5" />
                              </button>
                            )
                          )}

                          <button
                            onClick={() => {
                              if (emp.source === 'employee' && emp.originalEmployee) {
                                setEditingEmp(emp.originalEmployee);
                                setShowEmpForm(true);
                              } else if (emp.source === 'commercial' && emp.originalProfile) {
                                setEditingProfile(emp.originalProfile);
                                setShowProfileForm(true);
                              }
                            }}
                            className="text-muted-foreground hover:text-foreground"
                            aria-label={t('common.edit')}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          {/* Delete button SOLO para administrativos. Los comerciales se
                              despiden (status=inactive + termination_date), no se borran:
                              borrar rompería commercial_monthly_results vía FK. */}
                          {emp.source === 'employee' && (
                            deletingId === emp.id ? (
                              <div className="flex items-center gap-1">
                                <button onClick={() => handleDeleteEmployee(emp.id)} className="px-2 py-0.5 text-xs rounded bg-red-500 text-white hover:bg-red-600">OK</button>
                                <button onClick={() => setDeletingId(null)} className="px-2 py-0.5 text-xs rounded border border-border hover:bg-muted">No</button>
                              </div>
                            ) : (
                              <button onClick={() => setDeletingId(emp.id)} className="text-muted-foreground hover:text-red-500" aria-label={t('common.delete')}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filteredUnifiedEmployees.length === 0 && (
            <p className="text-center text-muted-foreground py-8">
              {searchQuery ? t('hr.noSearchResults') : t('hr.noEmployees')}
            </p>
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
              onClose={closeProfileForm}
              companyId={company?.id || ''}
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
                        <td className={cn('py-2.5 font-medium', firedNameClass(bdm))}>
                          {bdm.name}
                          <FiredBadge profile={bdm} />
                        </td>
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
                            <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', getRoleBadge(p.role))}>
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

      {/* ═══════════ NEGOTIATIONS TAB ═══════════ */}
      {tab === 'negotiations' && (
        <div className="space-y-4">
          {/* Toolbar */}
          <Card>
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div className="flex flex-col sm:flex-row gap-2 flex-1 w-full sm:w-auto">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={negSearch}
                    onChange={e => setNegSearch(e.target.value)}
                    placeholder={t('hr.searchNegotiations')}
                    className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                  />
                </div>
                <select
                  value={negFilterProfile}
                  onChange={e => setNegFilterProfile(e.target.value)}
                  className="px-3 py-2 rounded-lg border border-border bg-background text-sm"
                >
                  <option value="">{t('hr.allProfiles')}</option>
                  {profiles.filter(p => p.status === 'active').map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <select
                  value={negFilterStatus}
                  onChange={e => setNegFilterStatus(e.target.value as '' | NegotiationStatus)}
                  className="px-3 py-2 rounded-lg border border-border bg-background text-sm"
                >
                  <option value="">Todos los estados</option>
                  <option value="active">{t('hr.negStatusActive')}</option>
                  <option value="pending">{t('hr.negStatusPending')}</option>
                  <option value="closed">{t('hr.negStatusClosed')}</option>
                </select>
              </div>
              <button
                onClick={() => { setEditingNeg(undefined); setNegError(''); setShowNegForm(true); }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 shrink-0"
              >
                <Plus className="w-4 h-4" /> {t('hr.addNegotiation')}
              </button>
            </div>
          </Card>

          {/* Negotiation Form Modal */}
          {showNegForm && (
            <NegotiationForm
              editing={editingNeg}
              onClose={() => { setShowNegForm(false); setEditingNeg(undefined); setNegError(''); }}
              onSave={handleSaveNegotiation}
              profiles={profiles.filter(p => p.status === 'active')}
              saving={savingNeg}
              errorMsg={negError}
            />
          )}

          {/* Negotiations List */}
          <Card>
            {negLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--color-primary)]" />
              </div>
            ) : filteredNegotiations.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">{t('hr.noNegotiations')}</p>
            ) : (
              <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
                <table className="w-full text-sm min-w-[700px]">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 text-muted-foreground font-medium">{t('hr.negotiationTitle')}</th>
                      <th className="text-left py-2 text-muted-foreground font-medium hidden sm:table-cell">{t('common.name')}</th>
                      <th className="text-left py-2 text-muted-foreground font-medium hidden sm:table-cell">{t('common.email')}</th>
                      <th className="text-left py-2 text-muted-foreground font-medium hidden md:table-cell">{t('hr.negotiationDesc')}</th>
                      <th className="text-left py-2 text-muted-foreground font-medium">{t('hr.negotiationStatus')}</th>
                      <th className="text-left py-2 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.negotiationUpdated')}</th>
                      <th className="text-right py-2 text-muted-foreground font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredNegotiations.map(neg => {
                      const profile = profiles.find(p => p.id === neg.profile_id);
                      return (
                        <tr key={neg.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                          <td className="py-2.5 font-medium">{neg.title}</td>
                          <td className="py-2.5 hidden sm:table-cell">
                            <div>
                              <span className="font-medium">{profile?.name || '-'}</span>
                              {profile && (
                                <span className={cn('ml-2 px-1.5 py-0.5 rounded-full text-[10px] font-medium', getRoleBadge(profile.role))}>
                                  {ROLE_LABELS_HR[profile.role]}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-2.5 text-muted-foreground text-xs hidden sm:table-cell">{profile?.email || '-'}</td>
                          <td className="py-2.5 text-muted-foreground text-xs max-w-[200px] truncate hidden md:table-cell">{neg.description || '-'}</td>
                          <td className="py-2.5">
                            <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', NEG_STATUS_BADGE[neg.status])}>
                              {t(NEG_STATUS_LABELS[neg.status])}
                            </span>
                          </td>
                          <td className="py-2.5 text-muted-foreground text-xs hidden sm:table-cell">
                            {formatDate(neg.updated_at)}
                          </td>
                          <td className="py-2.5 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <button onClick={() => { setEditingNeg(neg); setShowNegForm(true); }} className="text-muted-foreground hover:text-foreground" aria-label={t('common.edit')}>
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={() => handleDeleteNegotiation(neg.id)} className="text-muted-foreground hover:text-red-500" aria-label={t('common.delete')}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* FireModal — montado a nivel de componente raíz para que el overlay
          cubra toda la página y no quede dentro de un Card scrollable. */}
      {firingProfile && (
        <FireModal
          profile={firingProfile}
          onClose={() => setFiringProfile(null)}
          onSuccess={handleFireSuccess}
        />
      )}
    </div>
  );
}
