'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel } from '@/components/ui/panel';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Segmented } from '@/components/ui/segmented';
import { Select } from '@/components/ui/field';
import { ActionButton } from '@/components/ui/action-button';
import { useI18n } from '@/lib/i18n';
import { useData } from '@/lib/data-context';
import { apiFetch } from '@/lib/api-fetch';
import { formatDate } from '@/lib/dates';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { Negotiation, NegotiationStatus } from '@/lib/types';
import { hrRoleLabel } from '@/lib/hr/domain';
import { NegotiationForm, type NegFormData } from './negotiation-form';
import { ROW_ACTION_CLASS, ROW_DANGER_CLASS, SearchField } from './hr-ui';
import { NEG_STATUSES, negStatusView } from './hr-view';

// ─────────────────────────────────────────────────────────────────────────────
// Pestaña NEGOCIACIONES (de perfiles comerciales).
//
// Movida desde rrhh/page.tsx el 2026-08-31. Sigue cargándose sola contra
// /api/admin/negotiations y NO pasa por el overview: no es un dato por mes —
// una negociación abierta se ve igual mire uno julio o agosto. Meterla en el
// overview la ataría al selector y la haría desaparecer al cambiar de mes.
//
// `negotiations` ≠ `ib_negotiations`; ver la cabecera de negotiation-form.tsx.
//
// «Libro mayor» (2026-10-12) — sólo presentación: FinTable con el perfil y su
// rol como metadato, estado con StatusBadge desde NEG_STATUS_VIEW (hr-view.ts;
// antes `NEG_STATUS_BADGE` local, con «cerrada» en ROJO — cerrar un trato no
// es un error; spec §5.5 «Cerrado» = neutro); el filtro de estado pasó de
// <select> a Segmented con conteos; el pie cuenta el recorte del filtro
// («Mostrando 4 de 19»), que antes no se veía. Medición (sin comentarios):
// antes 2 clases de paleta cruda, 1 `text-[10px]` y 23 tokens legados;
// después 0.
// ─────────────────────────────────────────────────────────────────────────────

type StatusFilter = '' | NegotiationStatus;

export function NegotiationsTab({
  onToast,
}: {
  onToast: (t: { type: 'success' | 'error'; msg: string }) => void;
}) {
  const { t } = useI18n();
  const { company, commercialProfiles: profiles, refresh } = useData();

  const [negotiations, setNegotiations] = useState<Negotiation[]>([]);
  const [negLoading, setNegLoading] = useState(false);
  const [showNegForm, setShowNegForm] = useState(false);
  const [editingNeg, setEditingNeg] = useState<Negotiation | undefined>();
  const [negSearch, setNegSearch] = useState('');
  const [negFilterProfile, setNegFilterProfile] = useState('');
  const [negFilterStatus, setNegFilterStatus] = useState<StatusFilter>('');
  const [savingNeg, setSavingNeg] = useState(false);
  const [negError, setNegError] = useState('');

  const fetchNegotiations = useCallback(async () => {
    if (!company?.id) return;
    setNegLoading(true);
    try {
      const res = await apiFetch(`/api/admin/negotiations?company_id=${company.id}`);
      if (res.ok) setNegotiations(await res.json());
    } catch { /* ignore */ }
    setNegLoading(false);
  }, [company?.id]);

  // Se carga al montar. Antes el efecto vivía en la página y miraba `tab`;
  // ahora la pestaña sólo existe cuando está seleccionada, que es lo mismo.
  useEffect(() => { fetchNegotiations(); }, [fetchNegotiations]);

  const handleSaveNegotiation = async (data: NegFormData) => {
    if (!company?.id) return;
    setSavingNeg(true);
    setNegError('');
    try {
      let resolvedProfileId = data.profile_id;

      // Un perfil no puede tener dos negociaciones (sólo se chequea al crear).
      if (!editingNeg) {
        if (resolvedProfileId) {
          const existing = negotiations.find(n => n.profile_id === resolvedProfileId);
          if (existing) {
            const profileName = profiles.find(p => p.id === resolvedProfileId)?.name || '';
            throw new Error(`${profileName} ya tiene una negociacion registrada: "${existing.title}"`);
          }
        }
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

      // Si hay que crear el perfil primero
      if (data.newProfile) {
        const profileRes = await apiFetch('/api/admin/commercial-profiles', {
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
        await refresh();
      }

      if (data.contractFile && resolvedProfileId) {
        const formData = new FormData();
        formData.append('file', data.contractFile);
        formData.append('profile_id', resolvedProfileId);
        const uploadRes = await apiFetch('/api/admin/upload-contract', { method: 'POST', body: formData });
        const uploadResult = await uploadRes.json();
        if (!uploadRes.ok || uploadResult.error) throw new Error(uploadResult.error || 'Error subiendo contrato');
      }

      const body = editingNeg
        ? { action: 'update', id: editingNeg.id, title: data.title, description: data.description, status: data.status }
        : { action: 'create', company_id: company.id, profile_id: resolvedProfileId, title: data.title, description: data.description, status: data.status };
      const res = await apiFetch('/api/admin/negotiations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await res.json();
      if (!res.ok || result.error) throw new Error(result.error);
      setShowNegForm(false);
      setEditingNeg(undefined);
      onToast({
        type: 'success',
        msg: data.newProfile
          ? `${t('hr.profileCreated')} + ${t('hr.negotiationSaved')}`
          : t('hr.negotiationSaved'),
      });
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
      const res = await apiFetch('/api/admin/negotiations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      });
      const result = await res.json();
      if (!res.ok || result.error) throw new Error(result.error);
      onToast({ type: 'success', msg: t('hr.negotiationDeleted') });
      fetchNegotiations();
    } catch (err) {
      onToast({ type: 'error', msg: err instanceof Error ? err.message : 'Error' });
    }
  };

  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);

  // Búsqueda + perfil primero; el estado después, para que los conteos del
  // Segmented digan cuántas filas suma cada estado con lo demás aplicado.
  const searched = negotiations.filter((n) => {
    if (negFilterProfile && n.profile_id !== negFilterProfile) return false;
    if (negSearch) {
      const s = negSearch.toLowerCase();
      const profile = profileById.get(n.profile_id);
      return n.title.toLowerCase().includes(s) || (n.description || '').toLowerCase().includes(s) || (profile?.name || '').toLowerCase().includes(s) || (profile?.email || '').toLowerCase().includes(s);
    }
    return true;
  });
  const filteredNegotiations = negFilterStatus ? searched.filter((n) => n.status === negFilterStatus) : searched;
  const countOf = (st: NegotiationStatus) => searched.filter((n) => n.status === st).length;

  const columns: FinColumn<Negotiation>[] = [
    {
      key: 'title',
      header: t('hr.negotiationTitle'),
      cell: (neg) => neg.title,
      meta: (neg) => {
        const profile = profileById.get(neg.profile_id);
        return profile ? `${profile.name} · ${hrRoleLabel(profile.role)}` : '—';
      },
      mobileMeta: (neg) => {
        const v = negStatusView(neg.status);
        return <StatusBadge kind={v.kind} label={t(v.labelKey)} />;
      },
    },
    {
      key: 'email',
      header: t('common.email'),
      hideSm: true,
      cell: (neg) => <span className="text-text-2">{profileById.get(neg.profile_id)?.email || '—'}</span>,
    },
    {
      key: 'description',
      header: t('hr.negotiationDesc'),
      hideSm: true,
      cell: (neg) => (
        <span className="block max-w-[260px] truncate text-text-2" title={neg.description || undefined}>
          {neg.description || '—'}
        </span>
      ),
    },
    {
      key: 'status',
      header: t('hr.negotiationStatus'),
      hideSm: true,
      cell: (neg) => {
        const v = negStatusView(neg.status);
        return <StatusBadge kind={v.kind} label={t(v.labelKey)} />;
      },
    },
    {
      key: 'updated',
      header: t('hr.negotiationUpdated'),
      align: 'right',
      cardSide: 'right',
      cell: (neg) => <span className="tabular-nums text-text-2">{formatDate(neg.updated_at)}</span>,
    },
  ];

  return (
    <div className="space-y-4">
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

      <Panel
        title={t('hr.negotiations')}
        actions={
          <ActionButton
            variant="primary"
            onClick={() => { setEditingNeg(undefined); setNegError(''); setShowNegForm(true); }}
          >
            <Plus aria-hidden className="size-[15px]" strokeWidth={1.75} /> {t('hr.addNegotiation')}
          </ActionButton>
        }
        flush
        footer={
          !negLoading && filteredNegotiations.length < negotiations.length
            ? t('hrv.rowsShowing', { shown: String(filteredNegotiations.length), total: String(negotiations.length) })
            : undefined
        }
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <SearchField
            value={negSearch}
            onChange={setNegSearch}
            placeholder={t('hr.searchNegotiations')}
            className="max-w-[320px] flex-1"
          />
          <div className="w-56 max-sm:w-full">
            <Select
              aria-label={t('hr.allProfiles')}
              value={negFilterProfile}
              onChange={(e) => setNegFilterProfile(e.target.value)}
            >
              <option value="">{t('hr.allProfiles')}</option>
              {profiles.filter(p => p.status === 'active').map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </div>
          <Segmented<StatusFilter>
            options={[
              { value: '', label: t('hr.allStatuses'), count: searched.length },
              ...NEG_STATUSES.map((st) => ({ value: st, label: t(negStatusView(st).labelKey), count: countOf(st) })),
            ]}
            value={negFilterStatus}
            onChange={setNegFilterStatus}
            aria-label={t('hr.negotiationStatus')}
            className="max-w-full flex-wrap"
          />
        </div>

        {negLoading ? (
          <p className="px-4 py-8 text-center text-[13px] text-text-3">{t('common.loading')}</p>
        ) : (
          <FinTable
            columns={columns}
            rows={filteredNegotiations}
            rowKey={(neg) => neg.id}
            caption={t('hr.negotiations')}
            empty={t('hr.noNegotiations')}
            rowActions={(neg) => (
              <>
                <button
                  type="button"
                  onClick={() => { setEditingNeg(neg); setShowNegForm(true); }}
                  className={ROW_ACTION_CLASS}
                  aria-label={t('common.edit')}
                  title={t('common.edit')}
                >
                  <Pencil aria-hidden className="size-[15px]" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  onClick={() => handleDeleteNegotiation(neg.id)}
                  className={ROW_DANGER_CLASS}
                  aria-label={t('common.delete')}
                  title={t('common.delete')}
                >
                  <Trash2 aria-hidden className="size-[15px]" strokeWidth={1.75} />
                </button>
              </>
            )}
          />
        )}
      </Panel>
    </div>
  );
}
