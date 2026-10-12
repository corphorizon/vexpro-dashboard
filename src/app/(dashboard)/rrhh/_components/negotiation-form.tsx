'use client';

import { useState } from 'react';
import { Users, Plus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { Segmented } from '@/components/ui/segmented';
import { ActionButton } from '@/components/payment-orders/action-button';
import { hrRoleLabel } from '@/lib/hr/domain';
import type { CommercialProfile, Negotiation, NegotiationStatus } from '@/lib/types';
import { FilePick, HrModal } from './hr-ui';
import { NEG_STATUSES, NEG_STATUS_VIEW } from './hr-view';

// ─────────────────────────────────────────────────────────────────────────────
// Modal de una NEGOCIACIÓN de perfil comercial (`negotiations`).
//
// OJO: `negotiations` es OTRA COSA que `ib_negotiations`. Ésta cuelga de un
// `commercial_profiles` (gente de la estructura); aquélla es de IBs del CRM,
// que son clientes que refieren y casi nunca tienen perfil comercial (114 de
// 1.793 sponsors distintos). Kevin las pidió «por aparte» el 2026-08-27.
//
// Movido desde rrhh/page.tsx el 2026-08-31 sin cambiar comportamiento.
//
// «Libro mayor» (2026-10-12) — sólo presentación: el modal es HrModal; los
// campos, Field/Input/Select/Textarea (label visible atado por `htmlFor`,
// antes `<label>` sueltos + `aria-label` duplicado y tres en `text-[10px]`);
// «perfil existente / nuevo» es un Segmented; las opciones de estado salen de
// NEG_STATUS_VIEW (hr-view.ts), la misma lista que pinta el badge. El payload
// de `onSave` no cambió. Medición (sin comentarios): antes 3 clases de paleta
// cruda (`text-white`, `border-white`), 3 `text-[10px]` y 24 tokens legados;
// después 0.
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
    <HrModal
      title={editing ? t('hr.editNegotiation') : t('hr.newNegotiation')}
      onClose={onClose}
      footer={
        <>
          <ActionButton variant="ghost" onClick={onClose}>{t('common.cancel')}</ActionButton>
          <ActionButton variant="primary" onClick={handleSubmit} disabled={!canSubmit} loading={saving}>
            {saving ? t('hr.saving') : t('common.save')}
          </ActionButton>
        </>
      }
    >
      <div className="space-y-4">
        {/* Profile selection — existing or new */}
        {!editing && (
          <div className="space-y-3">
            <Segmented
              options={[
                {
                  value: 'existing',
                  label: (
                    <>
                      <Users aria-hidden className="size-3.5" /> {t('hr.existingProfile')}
                    </>
                  ),
                },
                {
                  value: 'new',
                  label: (
                    <>
                      <Plus aria-hidden className="size-3.5" /> {t('hr.createNewProfile')}
                    </>
                  ),
                },
              ]}
              value={mode}
              onChange={setMode}
              aria-label={t('hr.selectProfile')}
            />

            {mode === 'existing' ? (
              <Field label={t('hr.selectProfile')} required>
                <Select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} ({hrRoleLabel(p.role)})</option>
                  ))}
                </Select>
              </Field>
            ) : (
              <div className="space-y-3 rounded-ui-md border border-border bg-surface-2 p-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t('common.name')} required>
                    <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('hr.fullNamePlaceholder')} />
                  </Field>
                  <Field label={t('common.email')} required>
                    <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder={t('hr.emailExamplePlaceholder')} />
                  </Field>
                </div>
                <Field label={t('hr.role')}>
                  <Input value={newRole} onChange={(e) => setNewRole(e.target.value)} placeholder={t('hr.roleExamplePlaceholder')} />
                </Field>
              </div>
            )}
          </div>
        )}

        <Field label={t('hr.negotiationTitle')} required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('hr.titlePlaceholder')} />
        </Field>
        <Field label={t('hr.negotiationDesc')}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('hr.descriptionPlaceholder')} className="resize-none" />
        </Field>
        <Field label={t('hr.negotiationStatus')}>
          <Select value={status} onChange={(e) => setStatus(e.target.value as NegotiationStatus)}>
            {NEG_STATUSES.map((st) => (
              <option key={st} value={st}>{t(NEG_STATUS_VIEW[st].labelKey)}</option>
            ))}
          </Select>
        </Field>

        {/* Contract upload */}
        <div className="flex flex-col gap-1">
          <span className="text-[12.5px] font-medium text-text-2">{t('hr.signedContract')}</span>
          <FilePick file={contractFile} onFile={setContractFile} placeholder={t('hr.uploadContract')} />
        </div>

        {errorMsg && <Notice kind="bad" title={errorMsg} />}
      </div>
    </HrModal>
  );
}
