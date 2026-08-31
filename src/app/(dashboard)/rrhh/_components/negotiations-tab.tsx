'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { useI18n } from '@/lib/i18n';
import { useData } from '@/lib/data-context';
import { apiFetch } from '@/lib/api-fetch';
import { formatDate } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import type { Negotiation, NegotiationStatus } from '@/lib/types';
import { hrRoleBadgeClass, hrRoleLabel } from '@/lib/hr/domain';
import { NegotiationForm, type NegFormData } from './negotiation-form';

// ─────────────────────────────────────────────────────────────────────────────
// Pestaña NEGOCIACIONES (de perfiles comerciales).
//
// Movida desde rrhh/page.tsx el 2026-08-31. Sigue cargándose sola contra
// /api/admin/negotiations y NO pasa por el overview: no es un dato por mes —
// una negociación abierta se ve igual mire uno julio o agosto. Meterla en el
// overview la ataría al selector y la haría desaparecer al cambiar de mes.
//
// `negotiations` ≠ `ib_negotiations`; ver la cabecera de negotiation-form.tsx.
// ─────────────────────────────────────────────────────────────────────────────

const NEG_STATUS_BADGE: Record<string, string> = {
  active: 'bg-positive/10 text-positive',
  pending: 'bg-warning/10 text-warning',
  closed: 'bg-negative/10 text-negative',
};

const NEG_STATUS_LABELS: Record<string, string> = {
  active: 'hr.negStatusActive',
  pending: 'hr.negStatusPending',
  closed: 'hr.negStatusClosed',
};

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
  const [negFilterStatus, setNegFilterStatus] = useState<'' | NegotiationStatus>('');
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

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <Card>
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex flex-col sm:flex-row gap-2 flex-1 w-full sm:w-auto">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                aria-label={t('hr.searchNegotiations')}
                value={negSearch}
                onChange={e => setNegSearch(e.target.value)}
                placeholder={t('hr.searchNegotiations')}
                className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
              />
            </div>
            <select
              aria-label={t('hr.allProfiles')}
              value={negFilterProfile}
              onChange={e => setNegFilterProfile(e.target.value)}
              className="px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm"
            >
              <option value="">{t('hr.allProfiles')}</option>
              {profiles.filter(p => p.status === 'active').map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select
              aria-label={t('hr.allStatuses')}
              value={negFilterStatus}
              onChange={e => setNegFilterStatus(e.target.value as '' | NegotiationStatus)}
              className="px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm"
            >
              <option value="">{t('hr.allStatuses')}</option>
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
                  <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('hr.negotiationTitle')}</th>
                  <th className="text-left py-2.5 px-3 text-muted-foreground font-medium hidden sm:table-cell">{t('common.name')}</th>
                  <th className="text-left py-2.5 px-3 text-muted-foreground font-medium hidden sm:table-cell">{t('common.email')}</th>
                  <th className="text-left py-2.5 px-3 text-muted-foreground font-medium hidden md:table-cell">{t('hr.negotiationDesc')}</th>
                  <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('hr.negotiationStatus')}</th>
                  <th className="text-left py-2.5 px-3 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.negotiationUpdated')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {filteredNegotiations.map(neg => {
                  const profile = profiles.find(p => p.id === neg.profile_id);
                  return (
                    <tr key={neg.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                      <td className="py-2.5 px-3 font-medium">{neg.title}</td>
                      <td className="py-2.5 px-3 hidden sm:table-cell">
                        <div>
                          <span className="font-medium">{profile?.name || '-'}</span>
                          {profile && (
                            <span className={cn('ml-2 px-1.5 py-0.5 rounded-full text-[10px] font-medium', hrRoleBadgeClass(profile.role))}>
                              {hrRoleLabel(profile.role)}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-muted-foreground text-xs hidden sm:table-cell">{profile?.email || '-'}</td>
                      <td className="py-2.5 px-3 text-muted-foreground text-xs max-w-[200px] truncate hidden md:table-cell">{neg.description || '-'}</td>
                      <td className="py-2.5 px-3">
                        <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', NEG_STATUS_BADGE[neg.status])}>
                          {t(NEG_STATUS_LABELS[neg.status])}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-muted-foreground text-xs hidden sm:table-cell">
                        {formatDate(neg.updated_at)}
                      </td>
                      <td className="py-2.5 px-3 text-right">
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
  );
}
