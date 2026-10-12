'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useRouter } from 'next/navigation';
import { useAuth, type LoginResult } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import { clearActiveCompanyId } from '@/lib/active-company';
import { loginFailureMessage, OTP_LENGTH } from '@/lib/auth-form';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { Field } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { AuthIcon, AuthShell } from '@/components/auth/auth-shell';
import {
  AUTH_LINK_CLASS,
  AUTH_QUIET_LINK_CLASS,
  AuthInput,
  AuthSubmit,
  OtpInput,
  PasswordInput,
} from '@/components/auth/auth-controls';

// ─────────────────────────────────────────────────────────────────────────────
// /login — credenciales → (2FA) → dashboard, y la recuperación de contraseña.
//
// Rediseño «Libro mayor» (2026-10-12): SÓLO cambia la presentación. La lógica
// es la de antes, línea por línea: `login()` de auth-context (que pasa por
// /api/auth/login-gate: rate limit, bloqueo, intentos restantes), paso de 2FA
// con `loginWith2fa`, aviso de login fire-and-forget, `clearActiveCompanyId()`
// y `router.push('/')`. Los textos de error del servidor se muestran tal cual;
// los nuestros pasan por i18n (antes la mitad estaba en inglés fijo).
// El armado del mensaje de error salió a `loginFailureMessage` (auth-form.ts)
// para poder testearlo.
// ─────────────────────────────────────────────────────────────────────────────

export default function LoginPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);

  // 2FA state
  const [step, setStep] = useState<'credentials' | '2fa'>('credentials');
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [pin, setPin] = useState('');

  const { login, loginWith2fa, users } = useAuth();
  const router = useRouter();

  // Fire-and-forget: send login notification email (never blocks navigation)
  const notifyLogin = (name: string, userEmail: string) => {
    apiFetch('/api/auth/login-notification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: name, userEmail }),
    }).catch(err => console.error('Login notification failed:', err));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result: LoginResult = await login(email, password);
      if (result.success) {
        if (result.needs2fa) {
          setPendingUserId(result.userId);
          setStep('2fa');
          setPin('');
        } else {
          const loggedUser = users.find(u => u.email.toLowerCase() === email.toLowerCase());
          notifyLogin(loggedUser?.name ?? email.split('@')[0], email);
          // Fresh login — clear any stale "viewing as" pointer left over from
          // a previous superadmin session on this browser. The dashboard
          // layout will redirect superadmins to /superadmin automatically.
          clearActiveCompanyId();
          router.push('/');
        }
      } else {
        setError(loginFailureMessage(result, t));
      }
    } catch {
      setError(t('auth.login.unexpected'));
    } finally {
      setLoading(false);
    }
  };

  const handle2faSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!pendingUserId) return;
    setLoading(true);

    try {
      const result = await loginWith2fa(email, password, pin);
      if (result.success) {
        const loggedUser = users.find(u => u.id === pendingUserId);
        notifyLogin(loggedUser?.name ?? email.split('@')[0], email);
        clearActiveCompanyId();
        router.push('/');
      } else {
        setError(result.error || t('auth.2fa.invalid'));
        setPin('');
      }
    } catch {
      setError(t('auth.2fa.invalid'));
      setPin('');
    } finally {
      setLoading(false);
    }
  };

  const handleBackToCredentials = () => {
    setStep('credentials');
    setPendingUserId(null);
    setPin('');
    setError('');
  };

  if (showRecovery) {
    return <RecoveryScreen onBack={() => setShowRecovery(false)} initialEmail={email} />;
  }

  if (step === '2fa') {
    return (
      <AuthShell
        icon={<AuthIcon tone="info"><ShieldCheck aria-hidden className="size-5" /></AuthIcon>}
        title={t('auth.2fa.title')}
        subtitle={t('auth.2fa.subtitle')}
        footer={
          <div className="flex flex-col items-start">
            <button type="button" onClick={handleBackToCredentials} className={AUTH_LINK_CLASS}>
              <ArrowLeft aria-hidden className="size-4" />
              {t('auth.backToLogin')}
            </button>
            <button type="button" onClick={() => router.push('/reset-2fa')} className={AUTH_QUIET_LINK_CLASS}>
              {t('auth.2fa.cantAccess')}
            </button>
          </div>
        }
      >
        <form onSubmit={handle2faSubmit} className="space-y-4">
          <Field label={t('auth.2fa.code')} hint={t('auth.2fa.codeHint')} id="pin">
            <OtpInput value={pin} onChange={setPin} required autoFocus aria-invalid={error ? true : undefined} />
          </Field>
          {error && <Notice kind="bad" title={error} />}
          <AuthSubmit loading={loading} loadingLabel={t('auth.2fa.verifying')} disabled={pin.length !== OTP_LENGTH}>
            {t('auth.2fa.verify')}
          </AuthSubmit>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t('auth.login.title')} subtitle={t('auth.login.subtitle')}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label={t('auth.email')} id="email">
          <AuthInput
            type="email"
            name="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('auth.emailPlaceholder')}
            required
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="email"
          />
        </Field>

        <div className="space-y-1">
          <Field label={t('auth.password')} id="password">
            <PasswordInput
              name="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </Field>
          <div className="flex justify-end">
            <button type="button" onClick={() => setShowRecovery(true)} className={AUTH_LINK_CLASS}>
              {t('auth.login.forgot')}
            </button>
          </div>
        </div>

        {error && <Notice kind="bad" title={error} />}

        <AuthSubmit loading={loading} loadingLabel={t('auth.login.submitting')}>
          {t('auth.login.submit')}
        </AuthSubmit>
      </form>
    </AuthShell>
  );
}

// ─── Recovery screen (forgot password) ───
function RecoveryScreen({ onBack, initialEmail }: { onBack: () => void; initialEmail: string }) {
  const { t } = useI18n();
  const [email, setEmail] = useState(initialEmail);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('auth.error.generic'));
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.error.generic'));
    } finally {
      setLoading(false);
    }
  };

  const back = (
    <button type="button" onClick={onBack} className={AUTH_LINK_CLASS}>
      <ArrowLeft aria-hidden className="size-4" />
      {t('auth.backToLogin')}
    </button>
  );

  if (sent) {
    return (
      <AuthShell title={t('auth.recovery.sentTitle')} footer={back}>
        <div className="space-y-3">
          <Notice kind="info" title={t('auth.recovery.sent', { email })} />
          <p className="text-[13px] leading-5 text-text-2">{t('auth.recovery.sentHint')}</p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t('auth.recovery.title')} subtitle={t('auth.recovery.subtitle')} footer={back}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label={t('auth.email')} id="recovery-email">
          <AuthInput
            type="email"
            name="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder={t('auth.emailPlaceholder')}
            required
            autoFocus
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="email"
          />
        </Field>
        {error && <Notice kind="bad" title={error} />}
        <AuthSubmit loading={loading} loadingLabel={t('auth.recovery.sending')} disabled={!email}>
          {t('auth.recovery.send')}
        </AuthSubmit>
      </form>
    </AuthShell>
  );
}
