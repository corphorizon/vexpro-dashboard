'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { DEMO_COMPANY } from '@/lib/demo-data';
import { useI18n } from '@/lib/i18n';
import { Building2, ShieldCheck, ArrowRight } from 'lucide-react';

export default function Setup2FAPage() {
  const { t } = useI18n();
  const { user, updateUser } = useAuth();
  const router = useRouter();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!user) {
      router.replace('/login');
    }
  }, [user, router]);

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground">{t('setup2fa.redirecting')}</div>
      </div>
    );
  }

  // If 2FA is already enabled, redirect to dashboard
  if (user.twofa_enabled && !success) {
    router.replace('/');
    return null;
  }

  const handleVerify = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (pin.length !== 6) {
      setError(t('profile.pinMustBe6'));
      return;
    }

    // For demo: accept any 6-digit code during setup, but store the generated secret as the PIN
    // In a real app, we'd verify a TOTP code here
    updateUser(user.id, {
      twofa_enabled: true,
      twofa_secret: pin,
    });
    setSuccess(true);
  };

  const handleSkip = () => {
    router.push('/');
  };

  const handleContinue = () => {
    router.push('/');
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-500 mb-4">
              <ShieldCheck className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-2xl font-bold">{t('profile.twofaEnabled')}</h1>
            <p className="text-muted-foreground text-sm mt-1">{t('setup2fa.accountProtected')}</p>
          </div>

          <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
            <div className="space-y-4">
              <div className="px-4 py-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-400 text-sm">
                {t('setup2fa.successMsg')}
              </div>

              <div className="px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-400 text-sm">
                {t('setup2fa.importantMsg')}
              </div>

              <button
                onClick={handleContinue}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-[var(--color-primary)] text-white font-medium text-sm hover:opacity-90 transition-opacity"
              >
                {t('setup2fa.continueToDashboard')}
                <ArrowRight className="w-4 h-4" />
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
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[var(--color-primary)] mb-4">
            <Building2 className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold">{DEMO_COMPANY.name}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('setup2fa.securitySetup')}</p>
        </div>

        <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950/50">
              <ShieldCheck className="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">{t('profile.twofaSetup')}</h2>
              <p className="text-xs text-muted-foreground">{t('setup2fa.twofaLabel')}</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="px-4 py-3 rounded-lg bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-400 text-sm">
              {t('setup2fa.instructionMsg')}
            </div>

            <form onSubmit={handleVerify} className="space-y-4">
              <div>
                <label htmlFor="setup-pin" className="block text-sm font-medium mb-1.5">
                  {t('setup2fa.enterPin')}
                </label>
                <input
                  id="setup-pin"
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
                <p className="text-xs text-muted-foreground mt-1">
                  {t('setup2fa.chooseYourPin')}
                </p>
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
                {t('setup2fa.activate')}
              </button>
            </form>

            <div className="text-center">
              <button
                onClick={handleSkip}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {t('setup2fa.skipForNow')}
              </button>
            </div>
          </div>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          {t('setup2fa.canChangeAnytime')}
        </p>
      </div>
    </div>
  );
}
