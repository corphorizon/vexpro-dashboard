'use client';

import { useState, Suspense, useEffect } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Loader2, ShieldCheck } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useI18n } from '@/lib/i18n';
import { PASSWORD_MIN_LENGTH, passwordError, passwordRequirements } from '@/lib/auth-form';
import { Field } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { AuthIcon, AuthShell } from '@/components/auth/auth-shell';
import {
  AUTH_LINK_CLASS,
  AUTH_PRIMARY_CLASS,
  AuthSubmit,
  PasswordInput,
  PasswordRequirements,
} from '@/components/auth/auth-controls';

// ─────────────────────────────────────────────────────────────────────────────
// /reset-password — handles TWO flows with the same UI:
//
//  1. Custom "forgot password" flow (our own):
//       Link looks like /reset-password?token=<random-uuid>
//       Backend validates via /api/auth/reset-password-confirm.
//
//  2. Supabase invite / magic-link flow:
//       Supabase appends access_token + refresh_token in the URL HASH:
//       /reset-password#access_token=...&refresh_token=...&type=invite
//       We establish the session client-side and call supabase.auth.updateUser
//       to set the password, then drop the user into /.
//
// The page picks the flow automatically: if the hash contains access_token we
// run the invite path; otherwise we look for ?token= and run the custom one.
//
// Rediseño «Libro mayor» (2026-10-12): sólo presentación. Los requisitos se
// muestran como lista con check (`pos` cumplido / `text-3` pendiente) y salen
// de auth-form.ts — el mismo `PASSWORD_MIN_LENGTH` que valida el servidor.
// La validación al enviar es la de antes (largo → coincidencia, en ese orden).
// ─────────────────────────────────────────────────────────────────────────────

const supabase = createClient();

type Mode = 'custom-reset' | 'supabase-invite' | 'invalid' | 'pending';

function PendingScreen() {
  const { t } = useI18n();
  return (
    <AuthShell title={t('auth.reset.checking')}>
      <Loader2 aria-hidden className="size-6 animate-spin text-text-3 motion-reduce:animate-none" />
    </AuthShell>
  );
}

function ResetPasswordInner() {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const customToken = searchParams.get('token') || '';
  // mode=setup viene del flujo de invitación de superadmin: el usuario
  // nunca tuvo contraseña, está creando la primera. Cambiamos el copy para
  // que se sienta "bienvenido" en vez de "olvidé mi contraseña".
  const setupMode = searchParams.get('mode') === 'setup';

  const [mode, setMode] = useState<Mode>('pending');
  const [inviteType, setInviteType] = useState<string>('invite'); // "invite" | "recovery" | "signup"
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // ── Detect which flow to use ────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const hash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash;
    const hashParams = new URLSearchParams(hash);
    const accessToken = hashParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token');
    const type = hashParams.get('type');
    const hashError = hashParams.get('error') || hashParams.get('error_description');

    if (hashError) {
      setError(decodeURIComponent(hashError.replace(/\+/g, ' ')));
      setMode('invalid');
      return;
    }

    if (accessToken && refreshToken) {
      setInviteType(type ?? 'invite');
      // Establish the Supabase session from the URL fragment so
      // auth.updateUser below runs authenticated as the target user.
      supabase.auth
        .setSession({ access_token: accessToken, refresh_token: refreshToken })
        .then(({ error }) => {
          if (error) {
            setError(error.message);
            setMode('invalid');
          } else {
            setMode('supabase-invite');
            // Clean the URL so refreshes don't re-trigger the hash handshake.
            window.history.replaceState(null, '', window.location.pathname);
          }
        });
      return;
    }

    if (customToken) {
      setMode('custom-reset');
      return;
    }

    setMode('invalid');
  }, [customToken]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const invalid = passwordError(password, confirm);
    if (invalid === 'tooShort') {
      setError(t('auth.reset.tooShort', { min: String(PASSWORD_MIN_LENGTH) }));
      return;
    }
    if (invalid === 'mismatch') {
      setError(t('auth.reset.mismatch'));
      return;
    }
    setLoading(true);
    try {
      if (mode === 'supabase-invite') {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw new Error(error.message);
        setSuccess(true);
      } else if (mode === 'custom-reset') {
        const res = await apiFetch('/api/auth/reset-password-confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: customToken, newPassword: password }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || t('auth.reset.updateFailed'));
        }
        // Sign the user out on the custom flow so they log in fresh with the
        // new password. In the invite flow the session is valid — we let the
        // user go straight in.
        setSuccess(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.error.generic'));
    } finally {
      setLoading(false);
    }
  };

  const backToLogin = (
    <button type="button" onClick={() => router.push('/login')} className={AUTH_LINK_CLASS}>
      <ArrowLeft aria-hidden className="size-4" />
      {t('auth.backToLogin')}
    </button>
  );

  // ── Loading while resolving which flow to use ────────────────────────
  if (mode === 'pending') return <PendingScreen />;

  // ── Invalid / expired ────────────────────────────────────────────────
  if (mode === 'invalid') {
    return (
      <AuthShell title={t('auth.reset.invalidTitle')} footer={backToLogin}>
        <Notice kind="bad" title={error ?? t('auth.reset.invalidBody')} />
      </AuthShell>
    );
  }

  // ── Success ──────────────────────────────────────────────────────────
  if (success) {
    const canGoHome = mode === 'supabase-invite';
    return (
      <AuthShell
        icon={<AuthIcon tone="pos"><ShieldCheck aria-hidden className="size-5" /></AuthIcon>}
        title={canGoHome ? t('auth.reset.activatedTitle') : t('auth.reset.updatedTitle')}
        subtitle={canGoHome ? t('auth.reset.activatedBody') : t('auth.reset.updatedBody')}
      >
        <button type="button" onClick={() => router.push(canGoHome ? '/' : '/login')} className={AUTH_PRIMARY_CLASS}>
          {canGoHome ? t('auth.reset.goDashboard') : t('auth.goToLogin')}
        </button>
      </AuthShell>
    );
  }

  // ── Form ─────────────────────────────────────────────────────────────
  const isInvite = mode === 'supabase-invite';
  // custom-reset con ?mode=setup viene del flujo de invitación nuevo (el
  // superadmin invita y manda email vía SendGrid). Es estructuralmente
  // igual al reset, pero el usuario nunca tuvo password — el copy
  // "Restablece tu contraseña" sería raro. Le damos el mismo trato de
  // bienvenida que tiene el supabase-invite.
  const isCustomSetup = mode === 'custom-reset' && setupMode;

  const title = isInvite
    ? (inviteType === 'recovery' ? t('auth.reset.titleRecovery') : t('auth.reset.titleInvite'))
    : isCustomSetup
      ? t('auth.reset.titleSetup')
      : t('auth.reset.titleReset');
  const subtitle = isInvite
    ? t('auth.reset.subInvite')
    : isCustomSetup
      ? t('auth.reset.subSetup')
      : t('auth.reset.subReset');

  return (
    <AuthShell title={title} subtitle={subtitle} footer={backToLogin}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label={t('auth.reset.newPassword')} id="password">
          <PasswordInput
            name="new-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            visible={show}
            onVisibleChange={setShow}
            minLength={PASSWORD_MIN_LENGTH}
            required
            autoFocus
            autoComplete="new-password"
            aria-describedby="password-reqs"
          />
        </Field>

        <Field label={t('auth.reset.confirm')} id="confirm">
          <PasswordInput
            name="confirm-password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            visible={show}
            onVisibleChange={setShow}
            hideToggle
            minLength={PASSWORD_MIN_LENGTH}
            required
            autoComplete="new-password"
          />
        </Field>

        {/* Sin fondo `surface-2`: `text-3` (pendiente) da 4,28:1 sobre él, no
            pasa AA; sobre la superficie da 4,76. */}
        <div>
          <p className="mb-1 text-[12px] font-medium text-text-2">{t('auth.pw.requirements')}</p>
          <PasswordRequirements id="password-reqs" items={passwordRequirements(password, confirm)} />
        </div>

        {error && <Notice kind="bad" title={error} />}

        <AuthSubmit loading={loading} loadingLabel={t('auth.reset.saving')}>
          {isInvite || isCustomSetup ? t('auth.reset.activate') : t('auth.reset.update')}
        </AuthSubmit>
      </form>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<PendingScreen />}>
      <ResetPasswordInner />
    </Suspense>
  );
}
