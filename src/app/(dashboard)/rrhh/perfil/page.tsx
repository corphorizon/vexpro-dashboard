'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Panel } from '@/components/ui/panel';
import { KpiStrip } from '@/components/ui/kpi-strip';
import { Notice } from '@/components/ui/notice';
import { Segmented } from '@/components/ui/segmented';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Money } from '@/components/ui/money';
import { Field, Input, Select } from '@/components/ui/field';
import { useToasts } from '@/components/ui/toast';
import { ActionButton, actionButtonClass } from '@/components/payment-orders/action-button';
import { HR_COMMERCIAL_ROLES, hrRoleLabel, possibleHeads } from '@/lib/hr/domain';
import { useData } from '@/lib/data-context';
import { formatDate } from '@/lib/dates';
import { downloadCSV } from '@/lib/csv-export';
import { useAuth } from '@/lib/auth-context';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { updateCommercialProfile } from '@/lib/supabase/mutations';
import { apiFetch, withActiveCompany } from '@/lib/api-fetch';
import type { CommercialProfile, CommercialMonthlyResult, Negotiation } from '@/lib/types';
import {
  ArrowLeft, Download, Calendar, Gift, Check, Pencil, X, FileText, ExternalLink, Trash2, Calculator, UserCircle,
} from 'lucide-react';
import { FilePick, ROW_ACTION_CLASS, ROW_DANGER_CLASS } from '../_components/hr-ui';
import { negStatusView, pctText, profileStatusView } from '../_components/hr-view';

// ─────────────────────────────────────────────────────────────────────────────
// /rrhh/perfil?id=… — la ficha de un perfil comercial.
//
// «Libro mayor» (2026-10-12) — sólo presentación; los guardados (PATCH del
// perfil, subida del contrato, borrado de negociación) son los mismos:
//   · Cabecera con los datos clave en una línea (rol, email, estado con
//     StatusBadge, supervisor, alta, cumpleaños) y el CSV a la derecha.
//   · Cuatro StatCard con ícono de color → KpiStrip. «Total ganado» con CERO
//     resultados guardados mostraba $0.00; ahora «—» + «sin resultados» (un
//     perfil al que nunca se le calculó un mes no ganó cero, reglas §1.3).
//     Salario fijo «N/A» → «—» + «sin salario fijo».
//   · Pestañas (Segmented): Datos · Resultados · Negociaciones · Equipo. La
//     ficha era una sola columna de seis tarjetas; el historial quedaba abajo
//     de todo.
//   · Formulario de edición con Field/Input/Select (antes `<label>` sueltos).
//   · Contrato en su Panel con StatusBadge `ok` «En archivo» (antes franja
//     verde + botón `bg-emerald-600 text-white`). Los textos del contrato y
//     del aviso de /comisiones estaban en castellano fijo: ahora en i18n.
//   · Resultados mensuales, negociaciones y equipo en FinTable; resultados
//     con pie de total (doble raya). El estado de una negociación sale de
//     NEG_STATUS_VIEW (hr-view.ts) — acá había un TERCER mapa de colores
//     (ternario inline), con «cerrada» en rojo.
//   · El aviso «Contrato subido» se guardaba en un estado que no se dibujaba
//     en ningún lado: ahora es un toast.
// Medición (sin comentarios): antes 20 clases de paleta cruda, 7 `dark:` de
// color, 2 `text-[10px]` y 90 tokens legados; después 0 / 0 / 0 / 0.
//
// DESCARTADO: borrar los `formX` del formulario «Agregar resultado mensual»
// que se quitó el 2026-08-06 — eran estado muerto y se fueron con esta tanda
// (ninguno llegaba a un guardado).
// ─────────────────────────────────────────────────────────────────────────────

// Small adapter so callsites that used to render the raw `hire_date` string
// when formatter returned null keep that behaviour. formatDate returns ''
// for nullish input — we preserve that behaviour by accepting null and
// returning the raw string for unparseable dates.
function formatDateDMY(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const formatted = formatDate(dateStr);
  return formatted || dateStr;
}

type Section = 'details' | 'results' | 'negotiations' | 'team';

const positiveOrNull = (v: number) => (v > 0 ? v : null);

export default function PerfilPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
  const { getProfileById, getMonthlyResults, getProfilesByHead, getTotalCommissions, commercialProfiles, periods, refresh } = useData();
  const searchParams = useSearchParams();
  const profileId = searchParams.get('id');
  const { toast, ToastHost } = useToasts();

  // Resolve profile + results before hooks so initial values are available.
  // May be null if profileId is missing or invalid — handled after hooks.
  const profile = profileId ? getProfileById(profileId) : null;
  const initialResults = profileId ? getMonthlyResults(profileId) : [];

  // ALL hooks must be called unconditionally (React rules of hooks).
  const [results] = useState<CommercialMonthlyResult[]>(initialResults);
  const [section, setSection] = useState<Section>('details');
  const [profileData, setProfileData] = useState<CommercialProfile | null>(profile ?? null);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [editName, setEditName] = useState(profile?.name ?? '');
  const [editEmail, setEditEmail] = useState(profile?.email ?? '');
  const [editRole, setEditRole] = useState(profile?.role ?? '');
  const [editHeadId, setEditHeadId] = useState(profile?.head_id ?? '');
  const [editNdPct, setEditNdPct] = useState(profile?.net_deposit_pct?.toString() ?? '');
  const [editPnlPct, setEditPnlPct] = useState(profile?.pnl_pct?.toString() ?? '');
  const [editCommLot, setEditCommLot] = useState(profile?.commission_per_lot?.toString() ?? '');
  const [editSalary, setEditSalary] = useState(profile?.salary?.toString() ?? '');
  const [editBenefits, setEditBenefits] = useState(profile?.benefits ?? '');
  const [editComments, setEditComments] = useState(profile?.comments ?? '');
  const [editHireDate, setEditHireDate] = useState(profile?.hire_date ?? '');
  const [editBirthday, setEditBirthday] = useState(profile?.birthday ?? '');
  const [editStatus, setEditStatus] = useState(profile?.status ?? 'active');
  const [saving, setSaving] = useState(false);

  const [contractFile, setContractFile] = useState<File | null>(null);
  const [uploadingContract, setUploadingContract] = useState(false);

  // Negotiations state
  const [negotiations, setNegotiations] = useState<Negotiation[]>([]);
  const [negLoading, setNegLoading] = useState(false);

  const fetchNegotiations = useCallback(async () => {
    if (!profile) return;
    setNegLoading(true);
    try {
      const res = await apiFetch(`/api/admin/negotiations?company_id=${profile.company_id}&profile_id=${profileId}`);
      if (res.ok) setNegotiations(await res.json());
    } catch { /* ignore */ }
    setNegLoading(false);
  }, [profile, profileId]);

  useEffect(() => { fetchNegotiations(); }, [fetchNegotiations]);

  // Registro único (src/lib/hr/domain.ts): quién puede ser supervisor no se
  // decide con un literal escrito acá — era una de las cuatro copias.
  const heads = possibleHeads(commercialProfiles, { excludeId: profileId ?? undefined });

  // Early returns AFTER all hooks
  if (!profileId || !profile || !profileData) {
    return (
      <div className="py-12 text-center">
        <p className="text-[13.5px] text-text-2">{!profileId ? t('hr.noProfileSpecified') : t('hr.profileNotFound')}</p>
        <Link href="/rrhh" className="mt-2 inline-block text-[13px] font-medium text-brand-ink hover:underline">
          {t('hr.backToHr')}
        </Link>
      </div>
    );
  }

  const handleDeleteNegotiation = async (id: string) => {
    if (!confirm('Eliminar esta negociacion?')) return;
    try {
      await apiFetch('/api/admin/negotiations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      });
      fetchNegotiations();
    } catch { /* ignore */ }
  };

  const handleContractUpload = async () => {
    if (!contractFile) return;
    setUploadingContract(true);
    try {
      const formData = new FormData();
      formData.append('file', contractFile);
      formData.append('profile_id', profileData!.id);
      const res = await apiFetch('/api/admin/upload-contract', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error);
      setProfileData({ ...profileData!, contract_url: data.url });
      setContractFile(null);
      toast.success(t('hrv.contractUploadedOk'));
    } catch (err) {
      alert(err instanceof Error ? err.message : t('hrv.contractUploadError'));
    }
    setUploadingContract(false);
  };

  const handleSaveProfile = async () => {
    setSaving(true);
    try {
      const updates = {
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
      await updateCommercialProfile(profileData.id, updates);
      await refresh();
      setProfileData({ ...profileData, ...updates, role: editRole as CommercialProfile['role'] });
      setIsEditingProfile(false);
    } catch (err) {
      console.error('Error updating profile:', err);
      alert(err instanceof Error ? err.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
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

  const subordinates = getProfilesByHead(profileId);
  const totalEarned = results.reduce((s, r) => s + r.total_earned, 0);
  const totalCommissions = results.reduce((s, r) => s + r.commissions_earned, 0);
  const totalPnlCurrent = results.reduce((s, r) => s + r.pnl_current, 0);
  const totalBonus = results.reduce((s, r) => s + r.bonus, 0);
  const totalSalary = results.reduce((s, r) => s + r.salary_paid, 0);
  const totalNetDeposit = results.reduce((s, r) => s + r.net_deposit_current, 0);
  const hasResults = results.length > 0;

  const getPeriodLabel = (periodId: string) => {
    const p = periods.find(pp => pp.id === periodId);
    return p?.label || periodId;
  };

  const handleExport = () => verify2FA(() => {
    const headers = [t('hr.period'), t('hr.netDepCurrent'), t('hr.accumulated'), t('hr.total'), t('hr.pnlCurrent'), t('hr.pnlAccumulated'), t('hr.pnlTotal'), t('hr.commissions'), t('hr.bonus'), t('hr.salary'), t('hr.totalEarned')];
    const rows = results.map(r => [
      getPeriodLabel(r.period_id),
      r.net_deposit_current, r.net_deposit_accumulated, r.net_deposit_total,
      r.pnl_current, r.pnl_accumulated, r.pnl_total, r.commissions_earned, r.bonus, r.salary_paid, r.total_earned,
    ] as (string | number)[]);
    rows.push(['TOTAL', totalNetDeposit, '', '', totalPnlCurrent, '', '', totalCommissions, totalBonus, totalSalary, totalEarned]);
    downloadCSV(`resultados_${profileData.name.replace(/\s/g, '_')}.csv`, headers, rows);
  });

  const status = profileStatusView(profileData);
  const supervisor = profileData.head_id
    ? commercialProfiles.find((h) => h.id === profileData.head_id) ?? null
    : null;
  const fixedSalary = profileData.fixed_salary && profileData.salary != null ? profileData.salary : null;

  // ── Columnas ────────────────────────────────────────────────────────────
  const resultColumns: FinColumn<CommercialMonthlyResult>[] = [
    { key: 'period', header: t('hr.period'), cell: (r) => getPeriodLabel(r.period_id) },
    { key: 'ndCurrent', header: t('hr.netDepActual'), kind: 'money', value: (r) => r.net_deposit_current },
    { key: 'ndAcc', header: t('hrv.ndAccumulated'), kind: 'money', hideSm: true, value: (r) => r.net_deposit_accumulated, subtotal: false },
    { key: 'ndTotal', header: t('hrv.ndTotal'), kind: 'money', hideSm: true, value: (r) => r.net_deposit_total, subtotal: false },
    { key: 'pnlCurrent', header: t('hr.pnlCurrent'), kind: 'money', hideSm: true, value: (r) => positiveOrNull(r.pnl_current) },
    { key: 'pnlAcc', header: t('hr.pnlAccumulated'), kind: 'money', hideSm: true, value: (r) => positiveOrNull(r.pnl_accumulated), subtotal: false },
    { key: 'pnlTotal', header: t('hr.pnlTotal'), kind: 'money', hideSm: true, value: (r) => positiveOrNull(r.pnl_total), subtotal: false },
    { key: 'commissions', header: t('hr.commissions'), kind: 'money', hideSm: true, value: (r) => r.commissions_earned },
    { key: 'bonus', header: t('hr.bonus'), kind: 'money', hideSm: true, value: (r) => positiveOrNull(r.bonus) },
    { key: 'salary', header: t('hr.salaryCol'), kind: 'money', hideSm: true, value: (r) => positiveOrNull(r.salary_paid) },
    { key: 'totalEarned', header: t('hr.totalEarned'), kind: 'money', value: (r) => r.total_earned },
  ];

  const negColumns: FinColumn<Negotiation>[] = [
    {
      key: 'title',
      header: t('hr.negotiationTitle'),
      cell: (n) => n.title,
      meta: (n) => n.description || undefined,
      mobileMeta: (n) => {
        const v = negStatusView(n.status);
        return <StatusBadge kind={v.kind} label={t(v.labelKey)} />;
      },
    },
    {
      key: 'status',
      header: t('hr.negotiationStatus'),
      hideSm: true,
      cell: (n) => {
        const v = negStatusView(n.status);
        return <StatusBadge kind={v.kind} label={t(v.labelKey)} />;
      },
    },
    {
      key: 'updated',
      header: t('hr.negotiationUpdated'),
      align: 'right',
      cardSide: 'right',
      cell: (n) => <span className="tabular-nums text-text-2">{formatDate(n.updated_at)}</span>,
    },
  ];

  const teamColumns: FinColumn<CommercialProfile>[] = [
    {
      key: 'name',
      header: t('common.name'),
      cell: (sub) => (
        <Link href={`/rrhh/perfil?id=${sub.id}`} className="hover:underline">
          {sub.name}
        </Link>
      ),
      meta: (sub) => `${hrRoleLabel(sub.role)} · ${sub.email}`,
    },
    {
      key: 'ndPct',
      header: t('hr.netDepPct'),
      align: 'right',
      hideSm: true,
      cell: (sub) => <span className="tabular-nums">{pctText(sub.net_deposit_pct) ?? '—'}</span>,
    },
    { key: 'total', header: t('hr.totalEarned'), kind: 'money', value: (sub) => getTotalCommissions(sub.id), subtotal: false },
  ];

  const sections = [
    { value: 'details' as const, label: t('hr.profileDetails') },
    { value: 'results' as const, label: t('hr.monthlyResults'), count: results.length },
    { value: 'negotiations' as const, label: t('hr.negotiations'), count: negLoading ? null : negotiations.length },
    ...(subordinates.length > 0 ? [{ value: 'team' as const, label: t('hr.team'), count: subordinates.length }] : []),
  ];

  /** Un dato del perfil en modo lectura: etiqueta 12.5 `text-2` + valor. */
  const detail = (label: string, value: React.ReactNode) => (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[12.5px] text-text-2">{label}</dt>
      <dd className="text-[13.5px] font-medium text-foreground">{value ?? <span className="text-text-3">—</span>}</dd>
    </div>
  );

  return (
    <div className="space-y-4">
      {Modal2FA}
      {ToastHost}

      {/* ── Cabecera con los datos clave ─────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Link href="/rrhh" className={cn(ROW_ACTION_CLASS, 'mt-0.5')} aria-label={t('hr.backToHr')} title={t('hr.backToHr')}>
            <ArrowLeft aria-hidden className="size-4" />
          </Link>
          <span aria-hidden className="mt-0.5 hidden size-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text-2 sm:flex">
            <UserCircle className="size-6" strokeWidth={1.5} />
          </span>
          <div className="min-w-0">
            <h1 className="text-[20px] font-[650] leading-7 tracking-[-0.015em] text-foreground sm:text-[22px]">
              {profileData.name}
            </h1>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] text-text-2">
              <span>{hrRoleLabel(profileData.role)}</span>
              <span aria-hidden className="text-text-3">·</span>
              <span className="break-all">{profileData.email}</span>
              <StatusBadge kind={status.kind} label={t(status.labelKey)} />
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-text-3">
              {supervisor && (
                <span>
                  {t('hr.supervisor')}:{' '}
                  <Link href={`/rrhh/perfil?id=${supervisor.id}`} className="text-text-2 hover:underline">
                    {supervisor.name}
                  </Link>
                </span>
              )}
              {profileData.hire_date && (
                <span className="inline-flex items-center gap-1">
                  <Calendar aria-hidden className="size-3" />
                  {t('hr.hireDate')}: {formatDateDMY(profileData.hire_date)}
                </span>
              )}
              {profileData.birthday && (
                <span className="inline-flex items-center gap-1">
                  <Gift aria-hidden className="size-3" />
                  {t('hr.birthday')}: {formatDateDMY(profileData.birthday)}
                </span>
              )}
            </p>
          </div>
        </div>
        <ActionButton onClick={handleExport} title={t('hr.downloadCsv')} aria-label={t('hr.downloadCsv')}>
          <Download aria-hidden className="size-[15px]" strokeWidth={1.75} />
          <span className="max-sm:hidden">CSV</span>
        </ActionButton>
      </div>

      <KpiStrip
        items={[
          { key: 'ndPct', label: t('hr.netDepPct'), value: profileData.net_deposit_pct, format: 'percent', missingBadge: false, sub: profileData.net_deposit_pct == null ? t('hrv.notApplicable') : undefined },
          { key: 'pnlPct', label: t('hr.pnlPct'), value: profileData.pnl_pct, format: 'percent', missingBadge: false, sub: profileData.pnl_pct == null ? t('hrv.notApplicable') : undefined },
          { key: 'salary', label: t('hr.fixedSalary'), value: fixedSalary, format: 'money', missingBadge: false, sub: fixedSalary == null ? t('hrv.noFixedSalary') : undefined },
          {
            key: 'earned',
            label: t('hr.totalEarned'),
            value: hasResults ? totalEarned : null,
            hero: true,
            missingBadge: false,
            sub: hasResults ? t('hrv.periodsCount', { n: String(results.length) }) : t('hrv.noSavedResults'),
          },
        ]}
      />

      <Segmented
        options={sections}
        value={section}
        onChange={setSection}
        aria-label={profileData.name}
        className="max-w-full flex-wrap"
      />

      {section === 'details' && (
        <>
          {/* ── Datos del perfil ──────────────────────────────────────────── */}
          <Panel
            title={t('hr.profileDetails')}
            actions={
              !isEditingProfile ? (
                <ActionButton onClick={() => setIsEditingProfile(true)}>
                  <Pencil aria-hidden className="size-[15px]" strokeWidth={1.75} />
                  {t('hr.editProfile')}
                </ActionButton>
              ) : (
                <>
                  <ActionButton variant="ghost" onClick={handleCancelEdit} aria-label={t('common.cancel')}>
                    <X aria-hidden className="size-4" />
                  </ActionButton>
                  <ActionButton variant="primary" onClick={handleSaveProfile} loading={saving}>
                    <Check aria-hidden className="size-[15px]" strokeWidth={1.75} />
                    {t('common.save')}
                  </ActionButton>
                </>
              )
            }
          >
            {isEditingProfile ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <Field label={t('common.name')}>
                  <Input value={editName} onChange={e => setEditName(e.target.value)} />
                </Field>
                <Field label={t('common.email')}>
                  <Input type="email" value={editEmail} onChange={e => setEditEmail(e.target.value)} />
                </Field>
                <Field label={t('hr.role')}>
                  <Select value={editRole} onChange={e => setEditRole(e.target.value as CommercialProfile['role'])}>
                    {/* Las opciones salen del registro de roles comerciales. */}
                    {HR_COMMERCIAL_ROLES.map((r) => (
                      <option key={r} value={r}>{hrRoleLabel(r)}</option>
                    ))}
                  </Select>
                </Field>
                {editRole === 'bdm' && (
                  <Field label={t('hr.supervisor')}>
                    <Select value={editHeadId} onChange={e => setEditHeadId(e.target.value)}>
                      <option value="">{t('hr.noSupervisor')}</option>
                      {heads.map(h => (
                        <option key={h.id} value={h.id}>{h.name} ({hrRoleLabel(h.role)})</option>
                      ))}
                    </Select>
                  </Field>
                )}
                <Field label={t('hr.netDepPct')}>
                  <Input type="number" value={editNdPct} onChange={e => setEditNdPct(e.target.value)} placeholder={t('hr.ndPctPlaceholder')} className="text-right tabular-nums" />
                </Field>
                <Field label={t('hr.pnlPct')}>
                  <Input type="number" value={editPnlPct} onChange={e => setEditPnlPct(e.target.value)} placeholder={t('hr.pnlPctPlaceholder')} className="text-right tabular-nums" />
                </Field>
                <Field label={t('hr.commissionPerLot')}>
                  <Input type="number" value={editCommLot} onChange={e => setEditCommLot(e.target.value)} placeholder={t('hr.commLotPlaceholder')} className="text-right tabular-nums" />
                </Field>
                <Field label={t('hr.fixedSalary')}>
                  <Input type="number" value={editSalary} onChange={e => setEditSalary(e.target.value)} placeholder={t('hr.salaryUsdPlaceholder')} className="text-right tabular-nums" />
                </Field>
                <Field label={t('hr.benefits')}>
                  <Input value={editBenefits} onChange={e => setEditBenefits(e.target.value)} placeholder={t('hr.benefitsPlaceholder')} />
                </Field>
                <Field label={t('hr.comments')}>
                  <Input value={editComments} onChange={e => setEditComments(e.target.value)} placeholder={t('hr.commentsPlaceholder')} />
                </Field>
                <Field label={t('hr.hireDate')}>
                  <Input type="date" value={editHireDate} onChange={e => setEditHireDate(e.target.value)} />
                </Field>
                <Field label={t('hr.birthday')}>
                  <Input type="date" value={editBirthday} onChange={e => setEditBirthday(e.target.value)} />
                </Field>
                <Field label={t('hr.status')}>
                  <Select value={editStatus} onChange={e => setEditStatus(e.target.value as 'active' | 'inactive')}>
                    <option value="active">{t('hr.statusActive')}</option>
                    <option value="inactive">{t('hr.statusInactive')}</option>
                  </Select>
                </Field>
              </div>
            ) : (
              <dl className="grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2 lg:grid-cols-3">
                {detail(t('common.name'), profileData.name)}
                {detail(t('common.email'), <span className="break-all">{profileData.email}</span>)}
                {detail(t('hr.role'), hrRoleLabel(profileData.role))}
                {profileData.role === 'bdm' && profileData.head_id &&
                  detail(t('hr.supervisor'), heads.find((h) => h.id === profileData.head_id)?.name ?? null)}
                {detail(t('hr.netDepPct'), pctText(profileData.net_deposit_pct))}
                {detail(t('hr.pnlPct'), pctText(profileData.pnl_pct))}
                {/* Comisión por lote: antes un template «$» + número armado a
                    mano (spec §4: el dinero sale sólo de formatMoney). */}
                {detail(t('hr.commissionPerLot'), profileData.commission_per_lot != null ? <Money value={profileData.commission_per_lot} /> : null)}
                {detail(t('hr.fixedSalary'), fixedSalary != null ? <Money value={fixedSalary} /> : null)}
                {detail(t('hr.benefits'), profileData.benefits || null)}
                {detail(t('hr.comments'), profileData.comments || null)}
                {detail(t('hr.hireDate'), profileData.hire_date ? formatDateDMY(profileData.hire_date) : null)}
                {detail(t('hr.birthday'), profileData.birthday ? formatDateDMY(profileData.birthday) : null)}
                {detail(t('hr.status'), <StatusBadge kind={status.kind} label={t(status.labelKey)} />)}
              </dl>
            )}
          </Panel>

          {/* ── Contrato ──────────────────────────────────────────────────── */}
          <Panel
            title={t('hrv.contract')}
            actions={
              profileData.contract_url ? <StatusBadge kind="ok" label={t('hrv.onFile')} /> : <StatusBadge kind="pend" label={t('hrv.missing')} />
            }
          >
            <div className="space-y-3">
              {profileData.contract_url ? (
                <div className="flex flex-wrap items-center gap-3 rounded-ui-md border border-border bg-surface-2 px-3 py-2">
                  <FileText aria-hidden className="size-4 shrink-0 text-text-3" />
                  <span className="flex-1 text-[13px] text-foreground">{t('hr.contractUploaded')}</span>
                  <a
                    href={withActiveCompany(`/api/admin/contract-url/${profileData.id}`)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={actionButtonClass('secondary')}
                  >
                    <ExternalLink aria-hidden className="size-3.5" /> {t('hr.viewContract')}
                  </a>
                </div>
              ) : (
                <p className="text-[13px] text-text-3">{t('hrv.noContractYet')}</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <FilePick
                    file={contractFile}
                    onFile={setContractFile}
                    placeholder={profileData.contract_url ? t('hr.changeContract') : t('hrv.uploadContractHint')}
                  />
                </div>
                {contractFile && (
                  <ActionButton onClick={handleContractUpload} loading={uploadingContract}>
                    {uploadingContract ? t('hr.uploadingContract') : t('hrv.upload')}
                  </ActionButton>
                )}
              </div>
            </div>
          </Panel>

          {/* El formulario "Agregar resultado mensual" se quitó (auditoría
              2026-08-06): mostraba "Guardado" sin persistir NADA — solo hacía
              setResults local y el dato desaparecía al recargar. Además dejaba
              editar `bonus`, que en realidad guarda la deuda arrastrada del
              cálculo de comisiones. Los resultados se generan y guardan en
              /comisiones, donde el cálculo es el real. */}
          <Notice
            kind="info"
            title={t('hr.addMonthlyResult')}
            action={
              <Link href="/comisiones" className={actionButtonClass('secondary')}>
                <Calculator aria-hidden className="size-[15px]" strokeWidth={1.75} />
                {t('hrv.goToCommissions')}
              </Link>
            }
          >
            {t('hrv.resultsFromCommissions')}
          </Notice>
        </>
      )}

      {/* ── Resultados mensuales ───────────────────────────────────────────── */}
      {section === 'results' && (
        <Panel title={t('hr.monthlyResults')} hint={t('hrv.periodsCount', { n: String(results.length) })} flush>
          <FinTable
            columns={resultColumns}
            rows={results}
            rowKey={(r) => r.id}
            caption={t('hr.monthlyResults')}
            empty={t('hr.noResults')}
            footer={
              hasResults
                ? {
                    label: t('hr.total'),
                    // Los acumulados y totales de ND/PnL no se suman entre
                    // meses (cada uno ya arrastra el anterior): quedan vacíos,
                    // igual que en el CSV.
                    values: {
                      ndCurrent: totalNetDeposit,
                      pnlCurrent: positiveOrNull(totalPnlCurrent),
                      commissions: totalCommissions,
                      bonus: positiveOrNull(totalBonus),
                      salary: positiveOrNull(totalSalary),
                      totalEarned,
                    },
                  }
                : undefined
            }
          />
        </Panel>
      )}

      {/* ── Negociaciones ──────────────────────────────────────────────────── */}
      {section === 'negotiations' && (
        <Panel title={t('hr.negotiations')} flush>
          {negLoading ? (
            <p className="px-4 py-8 text-center text-[13px] text-text-3">{t('common.loading')}</p>
          ) : (
            <FinTable
              columns={negColumns}
              rows={negotiations}
              rowKey={(n) => n.id}
              caption={t('hr.negotiations')}
              empty={t('hr.noNegotiations')}
              rowActions={(n) => (
                <button
                  type="button"
                  onClick={() => handleDeleteNegotiation(n.id)}
                  className={ROW_DANGER_CLASS}
                  aria-label={t('common.delete')}
                  title={t('common.delete')}
                >
                  <Trash2 aria-hidden className="size-[15px]" strokeWidth={1.75} />
                </button>
              )}
            />
          )}
        </Panel>
      )}

      {/* ── Equipo ─────────────────────────────────────────────────────────── */}
      {section === 'team' && subordinates.length > 0 && (
        <Panel title={t('hr.team')} hint={t('hrv.membersCount', { n: String(subordinates.length) })} flush>
          <FinTable columns={teamColumns} rows={subordinates} rowKey={(s) => s.id} caption={t('hr.team')} />
        </Panel>
      )}
    </div>
  );
}
