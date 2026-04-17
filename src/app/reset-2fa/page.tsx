'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { ArrowLeft, Eye, EyeOff, Loader2, ShieldCheck } from 'lucide-react';

export default function Reset2FAPage() {
  const router = useRouter();

  const [step, setStep] = useState<'credentials' | 'code' | 'success'>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/request-2fa-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Error');
      // Regardless of whether the account exists, proceed to the code step.
      setStep('code');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (code.length !== 6) {
      setError('Enter the 6-digit code');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/confirm-2fa-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Invalid code');
      setStep('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid code');
      setCode('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Image src="/vex-logofull.png" alt="VexPro FX" width={220} height={60} className="mx-auto mb-4 block dark:hidden" priority />
          <Image src="/vex-logofull-white.png" alt="VexPro FX" width={220} height={60} className="mx-auto mb-4 hidden dark:block" priority />
          <h2 className="text-xl font-bold mt-2">Smart Dashboard</h2>
        </div>

        <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
          {step === 'credentials' && (
            <>
              <h2 className="text-lg font-semibold mb-2">Reset two-factor authentication</h2>
              <p className="text-sm text-muted-foreground mb-6">
                Enter your email and password. We will send a 6-digit code to your email to confirm your identity.
              </p>
              <form onSubmit={handleRequest} className="space-y-4">
                <div>
                  <label htmlFor="email" className="block text-sm font-medium mb-1.5">Email</label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    autoFocus
                    autoComplete="email"
                    className="w-full px-3 py-2.5 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                  />
                </div>
                <div>
                  <label htmlFor="password" className="block text-sm font-medium mb-1.5">Password</label>
                  <div className="relative">
                    <input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      required
                      autoComplete="current-password"
                      className="w-full pr-11 px-3 py-2.5 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(v => !v)}
                      className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground rounded-r-lg"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                {error && (
                  <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
                    {error}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 rounded-lg bg-[var(--color-primary)] text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {loading ? <><Loader2 className="w-4 h-4 animate-spin" />Sending…</> : 'Send code'}
                </button>
                <button type="button" onClick={() => router.push('/login')} className="w-full flex items-center gap-2 justify-center text-sm text-muted-foreground hover:text-foreground">
                  <ArrowLeft className="w-4 h-4" />
                  Back to sign in
                </button>
              </form>
            </>
          )}

          {step === 'code' && (
            <>
              <h2 className="text-lg font-semibold mb-2">Enter the verification code</h2>
              <p className="text-sm text-muted-foreground mb-6">
                If an account exists for <span className="font-medium">{email}</span>, a 6-digit code has been emailed. It expires in 15 minutes.
              </p>
              <form onSubmit={handleConfirm} className="space-y-4">
                <div>
                  <label htmlFor="code" className="block text-sm font-medium mb-1.5">Verification code</label>
                  <input
                    id="code"
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    required
                    autoFocus
                    autoComplete="one-time-code"
                    className="w-full px-3 py-2.5 rounded-lg border border-border bg-background text-sm text-center tracking-[0.5em] font-mono text-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                  />
                </div>
                {error && (
                  <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
                    {error}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={code.length !== 6 || loading}
                  className="w-full py-2.5 rounded-lg bg-[var(--color-primary)] text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {loading ? <><Loader2 className="w-4 h-4 animate-spin" />Verifying…</> : 'Verify and reset 2FA'}
                </button>
                <button type="button" onClick={() => { setStep('credentials'); setCode(''); setError(null); }} className="w-full flex items-center gap-2 justify-center text-sm text-muted-foreground hover:text-foreground">
                  <ArrowLeft className="w-4 h-4" />
                  Back
                </button>
              </form>
            </>
          )}

          {step === 'success' && (
            <div className="space-y-4 text-center">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-500 mb-2">
                <ShieldCheck className="w-8 h-8 text-white" />
              </div>
              <h2 className="text-lg font-semibold">Two-factor reset</h2>
              <p className="text-sm text-muted-foreground">
                Two-factor authentication has been disabled on your account. Sign in and follow the instructions to configure a new authenticator.
              </p>
              <button
                onClick={() => router.push('/login')}
                className="w-full py-2.5 rounded-lg bg-[var(--color-primary)] text-white font-medium text-sm hover:opacity-90 transition-opacity"
              >
                Go to sign in
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
