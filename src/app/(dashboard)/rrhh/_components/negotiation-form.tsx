'use client';

import { useState } from 'react';
import { X, Upload, Users, Plus, AlertCircle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { hrRoleLabel } from '@/lib/hr/domain';
import type { CommercialProfile, Negotiation, NegotiationStatus } from '@/lib/types';

// ─────────────────────────────────────────────────────────────────────────────
// Modal de una NEGOCIACIÓN de perfil comercial (`negotiations`).
//
// OJO: `negotiations` es OTRA COSA que `ib_negotiations`. Ésta cuelga de un
// `commercial_profiles` (gente de la estructura); aquélla es de IBs del CRM,
// que son clientes que refieren y casi nunca tienen perfil comercial (114 de
// 1.793 sponsors distintos). Kevin las pidió «por aparte» el 2026-08-27.
//
// Movido desde rrhh/page.tsx el 2026-08-31 sin cambiar comportamiento.
// ─────────────────────────────────────────────────────────────────────────────

export type NegFormData = {
  title: string;
  description: string;
  status: NegotiationStatus;
  profile_id: string;
  newProfile?: { name: string; email: string; role: string };
  contractFile?: File | null;
};

export function NegotiationForm({ onClose, onSave, editing, profiles, saving, errorMsg }: {
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
          <button onClick={onClose} aria-label={t('common.close')} className="p-2 sm:p-1 rounded hover:bg-muted"><X className="w-5 h-5" /></button>
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
                  {t('hr.existingProfile')}
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
                  {t('hr.createNewProfile')}
                </button>
              </div>

              {mode === 'existing' ? (
                <select aria-label={t('hr.selectProfile')} value={profileId} onChange={e => setProfileId(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]">
                  {profiles.map(p => (
                    <option key={p.id} value={p.id}>{p.name} ({hrRoleLabel(p.role)})</option>
                  ))}
                </select>
              ) : (
                <div className="border border-border rounded-lg p-3 bg-muted/30 space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-medium text-muted-foreground mb-1">{t('common.name')} *</label>
                      <input aria-label={t('common.name')} value={newName} onChange={e => setNewName(e.target.value)} placeholder={t('hr.fullNamePlaceholder')} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium text-muted-foreground mb-1">{t('common.email')} *</label>
                      <input aria-label={t('common.email')} type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder={t('hr.emailExamplePlaceholder')} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium text-muted-foreground mb-1">{t('hr.role')}</label>
                    <input aria-label={t('hr.role')} value={newRole} onChange={e => setNewRole(e.target.value)} placeholder={t('hr.roleExamplePlaceholder')} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
                  </div>
                </div>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.negotiationTitle')}</label>
            <input aria-label={t('hr.negotiationTitle')} value={title} onChange={e => setTitle(e.target.value)} placeholder={t('hr.titlePlaceholder')} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.negotiationDesc')}</label>
            <textarea aria-label={t('hr.negotiationDesc')} value={description} onChange={e => setDescription(e.target.value)} placeholder={t('hr.descriptionPlaceholder')} rows={3} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)] resize-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.negotiationStatus')}</label>
            <select aria-label={t('hr.negotiationStatus')} value={status} onChange={e => setStatus(e.target.value as NegotiationStatus)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]">
              <option value="active">{t('hr.negStatusActive')}</option>
              <option value="pending">{t('hr.negStatusPending')}</option>
              <option value="closed">{t('hr.negStatusClosed')}</option>
            </select>
          </div>

          {/* Contract upload */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">{t('hr.signedContract')}</label>
            <div className="flex items-center gap-2">
              <label className="flex-1 cursor-pointer">
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border hover:border-[var(--color-secondary)] hover:bg-muted/50 transition-colors">
                  <Upload className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">
                    {contractFile ? contractFile.name : t('hr.uploadContract')}
                  </span>
                </div>
                <input type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg" className="hidden" onChange={(e) => setContractFile(e.target.files?.[0] || null)} />
              </label>
              {contractFile && (
                <button type="button" onClick={() => setContractFile(null)} className="p-2 sm:p-1 rounded hover:bg-muted">
                  <X className="w-4 h-4 text-muted-foreground" />
                </button>
              )}
            </div>
          </div>
        </div>
        {errorMsg && (
          <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-negative/10/30 border border-negative/30">
            <AlertCircle className="w-4 h-4 text-negative shrink-0 mt-0.5" />
            <span className="text-sm text-negative">{errorMsg}</span>
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
