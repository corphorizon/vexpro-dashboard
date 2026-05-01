'use client';

import { useEffect, useRef, useState } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { updateCommercialProfile } from '@/lib/supabase/mutations';
import type { CommercialProfile, TerminationCategory } from '@/lib/types';
import { TERMINATION_CATEGORIES } from '@/lib/types';

// ─────────────────────────────────────────────────────────────────────────────
// FireModal
//
// Modal de confirmación para despedir un commercial_profile. Obliga a elegir
// categoría y a escribir detalles — ambas son required, validadas antes del
// PATCH.
//
// El registro NO se borra. Al confirmar:
//   - status              = 'inactive'
//   - termination_date    = hoy (editable)
//   - termination_reason  = texto libre del form
//   - termination_category= una de TERMINATION_CATEGORIES
//   - terminated_by       = user.id del caller
//
// Esto preserva FK integrity con commercial_monthly_results para poder cargar
// net deposits negativos post-despido.
// ─────────────────────────────────────────────────────────────────────────────

interface FireModalProps {
  profile: CommercialProfile;
  onClose: () => void;
  /**
   * Puede ser async. Awaited antes de desmontar el modal para que el
   * padre pueda terminar `refresh()` y la UI re-renderice con data fresca
   * antes de que el componente se cierre (evita "parece que no pasó nada").
   */
  onSuccess: () => void | Promise<void>;
}

export function FireModal({ profile, onClose, onSuccess }: FireModalProps) {
  const { t } = useI18n();
  const [category, setCategory] = useState<TerminationCategory | ''>('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Track mounted state so we can safely call setSaving(false) in the
  // finally block — if `onSuccess()` unmounts the modal (the typical
  // success path) the setState would otherwise log a React warning.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleConfirm = async () => {
    if (!category || !reason.trim()) {
      setError(t('hr.fireValidationRequired'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await updateCommercialProfile(profile.id, {
        status: 'inactive',
        termination_date: date,
        termination_reason: reason.trim(),
        termination_category: category,
        // `terminated_by` FKs to auth.users(id), pero `user.id` del
        // auth-context viene de company_users (PK de la membership), no
        // del auth user. Mandamos null por ahora — si se quiere trackear
        // quién ejecutó el despido habría que exponer auth_user_id en el
        // contexto y usarlo acá.
        terminated_by: null,
      });
      // IMPORTANTE: await para que el padre termine su refresh() antes de
      // desmontarnos. Si cerráramos el modal primero, la UI renderizaría
      // con data stale del DataProvider y el usuario vería "no pasó nada".
      await onSuccess();
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : t('hr.fireError'));
      }
    } finally {
      // Always reset the spinner — guarded so an unmounted parent doesn't
      // emit a React warning. Replaces the previous "only on error" reset
      // which left the button stuck if `onSuccess` rejected late.
      if (mountedRef.current) {
        setSaving(false);
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
    >
      <div className="bg-card rounded-xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
            <div>
              <h3 className="font-semibold text-lg">{t('hr.fireModalTitle')}</h3>
              <p className="text-xs text-muted-foreground">{profile.name}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            className="p-1 rounded hover:bg-muted disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-xs text-muted-foreground mb-4">{t('hr.fireModalSubtitle')}</p>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              {t('hr.fireCategoryLabel')}
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as TerminationCategory)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
            >
              <option value="">—</option>
              {TERMINATION_CATEGORIES.map((c) => (
                <option key={c} value={c}>{t(`hr.category${c.charAt(0).toUpperCase()}${c.slice(1)}`)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              {t('hr.fireReasonLabel')}
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('hr.fireReasonPlaceholder')}
              rows={4}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)] resize-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              {t('hr.fireDateLabel')}
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
            />
          </div>
        </div>

        {error && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-xs">
            {error}
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
          >
            {t('hr.fireCancel')}
          </button>
          <button
            onClick={handleConfirm}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50"
          >
            {saving ? '…' : t('hr.fireConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
