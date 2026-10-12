'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { OTP_LENGTH } from '@/lib/auth-form';
import { Field } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { AuthIcon, AuthShell } from '@/components/auth/auth-shell';
import {
  AUTH_LINK_CLASS,
  AUTH_PRIMARY_CLASS,
  AuthInput,
  AuthSubmit,
  OtpInput,
  PasswordInput,
} from '@/components/auth/auth-controls';

// ─────────────────────────────────────────────────────────────────────────────
// /reset-2fa — email + contraseña → código por email → 2FA desactivado.
//
// Rediseño «Libro mayor» (2026-10-12): sólo presentación y textos por i18n
// (antes estaba entero en inglés fijo). La lógica es la de antes: el paso del
// código se muestra exista o no la cuenta (no filtra qué emails existen) y
// los errores del servidor se muestran tal cual. Antes los errores no tenían
// `role="alert"`; ahora el `Notice` lo pone.
// ─────────────────────────────────────────────────────────────────────────────

export default function Reset2FAPage() {
  const { t } = useI18n();
  const router = useRouter();

  const [step, setStep] = useState<'credentials' | 'code' | 'success'>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch('/api/auth/request-2fa-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || t('auth.error.generic'));
      // Regardless of whether the account exists, proceed to the code step.
      setStep('code');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.error.generic'));
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (code.length !== OTP_LENGTH) {
      setError(t('auth.2fa.length'));
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch('/api/auth/confirm-2fa-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || t('auth.2fa.invalid'));
      setStep('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.2fa.invalid'));
      setCode('');
    } finally {
      setLoading(false);
    }
  };

  if (step === 'success') {
    return (
      <AuthShell
        icon={<AuthIcon tone="pos"><ShieldCheck aria-hidden className="size-5" /></AuthIcon>}
        title={t('auth.reset2fa.doneTitle')}
        subtitle={t('auth.reset2fa.doneBody')}
      >
        <button type="button" onClick={() => router.push('/login')} className={AUTH_PRIMARY_CLASS}>
          {t('auth.goToLogin')}
        </button>
      </AuthShell>
    );
  }

  if (step === 'code') {
    return (
      <AuthShell
        title={t('auth.reset2fa.codeTitle')}
        subtitle={t('auth.reset2fa.codeBody', { email })}
        footer={
          <button
            type="button"
            onClick={() => { setStep('credentials'); setCode(''); setError(null); }}
            className={AUTH_LINK_CLASS}
          >
            <ArrowLeft aria-hidden className="size-4" />
            {t('auth.back')}
          </button>
        }
      >
        <form onSubmit={handleConfirm} className="space-y-4">
          <Field label={t('auth.2fa.code')} id="code">
            <OtpInput value={code} onChange={setCode} required autoFocus aria-invalid={error ? true : undefined} />
          </Field>
          {error && <Notice kind="bad" title={error} />}
          <AuthSubmit loading={loading} loadingLabel={t('auth.2fa.verifying')} disabled={code.length !== OTP_LENGTH}>
            {t('auth.reset2fa.confirm')}
          </AuthSubmit>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t('auth.reset2fa.title')}
      subtitle={t('auth.reset2fa.subtitle')}
      footer={
        <button type="button" onClick={() => router.push('/login')} className={AUTH_LINK_CLASS}>
          <ArrowLeft aria-hidden className="size-4" />
          {t('auth.backToLogin')}
        </button>
      }
    >
      <form onSubmit={handleRequest} className="space-y-4">
        <Field label={t('auth.email')} id="email">
          <AuthInput
            type="email"
            name="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder={t('auth.emailPlaceholder')}
            required
            autoFocus
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="email"
          />
        </Field>
        <Field label={t('auth.password')} id="password">
          <PasswordInput
            name="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </Field>
        {error && <Notice kind="bad" title={error} />}
        <AuthSubmit loading={loading} loadingLabel={t('auth.recovery.sending')}>
          {t('auth.reset2fa.send')}
        </AuthSubmit>
      </form>
    </AuthShell>
  );
}
