'use client';

import { useState } from 'react';
import { X, Upload, FileText, ExternalLink } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useData } from '@/lib/data-context';
import { useAuth, isCompanyAdmin } from '@/lib/auth-context';
import { apiFetch, withActiveCompany } from '@/lib/api-fetch';
import { createCommercialProfile, updateCommercialProfile } from '@/lib/supabase/mutations';
import type { CommercialProfile } from '@/lib/types';
import {
  HR_COMMERCIAL_ROLES,
  esLider,
  hrRoleLabel,
  possibleHeads,
} from '@/lib/hr/domain';

// ─────────────────────────────────────────────────────────────────────────────
// Alta/edición de un PERFIL COMERCIAL (`commercial_profiles`).
//
// Movido desde rrhh/page.tsx el 2026-08-31 sin cambiarle el comportamiento. Lo
// único que cambió: los roles del selector, la lista de supervisores posibles y
// la condición «es líder» salen ahora del registro único (src/lib/hr/domain.ts)
// en vez de estar escritos a mano acá — eran cuatro copias del mismo literal
// `'sales_manager' | 'head'` repartidas por la página.
//
// El formulario SÍ persiste (a diferencia de <EmployeeForm>) porque además
// sube el contrato, que necesita el id del perfil recién creado.
// ─────────────────────────────────────────────────────────────────────────────

export function ProfileForm({
  onClose,
  editing,
  companyId,
}: {
  onClose: () => void;
  editing?: CommercialProfile;
  companyId: string;
}) {
  const { t } = useI18n();
  const { commercialProfiles } = useData();
  const [name, setName] = useState(editing?.name || '');
  const [email, setEmail] = useState(editing?.email || '');
  const [role, setRole] = useState(editing?.role || 'bdm');
  const [headId, setHeadId] = useState(editing?.head_id || '');
  const [ndPct, setNdPct] = useState(editing?.net_deposit_pct?.toString() || '');
  const [ndPctFixed, setNdPctFixed] = useState(!!editing?.nd_pct_fixed);
  const [pnlPct, setPnlPct] = useState(editing?.pnl_pct?.toString() || '');
  const [commLot, setCommLot] = useState(editing?.commission_per_lot?.toString() || '');
  const [salary, setSalary] = useState(editing?.salary?.toString() || '');
  const [fixedSalary, setFixedSalary] = useState(editing?.fixed_salary ?? false);
  const [pnlSpecialMode, setPnlSpecialMode] = useState(!!editing?.pnl_special_mode);
  const [extraPct, setExtraPct] = useState(editing?.extra_pct?.toString() || '');
  // BDM GLOBAL — campos extra del HEAD/Sales Manager
  const [pctSobreBdmGlobal, setPctSobreBdmGlobal] = useState(editing?.pct_sobre_bdm_global ?? 0);
  const [pctExtraSobreHead, setPctExtraSobreHead] = useState(editing?.pct_extra_sobre_head ?? 0);
  const [applyPctExtraToHeadWithoutSalary, setApplyPctExtraToHeadWithoutSalary] = useState(
    editing?.apply_pct_extra_to_head_without_salary ?? false,
  );
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

  // Registro único: quién puede ser supervisor de quién lo decide hr/domain.ts.
  const heads = possibleHeads(commercialProfiles, { excludeId: editing?.id });
  // Los campos de HEAD/Sales Manager se muestran para cualquier rol líder.
  const mostrarCamposDeLider = esLider(role);

  const uploadContract = async (profileId: string) => {
    if (!contractFile) return;
    setUploading(true);
    const formData = new FormData();
    formData.append('file', contractFile);
    formData.append('profile_id', profileId);
    const res = await apiFetch('/api/admin/upload-contract', { method: 'POST', body: formData });
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
        // Mismo criterio que pnl_special_mode: sin % cargado el flag se apaga,
        // para que no quede una excepción huérfana de un config anterior.
        nd_pct_fixed: ndPct ? ndPctFixed : false,
        pnl_pct: pnlPct ? parseFloat(pnlPct) : null,
        // Force pnl_special_mode off when pct is empty — avoids stale flags
        // from a previous config (profile lost its pct but the flag lingered).
        pnl_special_mode: pnlPct ? pnlSpecialMode : false,
        // Solo persistir el salario cuando "Salario fijo" está activo. Si el
        // checkbox está destildado, el salario lo determina el auto-tier por ND
        // (ver /comisiones), así que guardamos null para no dejar un valor
        // huérfano que la UI mostraría como "Salario Fijo" aunque el cálculo
        // de comisiones lo ignore.
        salary: fixedSalary && salary ? parseFloat(salary) : null,
        fixed_salary: fixedSalary,
        extra_pct: extraPct ? parseFloat(extraPct) : null,
        // BDM GLOBAL — campos extra del HEAD/Sales Manager
        pct_sobre_bdm_global: pctSobreBdmGlobal,
        pct_extra_sobre_head: pctExtraSobreHead,
        apply_pct_extra_to_head_without_salary: applyPctExtraToHeadWithoutSalary,
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
      setError(err instanceof Error ? err.message : t('hr.saveError'));
      setLocalSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-card rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-lg">{editing ? t('hr.editProfile') : t('hr.newProfile')}</h3>
          <button onClick={onClose} aria-label={t('common.close')} className="p-2 sm:p-1 rounded hover:bg-muted"><X className="w-5 h-5" /></button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.namePlaceholder')}</label>
            <input aria-label={t('hr.namePlaceholder')} value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.emailPlaceholder')}</label>
            <input aria-label={t('hr.emailPlaceholder')} value={email} onChange={e => setEmail(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.role')}</label>
            {/* Las opciones salen del registro: agregar un rol comercial no
                puede depender de acordarse de esta lista. */}
            <select aria-label={t('hr.role')} value={role} onChange={e => setRole(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]">
              {HR_COMMERCIAL_ROLES.map(r => (
                <option key={r} value={r}>{hrRoleLabel(r)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.supervisor')}</label>
            <select aria-label={t('hr.supervisor')} value={headId} onChange={e => setHeadId(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]">
              <option value="">{t('hr.noSupervisor')}</option>
              {heads.map(h => (
                <option key={h.id} value={h.id}>{h.name} ({hrRoleLabel(h.role)})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.ndPctPlaceholder')}</label>
            <input aria-label={t('hr.ndPctPlaceholder')} type="number" value={ndPct} onChange={e => setNdPct(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
            {/* Excepción a los tramos por volumen (BDM_PCT_TIERS): con esto
                activo la persona cobra SIEMPRE su % configurado. Solo tiene
                sentido con un % cargado, por eso se muestra únicamente ahí. */}
            {ndPct && (
              <label className="flex items-center gap-2 mt-1.5 text-xs text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={ndPctFixed} onChange={e => setNdPctFixed(e.target.checked)} className="rounded border-border" />
                {t('hr.ndPctFixedCheckbox')}
              </label>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.pnlPctPlaceholder')}</label>
            <input aria-label={t('hr.pnlPctPlaceholder')} type="number" value={pnlPct} onChange={e => setPnlPct(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
          </div>

          {/* Modo PnL Especial — solo visible cuando hay pnl_pct configurado.
              Cuando está activo, el perfil usa la fórmula simplificada
              (pnl × pct − lotes) y aparece en una sección separada en
              /comisiones. */}
          {pnlPct && (
            <div className="md:col-span-2 flex items-start gap-2 p-3 rounded-lg bg-info/10/30 border border-info/30">
              <input
                id="pnl-special-mode"
                type="checkbox"
                checked={pnlSpecialMode}
                onChange={(e) => setPnlSpecialMode(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border text-primary dark:text-accent focus:ring-2 focus:ring-[var(--color-secondary)]"
              />
              <label htmlFor="pnl-special-mode" className="flex-1 cursor-pointer">
                <span className="block text-sm font-medium">{t('hr.pnlSpecialMode')}</span>
                <span className="block text-[11px] text-muted-foreground mt-0.5 leading-tight">
                  {t('hr.pnlSpecialModeHint')}
                </span>
              </label>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.commLotPlaceholder')}</label>
            <input aria-label={t('hr.commLotPlaceholder')} type="number" value={commLot} onChange={e => setCommLot(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
          </div>
          <p className="text-xs text-muted-foreground italic px-1 -mt-1">{t('hr.commMethodHint')}</p>
          <div>
            <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground mb-1 cursor-pointer">
              <input type="checkbox" checked={fixedSalary} onChange={e => setFixedSalary(e.target.checked)} className="rounded border-border" />
              {t('hr.fixedSalaryCheckbox')}
            </label>
            {fixedSalary && (
              <input aria-label={t('hr.amountUsdPlaceholder')} type="number" placeholder={t('hr.amountUsdPlaceholder')} value={salary} onChange={e => setSalary(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
            )}
          </div>
          {mostrarCamposDeLider && (
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.extraPct')}</label>
              <input aria-label={t('hr.extraPct')} type="number" step="0.01" value={extraPct} onChange={e => setExtraPct(e.target.value)} placeholder="0" className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
            </div>
          )}
          {/* BDM GLOBAL — campos extra del HEAD/Sales Manager */}
          {mostrarCamposDeLider && (
            <>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.pctOverGlobalBdms')}</label>
                <input
                  type="number"
                  step="0.01"
                  value={pctSobreBdmGlobal}
                  onChange={e => setPctSobreBdmGlobal(parseFloat(e.target.value) || 0)}
                  placeholder="0"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                />
                <p className="text-[11px] text-muted-foreground mt-1 leading-tight">{t('hr.pctOverGlobalBdmsHint')}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.pctExtraOverHead')}</label>
                <input
                  type="number"
                  step="0.01"
                  value={pctExtraSobreHead}
                  onChange={e => setPctExtraSobreHead(parseFloat(e.target.value) || 0)}
                  placeholder="0"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                />
                <p className="text-[11px] text-muted-foreground mt-1 leading-tight">{t('hr.pctExtraOverHeadHint')}</p>
              </div>
              <div className="md:col-span-2 flex items-start gap-2 p-3 rounded-lg bg-purple-50 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800">
                <input
                  id="apply-pct-extra-no-salary"
                  type="checkbox"
                  checked={applyPctExtraToHeadWithoutSalary}
                  onChange={e => setApplyPctExtraToHeadWithoutSalary(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border"
                />
                <label htmlFor="apply-pct-extra-no-salary" className="flex-1 cursor-pointer text-sm">
                  {t('hr.applyExtraPctNoSalary')}
                </label>
              </div>
            </>
          )}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.benefitsPlaceholder')}</label>
            <input aria-label={t('hr.benefitsPlaceholder')} value={benefits} onChange={e => setBenefits(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.commentsPlaceholder')}</label>
            <input aria-label={t('hr.commentsPlaceholder')} value={comments} onChange={e => setComments(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.hireDatePlaceholder')}</label>
            <input aria-label={t('hr.hireDatePlaceholder')} type="date" value={hireDate} onChange={e => setHireDate(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.terminationDate')}</label>
            <input aria-label={t('hr.terminationDate')} type="date" value={terminationDate} onChange={e => setTerminationDate(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
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
                {editing?.status === 'inactive' && editing?.termination_date && isCompanyAdmin(authUser) && (
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
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-emerald-300 text-positive hover:bg-emerald-50 dark:hover:bg-emerald-950/50"
                  >
                    {t('hr.reinstate')}
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.fireCategoryLabel')}</label>
                  <select
                    aria-label={t('hr.fireCategoryLabel')}
                    value={terminationCategory}
                    onChange={e => setTerminationCategory(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm"
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
                    aria-label={t('hr.fireReasonLabel')}
                    value={terminationReason}
                    onChange={e => setTerminationReason(e.target.value)}
                    rows={2}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm resize-none"
                    placeholder={t('hr.fireReasonPlaceholder')}
                  />
                </div>
              </div>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.birthdayPlaceholder')}</label>
            <input aria-label={t('hr.birthdayPlaceholder')} type="date" value={birthday} onChange={e => setBirthday(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.status')}</label>
            <select aria-label={t('hr.status')} value={status} onChange={e => setStatus(e.target.value as 'active' | 'inactive')} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]">
              <option value="active">{t('hr.statusActive')}</option>
              <option value="inactive">{t('hr.statusInactive')}</option>
            </select>
          </div>
        </div>
        {/* Contract upload section */}
        <div className="mt-4 border-t border-border pt-4">
          <label className="block text-xs font-medium text-muted-foreground mb-2">{t('hr.signedContract')}</label>
          {contractUrl && !contractFile && (
            <div className="flex items-center gap-2 mb-2 p-2 bg-positive/10/30 rounded-lg">
              <FileText className="w-4 h-4 text-emerald-600" />
              <span className="text-sm text-positive flex-1">{t('hr.contractUploaded')}</span>
              <a href={editing?.id ? withActiveCompany(`/api/admin/contract-url/${editing.id}`) : '#'} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                {t('hr.viewContract')} <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          )}
          <div className="flex items-center gap-2">
            <label className="flex-1 cursor-pointer">
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border hover:border-[var(--color-secondary)] hover:bg-muted/50 transition-colors">
                <Upload className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  {contractFile ? contractFile.name : (contractUrl ? t('hr.changeContract') : t('hr.uploadContract'))}
                </span>
              </div>
              <input type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg" className="hidden" onChange={(e) => setContractFile(e.target.files?.[0] || null)} />
            </label>
            {contractFile && (
              <button onClick={() => setContractFile(null)} className="p-2 sm:p-1 rounded hover:bg-muted">
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            )}
          </div>
        </div>
        {error && <p className="mt-4 text-sm text-red-600 bg-negative/10/30 px-3 py-2 rounded-lg">{error}</p>}
        <div className="mt-4 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors">
            {t('common.cancel')}
          </button>
          <button onClick={handleSubmit} disabled={localSaving || uploading} className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50">
            {uploading ? t('hr.uploadingContract') : localSaving ? t('hr.saving') : (editing ? t('common.save') : t('common.add'))}
          </button>
        </div>
      </div>
    </div>
  );
}
