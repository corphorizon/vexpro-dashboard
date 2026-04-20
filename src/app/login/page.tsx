'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, type LoginResult } from '@/lib/auth-context';
import { AuthBrand } from '@/components/auth-brand';
import { clearActiveCompanyId } from '@/lib/active-company';
import { ArrowLeft, Eye, EyeOff, Loader2 } from 'lucide-react';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
          // Fresh login — clear any stale "viewing as" pointer left over from
          // a previous superadmin session on this browser. The dashboard
          // layout will redirect superadmins to /superadmin automatically.
          clearActiveCompanyId();
          router.push('/');
        }
      } else if (result.locked) {
        setError(result.error ?? 'Your account is locked. Reset your password to unlock it.');
      } else if (typeof result.attemptsLeft === 'number' && result.attemptsLeft > 0) {
        setError(`Invalid credentials. ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? '' : 's'} left.`);
      } else {
        setError(result.error ?? 'Invalid email or password.');
      }
    } catch {
      setError('Something went wrong. Please try again.');
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
        setError(result.error || 'Invalid code.');
        setPin('');
      }
    } catch {
      setError('Invalid code.');
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        {/* Neutral platform brand — actual tenant colors/logo come after login. */}
        <AuthBrand />

        {/* Form */}
        <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
          {step === 'credentials' ? (
            <>
              <h2 className="text-lg font-semibold mb-6">Sign in to your account</h2>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="email" className="block text-sm font-medium mb-1.5">
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    required
                    autoComplete="email"
                    className="w-full px-3 py-2.5 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                  />
                </div>

                <div>
                  <label htmlFor="password" className="block text-sm font-medium mb-1.5">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      autoComplete="current-password"
                      className="w-full pr-11 px-3 py-2.5 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(v => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showPassword}
                      className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)] rounded-r-lg"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
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
                  {loading ? 'Signing in…' : 'Sign in'}
                </button>
              </form>

              <div className="mt-4 text-center">
                <button
                  onClick={() => setShowRecovery(true)}
                  className="inline-flex items-center gap-1 text-sm font-semibold text-[var(--color-primary)] hover:underline"
                >
                  ¿Olvidaste tu contraseña?
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold mb-2">Two-factor authentication</h2>
              <p className="text-sm text-muted-foreground mb-6">
                Enter the 6-digit code from your authenticator app.
              </p>

              <form onSubmit={handle2faSubmit} className="space-y-4">
                <div>
                  <label htmlFor="pin" className="block text-sm font-medium mb-1.5">
                    Verification code
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
                    autoComplete="one-time-code"
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
                  disabled={pin.length !== 6 || loading}
                  className="w-full py-2.5 rounded-lg bg-[var(--color-primary)] text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {loading ? 'Verifying…' : 'Verify'}
                </button>
              </form>

              <div className="mt-4 text-center space-y-2">
                <button
                  onClick={handleBackToCredentials}
                  className="flex items-center gap-2 mx-auto text-sm text-[var(--color-primary)] hover:underline"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back to sign in
                </button>
                <button
                  onClick={() => router.push('/reset-2fa')}
                  className="block mx-auto text-xs text-muted-foreground hover:text-foreground"
                >
                  Can&apos;t access your authenticator? Reset 2FA
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Recovery screen (forgot password) ───
function RecoveryScreen({ onBack, initialEmail }: { onBack: () => void; initialEmail: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <AuthBrand />

        <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
          <h2 className="text-lg font-semibold mb-4">Account recovery</h2>
          {sent ? (
            <div className="space-y-4">
              <div className="px-4 py-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-400 text-sm">
                If an account exists for <span className="font-medium">{email}</span>, you will receive a password reset link within a few minutes.
              </div>
              <p className="text-sm text-muted-foreground">
                The link will expire in 1 hour. If you don&apos;t receive it, check spam or contact your administrator.
              </p>
              <button onClick={onBack} className="flex items-center gap-2 text-sm text-[var(--color-primary)] hover:underline">
                <ArrowLeft className="w-4 h-4" />
                Back to sign in
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Enter the email associated with your account. We&apos;ll email you a link to reset your password.
              </p>
              <div>
                <label htmlFor="recovery-email" className="block text-sm font-medium mb-1.5">Email</label>
                <input
                  id="recovery-email"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  required
                  autoFocus
                  autoComplete="email"
                  className="w-full px-3 py-2.5 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                />
              </div>
              {error && (
                <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm" role="alert">
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={loading || !email}
                className="w-full py-2.5 rounded-lg bg-[var(--color-primary)] text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading ? <><Loader2 className="w-4 h-4 animate-spin" />Sending…</> : 'Send reset link'}
              </button>
              <button type="button" onClick={onBack} className="w-full flex items-center gap-2 justify-center text-sm text-muted-foreground hover:text-foreground">
                <ArrowLeft className="w-4 h-4" />
                Back to sign in
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
