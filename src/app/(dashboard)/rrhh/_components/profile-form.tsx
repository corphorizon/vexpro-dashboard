'use client';

import { useState } from 'react';
import { FileText, ExternalLink } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { ActionButton } from '@/components/payment-orders/action-button';
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
import { CHECKBOX_CLASS, FilePick, HrModal, OptionBox } from './hr-ui';

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
//
// ── «Libro mayor» (2026-10-12) — sólo presentación ─────────────────────────
// El payload de `handleSubmit` no cambió (ni un campo, ni un `? :`). Lo que
// cambió es cómo se ve:
//   · HrModal + Field/Input/Select/Textarea: label visible atado al control
//     (antes `<label>` sin `htmlFor` + `aria-label` repetido), borde
//     `control-border` 3:1, hints en 12 px `text-3` (antes `text-[10px]` /
//     `text-[11px]`).
//   · Las tres opciones con checkbox (Master IB, PnL Especial, % extra sin
//     salario) traían cada una un fondo de color distinto — `bg-warning/10`,
//     `bg-info/10` y `bg-purple-50 dark:bg-purple-950/30` — sin que ninguno
//     significara pendiente o informativo: era decoración. Ahora OptionBox
//     (superficie `surface-2`, igual las tres).
//   · Reincorporar: era `border-emerald-300 hover:bg-emerald-50` (verde de
//     «ganancia» en un botón); ahora ActionButton secundario.
//   · Contrato cargado: StatusBadge `ok` «En archivo» (antes toda la franja
//     en `bg-positive/10` y el enlace en `text-blue-600`).
//   · El error de guardado, Notice `bad` (antes `text-red-600 bg-negative/10`).
// Medición (sin comentarios): antes 12 clases de paleta cruda, 3 `dark:` de
// color, 6 `text-[10px]/[11px]` y 45 tokens legados; después 0 / 0 / 0 / 0.
// Los dos `?? 0` que quedan (pct_sobre_bdm_global, pct_extra_sobre_head) son
// el default de siempre de esos campos numéricos, no nuevos.
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
  // Master IB (migración 129): cuelga de la línea de un BDM y su red se
  // descuenta de ese BDM, como pasa con un head.
  const [isMasterIb, setIsMasterIb] = useState(!!editing?.is_master_ib);
  // % POR LÍNEA (migración 130): lo que cobra EL DE ARRIBA por la línea de
  // este perfil. Vacío = diferencial natural de siempre; `0` = el de arriba no
  // cobra nada por esta línea. Por eso el estado es string y NO number: un 0
  // tecleado y un campo vacío tienen que poder distinguirse (§1.3).
  const [pctLinea, setPctLinea] = useState(
    editing?.pct_linea === null || editing?.pct_linea === undefined ? '' : String(editing.pct_linea),
  );
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
  //
  // `incluirBdms` sólo con «Master IB» tildado: un master cuelga de la LÍNEA de
  // un BDM (Jose Emanuel Hernandez Alvarez de Ana García, 2026-09-06) y el
  // selector normal lista únicamente líderes. Sin el flag el desplegable queda
  // exactamente como estaba.
  const heads = possibleHeads(commercialProfiles, {
    excludeId: editing?.id,
    incluirBdms: isMasterIb,
  });
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
        // El flag NO depende de ningún % (a diferencia de nd_pct_fixed): el
        // master del caso real cobra por PnL Especial y no tiene net_deposit_pct.
        is_master_ib: isMasterIb,
        // OJO con el `? :` de los demás campos: acá NO sirve, porque '0' es
        // falsy en JS y un 0 tecleado (el de arriba no cobra nada por esta
        // línea) se guardaría como null (la lógica de siempre) sin lanzar
        // ninguna excepción — el §1.2 en su forma más barata de cometer.
        pct_linea: pctLinea.trim() === '' ? null : parseFloat(pctLinea),
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
    <HrModal
      title={editing ? t('hr.editProfile') : t('hr.newProfile')}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <ActionButton variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </ActionButton>
          <ActionButton
            variant="primary"
            onClick={handleSubmit}
            disabled={!name || !email}
            loading={localSaving || uploading}
          >
            {uploading ? t('hr.uploadingContract') : localSaving ? t('hr.saving') : (editing ? t('common.save') : t('common.add'))}
          </ActionButton>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label={t('hr.namePlaceholder')} required>
          <Input value={name} onChange={e => setName(e.target.value)} />
        </Field>
        <Field label={t('hr.emailPlaceholder')} required>
          <Input type="email" value={email} onChange={e => setEmail(e.target.value)} />
        </Field>
        <Field label={t('hr.role')}>
          {/* Las opciones salen del registro: agregar un rol comercial no
              puede depender de acordarse de esta lista. */}
          <Select value={role} onChange={e => setRole(e.target.value)}>
            {HR_COMMERCIAL_ROLES.map(r => (
              <option key={r} value={r}>{hrRoleLabel(r)}</option>
            ))}
          </Select>
        </Field>
        <Field label={t('hr.supervisor')}>
          <Select value={headId} onChange={e => setHeadId(e.target.value)}>
            <option value="">{t('hr.noSupervisor')}</option>
            {heads.map(h => (
              <option key={h.id} value={h.id}>{h.name} ({hrRoleLabel(h.role)})</option>
            ))}
          </Select>
        </Field>
        {/* Master IB — habilita colgar el perfil de un BDM y hace que su red
            se descuente de ese BDM (migración 129). Se muestra siempre: el
            master del caso real cobra por PnL Especial y no tiene % de ND. */}
        <OptionBox
          id="is-master-ib"
          className="md:col-span-2"
          checked={isMasterIb}
          onChange={(checked) => {
            setIsMasterIb(checked);
            // Al destildar, un supervisor BDM dejaría de estar en la lista y
            // el desplegable se vería vacío mientras el valor viejo seguía
            // ahí para guardarse: una discrepancia muda entre lo que se ve y
            // lo que se persiste. Se limpia.
            if (!checked && headId) {
              const sigueSiendoValido = possibleHeads(commercialProfiles, { excludeId: editing?.id })
                .some((h) => h.id === headId);
              if (!sigueSiendoValido) setHeadId('');
            }
          }}
          title={t('hr.masterIb')}
          hint={t('hr.masterIbHint')}
        />
        <div className="flex flex-col gap-1.5">
          <Field label={t('hr.ndPctPlaceholder')}>
            <Input type="number" value={ndPct} onChange={e => setNdPct(e.target.value)} className="text-right tabular-nums" />
          </Field>
          {/* Excepción a los tramos por volumen (BDM_PCT_TIERS): con esto
              activo la persona cobra SIEMPRE su % configurado. Solo tiene
              sentido con un % cargado, por eso se muestra únicamente ahí. */}
          {ndPct && (
            <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-text-2">
              <input type="checkbox" checked={ndPctFixed} onChange={e => setNdPctFixed(e.target.checked)} className={CHECKBOX_CLASS} />
              {t('hr.ndPctFixedCheckbox')}
            </label>
          )}
        </div>
        {/* % POR LÍNEA — lo que cobra el de ARRIBA por la línea de esta
            persona. Se muestra siempre: aplica tanto al BDM dentro de un
            head como al Master IB dentro de un BDM (son la misma mecánica,
            un nivel más abajo). El mismo campo se edita en la fila de la
            tarjeta de Fuerza Comercial. */}
        <Field label={t('hr.pctLineaLabel')} hint={t('hr.pctLineaHint')}>
          <Input
            type="number"
            step="0.01"
            value={pctLinea}
            onChange={e => setPctLinea(e.target.value)}
            placeholder={t('hr.pctLineaPlaceholder')}
            className="text-right tabular-nums"
          />
        </Field>
        <Field label={t('hr.pnlPctPlaceholder')}>
          <Input type="number" value={pnlPct} onChange={e => setPnlPct(e.target.value)} className="text-right tabular-nums" />
        </Field>

        {/* Modo PnL Especial — solo visible cuando hay pnl_pct configurado.
            Cuando está activo, el perfil usa la fórmula simplificada
            (pnl × pct − lotes) y aparece en una sección separada en
            /comisiones. */}
        {pnlPct && (
          <OptionBox
            id="pnl-special-mode"
            className="md:col-span-2"
            checked={pnlSpecialMode}
            onChange={setPnlSpecialMode}
            title={t('hr.pnlSpecialMode')}
            hint={t('hr.pnlSpecialModeHint')}
          />
        )}
        <Field label={t('hr.commLotPlaceholder')} hint={t('hr.commMethodHint')}>
          <Input type="number" value={commLot} onChange={e => setCommLot(e.target.value)} className="text-right tabular-nums" />
        </Field>
        <div className="flex flex-col gap-1.5">
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] font-medium text-text-2">
            <input type="checkbox" checked={fixedSalary} onChange={e => setFixedSalary(e.target.checked)} className={CHECKBOX_CLASS} />
            {t('hr.fixedSalaryCheckbox')}
          </label>
          {fixedSalary && (
            <Input
              aria-label={t('hr.amountUsdPlaceholder')}
              type="number"
              placeholder={t('hr.amountUsdPlaceholder')}
              value={salary}
              onChange={e => setSalary(e.target.value)}
              className="text-right tabular-nums"
            />
          )}
        </div>
        {mostrarCamposDeLider && (
          <Field label={t('hr.extraPct')}>
            <Input type="number" step="0.01" value={extraPct} onChange={e => setExtraPct(e.target.value)} placeholder="0" className="text-right tabular-nums" />
          </Field>
        )}
        {/* BDM GLOBAL — campos extra del HEAD/Sales Manager */}
        {mostrarCamposDeLider && (
          <>
            <Field label={t('hr.pctOverGlobalBdms')} hint={t('hr.pctOverGlobalBdmsHint')}>
              <Input
                type="number"
                step="0.01"
                value={pctSobreBdmGlobal}
                onChange={e => setPctSobreBdmGlobal(parseFloat(e.target.value) || 0)}
                placeholder="0"
                className="text-right tabular-nums"
              />
            </Field>
            <Field label={t('hr.pctExtraOverHead')} hint={t('hr.pctExtraOverHeadHint')}>
              <Input
                type="number"
                step="0.01"
                value={pctExtraSobreHead}
                onChange={e => setPctExtraSobreHead(parseFloat(e.target.value) || 0)}
                placeholder="0"
                className="text-right tabular-nums"
              />
            </Field>
            <OptionBox
              id="apply-pct-extra-no-salary"
              className="md:col-span-2"
              checked={applyPctExtraToHeadWithoutSalary}
              onChange={setApplyPctExtraToHeadWithoutSalary}
              title={t('hr.applyExtraPctNoSalary')}
            />
          </>
        )}
        <Field label={t('hr.benefitsPlaceholder')}>
          <Input value={benefits} onChange={e => setBenefits(e.target.value)} />
        </Field>
        <Field label={t('hr.commentsPlaceholder')}>
          <Input value={comments} onChange={e => setComments(e.target.value)} />
        </Field>
        <Field label={t('hr.hireDatePlaceholder')}>
          <Input type="date" value={hireDate} onChange={e => setHireDate(e.target.value)} />
        </Field>
        <Field label={t('hr.terminationDate')} hint={t('hr.terminationDateHint')}>
          <Input type="date" value={terminationDate} onChange={e => setTerminationDate(e.target.value)} />
        </Field>

        {/* Sección despido — visible siempre que haya termination_date o el
            status esté en 'inactive'. Permite editar razón/categoría y, si
            el caller es admin, reincorporar al empleado en un click. */}
        {(terminationDate || status === 'inactive') && (
          <section className="mt-1 border-t border-border pt-3 md:col-span-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-[11.5px] font-semibold uppercase tracking-[.03em] text-text-3">
                {t('hr.terminationSection')}
              </h3>
              {editing?.status === 'inactive' && editing?.termination_date && isCompanyAdmin(authUser) && (
                <ActionButton
                 
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
                >
                  {t('hr.reinstate')}
                </ActionButton>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label={t('hr.fireCategoryLabel')}>
                <Select value={terminationCategory} onChange={e => setTerminationCategory(e.target.value)}>
                  <option value="">—</option>
                  <option value="performance">{t('hr.categoryPerformance')}</option>
                  <option value="misconduct">{t('hr.categoryMisconduct')}</option>
                  <option value="voluntary">{t('hr.categoryVoluntary')}</option>
                  <option value="restructuring">{t('hr.categoryRestructuring')}</option>
                  <option value="other">{t('hr.categoryOther')}</option>
                </Select>
              </Field>
              <Field label={t('hr.fireReasonLabel')}>
                <Textarea
                  value={terminationReason}
                  onChange={e => setTerminationReason(e.target.value)}
                  rows={2}
                  className="resize-none"
                  placeholder={t('hr.fireReasonPlaceholder')}
                />
              </Field>
            </div>
          </section>
        )}
        <Field label={t('hr.birthdayPlaceholder')}>
          <Input type="date" value={birthday} onChange={e => setBirthday(e.target.value)} />
        </Field>
        <Field label={t('hr.status')}>
          <Select value={status} onChange={e => setStatus(e.target.value as 'active' | 'inactive')}>
            <option value="active">{t('hr.statusActive')}</option>
            <option value="inactive">{t('hr.statusInactive')}</option>
          </Select>
        </Field>
      </div>

      {/* Contract upload section */}
      <section className="mt-4 space-y-2 border-t border-border pt-4">
        <h3 className="text-[12.5px] font-medium text-text-2">{t('hr.signedContract')}</h3>
        {contractUrl && !contractFile && (
          <div className="flex items-center gap-2 rounded-ui-md border border-border bg-surface-2 px-3 py-2">
            <FileText aria-hidden className="size-4 shrink-0 text-text-3" />
            <span className="flex-1 text-[13px] text-foreground">{t('hr.contractUploaded')}</span>
            <StatusBadge kind="ok" label={t('hrv.onFile')} />
            <a
              href={editing?.id ? withActiveCompany(`/api/admin/contract-url/${editing.id}`) : '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-ink hover:underline"
            >
              {t('hr.viewContract')} <ExternalLink aria-hidden className="size-3" />
            </a>
          </div>
        )}
        <FilePick
          file={contractFile}
          onFile={setContractFile}
          placeholder={contractUrl ? t('hr.changeContract') : t('hr.uploadContract')}
        />
      </section>
      {error && <Notice kind="bad" title={error} className="mt-4" />}
    </HrModal>
  );
}
