'use client';

import { useState, useCallback, useEffect, useId, useRef } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { ShieldCheck, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { OTP_LENGTH } from '@/lib/auth-form';
import { Field } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { AuthIcon, ICON_BUTTON_CLASS } from '@/components/auth/auth-shell';
import { AuthSubmit, OtpInput } from '@/components/auth/auth-controls';

// ─────────────────────────────────────────────────────────────────────────────
// Verify2FAModal — pide el código TOTP antes de una exportación
// (/api/auth/verify-pin). Lo usan 13 pantallas vía `useExport2FA`.
//
// Rediseño «Libro mayor» (2026-10-12): mismo input de código que login/setup
// (`OtpInput`: `inputmode="numeric"`, `autocomplete="one-time-code"`, 24 px
// tabular), `rounded-ui-xl` + `shadow-3` (modales, spec §2.2), scrim de la
// spec (`rgb(0 0 0/.45)`, igual que el drawer del sidebar).
// Antes: sin `role="dialog"` ni nombre accesible, el input sin label (sólo
// placeholder «000000»), la X sin `aria-label`, sin Escape, textos sin tildes
// («Verificacion», «codigo»). Ahora: diálogo modal con título, Escape cierra,
// Tab no se escapa del diálogo y el foco vuelve a quien lo abrió.
// Lógica sin cambios: 6 dígitos → POST verify-pin → onVerified / error.
//
// DESCARTADO: `<dialog>` nativo con showModal() — el resto de los modales del
// repo (confirm-dialog) usan este patrón; mezclar dos dispara diferencias de
// foco y de scroll entre pantallas.
// ─────────────────────────────────────────────────────────────────────────────

interface Verify2FAModalProps {
  open: boolean;
  onVerified: () => void;
  onClose: () => void;
}

export function Verify2FAModal({ open, onVerified, onClose }: Verify2FAModalProps) {
  if (!open) return null;
  return <Verify2FADialog onVerified={onVerified} onClose={onClose} />;
}

function Verify2FADialog({ onVerified, onClose }: Omit<Verify2FAModalProps, 'open'>) {
  const { t } = useI18n();
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleClose = useCallback(() => {
    setToken('');
    setError('');
    onClose();
  }, [onClose]);

  // Escape cierra; Tab queda dentro del diálogo; al cerrar, el foco vuelve.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
      if (e.key === 'Tab' && cardRef.current) {
        const focusables = cardRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [handleClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (token.length !== OTP_LENGTH) {
      setError(t('auth.2fa.length'));
      return;
    }

    setLoading(true);
    try {
      const res = await apiFetch('/api/auth/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: token }),
      });
      const data = await res.json();

      if (data.success) {
        setToken('');
        setError('');
        onVerified();
      } else {
        setError(data.error || t('auth.2fa.wrong'));
        setToken('');
      }
    } catch {
      setError(t('auth.error.connection'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim px-4">
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm rounded-ui-xl border border-border bg-card p-5 text-foreground shadow-3 vex-pop-in"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <AuthIcon tone="info"><ShieldCheck aria-hidden className="size-5" /></AuthIcon>
            <div>
              <h2 id={titleId} className="text-[15px] font-semibold tracking-[-0.005em]">{t('auth.verify.title')}</h2>
              <p className="text-[12.5px] text-text-2">{t('auth.verify.subtitle')}</p>
            </div>
          </div>
          <button type="button" onClick={handleClose} aria-label={t('auth.verify.close')} className={ICON_BUTTON_CLASS}>
            <X aria-hidden className="size-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label={t('auth.2fa.code')} hint={t('auth.verify.hint')}>
            <OtpInput value={token} onChange={setToken} required autoFocus aria-invalid={error ? true : undefined} />
          </Field>

          {error && <Notice kind="bad" title={error} />}

          <AuthSubmit loading={loading} loadingLabel={t('auth.2fa.verifying')} disabled={token.length !== OTP_LENGTH}>
            {t('auth.verify.submit')}
          </AuthSubmit>
        </form>
      </div>
    </div>
  );
}

/**
 * Hook that wraps any export/download function with 2FA verification.
 * If the user has 2FA enabled, shows a modal first. Otherwise, runs directly.
 *
 * Usage:
 *   const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
 *
 *   const handleExport = () => {
 *     verify2FA(() => { downloadCSV(...) });
 *   };
 *
 *   return <>{Modal2FA}<button onClick={handleExport}>Export</button></>
 */
export function useExport2FA(twofa_enabled: boolean | undefined) {
  const [show, setShow] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const verify2FA = useCallback((action: () => void) => {
    if (twofa_enabled) {
      setPendingAction(() => action);
      setShow(true);
    } else {
      // No 2FA configured — run immediately
      action();
    }
  }, [twofa_enabled]);

  const handleVerified = useCallback(() => {
    setShow(false);
    if (pendingAction) {
      pendingAction();
      setPendingAction(null);
    }
  }, [pendingAction]);

  const handleClose = useCallback(() => {
    setShow(false);
    setPendingAction(null);
  }, []);

  const Modal2FA = (
    <Verify2FAModal
      open={show}
      onVerified={handleVerified}
      onClose={handleClose}
    />
  );

  return { verify2FA, Modal2FA };
}
