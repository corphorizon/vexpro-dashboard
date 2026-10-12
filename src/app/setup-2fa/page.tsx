'use client';

import { useState, useEffect } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import { OTP_LENGTH } from '@/lib/auth-form';
import { ArrowLeft, ArrowRight, Check, Copy, Loader2, ShieldCheck } from 'lucide-react';
import { Field } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { Panel } from '@/components/ui/panel';
import { AuthIcon, AuthShell } from '@/components/auth/auth-shell';
import {
  AUTH_LINK_CLASS,
  AUTH_PRIMARY_CLASS,
  AUTH_QUIET_LINK_CLASS,
  AUTH_SECONDARY_CLASS,
  AuthSubmit,
  OtpInput,
} from '@/components/auth/auth-controls';

// ─────────────────────────────────────────────────────────────────────────────
// /setup-2fa — alta de TOTP: generar secreto + QR → verificar el primer código.
//
// Rediseño «Libro mayor» (2026-10-12): sólo presentación. El QR va dentro de
// un `Panel` («Paso 1 de 2»), la clave manual en mono 12 px con botón copiar
// que anuncia «Copiada» (antes sólo cambiaba el ícono, sin texto). El QR que
// genera /api/auth/setup-2fa ya trae fondo blanco y margen de 2 módulos, así
// que en oscuro se escanea igual sin pintar un `bg-white` a mano.
// La lógica es la de antes: redirige a /login sin usuario y a / si ya tiene
// 2FA; el secreto pendiente lo lee el servidor (no se manda desde el cliente);
// «Omitir» sólo si no es obligatorio (`force_2fa_setup`).
// ─────────────────────────────────────────────────────────────────────────────

export default function Setup2FAPage() {
  const { t } = useI18n();
  const { user, refreshUser } = useAuth();
  const router = useRouter();

  const [step, setStep] = useState<'loading' | 'scan' | 'verify' | 'success'>('loading');
  const [secret, setSecret] = useState('');
  const [qrCode, setQrCode] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const generateSecret = async () => {
    try {
      const res = await apiFetch('/api/auth/setup-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate' }),
      });
      const data = await res.json();
      if (data.success) {
        setSecret(data.secret);
        setQrCode(data.qrCode);
        setStep('scan');
      } else {
        setError(data.error || t('auth.setup.qrError'));
      }
    } catch {
      setError(t('auth.error.connection'));
    }
  };

  useEffect(() => {
    if (!user) {
      router.replace('/login');
      return;
    }
    if (user.twofa_enabled) {
      router.replace('/');
      return;
    }
    // Generate TOTP secret and QR code
    generateSecret();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mismo disparo que antes: sólo al cambiar el usuario
  }, [user, router]);

  const handleCopySecret = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sin permiso de portapapeles: la clave sigue seleccionable (select-all).
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (token.length !== OTP_LENGTH) {
      setError(t('auth.2fa.length'));
      return;
    }

    setLoading(true);
    try {
      const res = await apiFetch('/api/auth/setup-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Server reads the pending secret from the DB; do NOT send it from the client.
        body: JSON.stringify({ action: 'verify', token }),
      });
      const data = await res.json();

      if (data.success) {
        // Refresh user state to reflect twofa_enabled
        if (refreshUser) await refreshUser();
        setStep('success');
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

  const handleSkip = () => {
    router.push('/');
  };

  const handleContinue = () => {
    router.push('/');
  };

  if (!user) {
    return (
      <AuthShell title={t('auth.setup.redirecting')}>
        <Loader2 aria-hidden className="size-6 animate-spin text-text-3 motion-reduce:animate-none" />
      </AuthShell>
    );
  }

  // Success screen
  if (step === 'success') {
    return (
      <AuthShell
        icon={<AuthIcon tone="pos"><ShieldCheck aria-hidden className="size-5" /></AuthIcon>}
        title={t('auth.setup.doneTitle')}
        subtitle={t('auth.setup.doneBody')}
      >
        <div className="space-y-3">
          <Notice kind="info" title={t('auth.setup.doneInfo')} />
          <Notice kind="pend" title={t('auth.setup.doneWarnTitle')}>
            {t('auth.setup.doneWarn')}
          </Notice>
          <button type="button" onClick={handleContinue} className={AUTH_PRIMARY_CLASS}>
            {t('auth.setup.continue')}
            <ArrowRight aria-hidden className="size-4" />
          </button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      width="wide"
      icon={<AuthIcon tone="info"><ShieldCheck aria-hidden className="size-5" /></AuthIcon>}
      title={t('auth.setup.title')}
      subtitle={t('auth.setup.subtitle')}
      footer={<p className="text-[12.5px] text-text-3">{t('auth.setup.footer')}</p>}
    >
      {step === 'loading' && (
        error ? (
          <Notice kind="bad" title={error} />
        ) : (
          <p role="status" className="flex items-center gap-2 text-[13px] text-text-2">
            <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
            {t('auth.setup.loading')}
          </p>
        )
      )}

      {step === 'scan' && (
        <div className="space-y-4">
          <Panel title={t('auth.setup.step1')} titleAs="h2">
            <p className="text-[13px] leading-5 text-text-2">{t('auth.setup.step1Body')}</p>
            {qrCode && (
              <div className="mt-4 flex justify-center">
                {/* data: URL generado por el servidor; next/image no aporta nada acá. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qrCode}
                  alt={t('auth.setup.qrAlt')}
                  width={200}
                  height={200}
                  className="block size-[200px] rounded-ui-md border border-border"
                />
              </div>
            )}
            <div className="mt-4 border-t border-border pt-4">
              <p className="text-[12.5px] text-text-2">{t('auth.setup.manual')}</p>
              <div className="mt-2 flex items-stretch gap-2">
                <code
                  className="flex min-h-10 min-w-0 flex-1 select-all items-center break-all rounded-ui-md border border-border bg-surface-2 px-3 font-mono text-[12px] tracking-wider text-foreground"
                >
                  {secret}
                </code>
                <button
                  type="button"
                  onClick={handleCopySecret}
                  className={AUTH_SECONDARY_CLASS}
                  aria-live="polite"
                >
                  {copied ? (
                    <>
                      <Check aria-hidden className="size-4 text-pos" />
                      {t('auth.setup.copied')}
                    </>
                  ) : (
                    <>
                      <Copy aria-hidden className="size-4" />
                      {t('auth.setup.copy')}
                    </>
                  )}
                </button>
              </div>
            </div>
          </Panel>

          <button
            type="button"
            onClick={() => { setStep('verify'); setToken(''); setError(''); }}
            className={AUTH_PRIMARY_CLASS}
          >
            {t('auth.setup.scanned')}
          </button>

          {!user?.force_2fa_setup && (
            <div className="text-center">
              <button type="button" onClick={handleSkip} className={AUTH_QUIET_LINK_CLASS}>
                {t('auth.setup.skip')}
              </button>
            </div>
          )}
        </div>
      )}

      {step === 'verify' && (
        <div className="space-y-4">
          <Panel title={t('auth.setup.step2')} titleAs="h2">
            <form onSubmit={handleVerify} className="space-y-4">
              <Field label={t('auth.2fa.code')} hint={t('auth.2fa.codeHint')} id="totp-code">
                <OtpInput value={token} onChange={setToken} required autoFocus aria-invalid={error ? true : undefined} />
              </Field>
              {error && <Notice kind="bad" title={error} />}
              <AuthSubmit loading={loading} loadingLabel={t('auth.2fa.verifying')} disabled={token.length !== OTP_LENGTH}>
                {t('auth.setup.verify')}
              </AuthSubmit>
            </form>
          </Panel>
          <button
            type="button"
            onClick={() => { setStep('scan'); setError(''); }}
            className={AUTH_LINK_CLASS}
          >
            <ArrowLeft aria-hidden className="size-4" />
            {t('auth.setup.backToQr')}
          </button>
        </div>
      )}
    </AuthShell>
  );
}
