'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { useAuth, type LoginResult } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import { ArrowLeft } from 'lucide-react';

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
    fetch('/api/auth/login-notification', {
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
          router.push('/');
        }
      } else {
        setError(t('login.error'));
      }
    } catch {
      setError(t('login.error'));
    } finally {
      setLoading(false);
    }
  };

  const handle2faSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!pendingUserId) return;

    const success = loginWith2fa(pendingUserId, pin);
    if (success) {
      const loggedUser = users.find(u => u.id === pendingUserId);
      if (loggedUser) notifyLogin(loggedUser.name, loggedUser.email);
      router.push('/');
    } else {
      setError(t('login.pinError'));
      setPin('');
    }
  };

  const handleBackToCredentials = () => {
    setStep('credentials');
    setPendingUserId(null);
    setPin('');
    setError('');
  };

  if (showRecovery) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <Image
              src="/vex-logofull.png"
              alt="VexPro FX"
              width={220}
              height={60}
              className="mx-auto mb-4 block dark:hidden"
              priority
            />
            <Image
              src="/vex-logofull-white.png"
              alt="VexPro FX"
              width={220}
              height={60}
              className="mx-auto mb-4 hidden dark:block"
              priority
            />
            <h2 className="text-xl font-bold mt-2">Smart Dashboard</h2>
          </div>

          <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
            <h2 className="text-lg font-semibold mb-4">{t('login.recoveryTitle')}</h2>
            <div className="space-y-4">
              <div className="px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-400 text-sm">
                {t('login.recoveryMsg')}
              </div>
              <p className="text-sm text-muted-foreground">
                {t('login.contactInfo')}
              </p>
              <button
                onClick={() => setShowRecovery(false)}
                className="flex items-center gap-2 text-sm text-[var(--color-primary)] hover:underline"
              >
                <ArrowLeft className="w-4 h-4" />
                {t('login.back')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <Image
            src="/vex-logofull.png"
            alt="VexPro FX"
            width={220}
            height={60}
            className="mx-auto mb-4 block dark:hidden"
            priority
          />
          <Image
            src="/vex-logofull-white.png"
            alt="VexPro FX"
            width={220}
            height={60}
            className="mx-auto mb-4 hidden dark:block"
            priority
          />
          <h2 className="text-xl font-bold mt-2">Smart Dashboard</h2>
        </div>

        {/* Form */}
        <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
          {step === 'credentials' ? (
            <>
              <h2 className="text-lg font-semibold mb-6">{t('login.title')}</h2>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="email" className="block text-sm font-medium mb-1.5">
                    {t('login.email')}
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="correo@empresa.com"
                    required
                    className="w-full px-3 py-2.5 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                  />
                </div>

                <div>
                  <label htmlFor="password" className="block text-sm font-medium mb-1.5">
                    {t('login.password')}
                  </label>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="********"
                    required
                    className="w-full px-3 py-2.5 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                  />
                </div>

                {error && (
                  <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm" role="alert" aria-live="assertive">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 rounded-lg bg-[var(--color-primary)] text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {loading ? t('login.loading') : t('login.submit')}
                </button>
              </form>

              <div className="mt-4 text-center">
                <button
                  onClick={() => setShowRecovery(true)}
                  className="text-sm text-[var(--color-secondary)] hover:underline font-medium"
                >
                  {t('login.recovery')}
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold mb-2">{t('login.2faTitle')}</h2>
              <p className="text-sm text-muted-foreground mb-6">
                {t('login.2faSubtitle')}
              </p>

              <form onSubmit={handle2faSubmit} className="space-y-4">
                <div>
                  <label htmlFor="pin" className="block text-sm font-medium mb-1.5">
                    {t('login.pinLabel')}
                  </label>
                  <input
                    id="pin"
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    required
                    autoFocus
                    className="w-full px-3 py-2.5 rounded-lg border border-border bg-background text-sm text-center tracking-[0.5em] font-mono text-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                  />
                </div>

                {error && (
                  <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm" role="alert" aria-live="assertive">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={pin.length !== 6}
                  className="w-full py-2.5 rounded-lg bg-[var(--color-primary)] text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {t('login.submit')}
                </button>
              </form>

              <div className="mt-4 text-center">
                <button
                  onClick={handleBackToCredentials}
                  className="flex items-center gap-2 mx-auto text-sm text-[var(--color-primary)] hover:underline"
                >
                  <ArrowLeft className="w-4 h-4" />
                  {t('login.back')}
                </button>
              </div>
            </>
          )}
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Smart Dashboard v1.0 — Horizon Consulting
        </p>
      </div>
    </div>
  );
}
