'use client';

import { useState, Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Eye, EyeOff, ShieldCheck, ArrowLeft, Loader2 } from 'lucide-react';
import { AuthBrand } from '@/components/auth-brand';
import { createClient } from '@/lib/supabase/client';

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
// ─────────────────────────────────────────────────────────────────────────────

const supabase = createClient();

type Mode = 'custom-reset' | 'supabase-invite' | 'invalid' | 'pending';

function ResetPasswordInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const customToken = searchParams.get('token') || '';

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
    if (password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (password !== confirm) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    setLoading(true);
    try {
      if (mode === 'supabase-invite') {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw new Error(error.message);
        setSuccess(true);
      } else if (mode === 'custom-reset') {
        const res = await fetch('/api/auth/reset-password-confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: customToken, newPassword: password }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'No fue posible actualizar la contraseña');
        }
        // Sign the user out on the custom flow so they log in fresh with the
        // new password. In the invite flow the session is valid — we let the
        // user go straight in.
        setSuccess(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Algo salió mal');
    } finally {
      setLoading(false);
    }
  };

  // ── Loading while resolving which flow to use ────────────────────────
  if (mode === 'pending') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // ── Invalid / expired ────────────────────────────────────────────────
  if (mode === 'invalid') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-md text-center">
          <AuthBrand />
          <h1 className="text-xl font-bold mb-2">Enlace inválido</h1>
          <p className="text-sm text-muted-foreground mb-6">
            {error ?? 'El enlace está incompleto o expirado. Solicita uno nuevo.'}
          </p>
          <button
            onClick={() => router.push('/login')}
            className="text-sm text-[var(--color-primary)] hover:underline"
          >
            ← Volver al inicio de sesión
          </button>
        </div>
      </div>
    );
  }

  // ── Success ──────────────────────────────────────────────────────────
  if (success) {
    const canGoHome = mode === 'supabase-invite';
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-500 mb-4">
              <ShieldCheck className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-2xl font-bold">
              {canGoHome ? 'Cuenta activada' : 'Contraseña actualizada'}
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              {canGoHome
                ? 'Tu contraseña está lista. Ya puedes usar el dashboard.'
                : 'Ahora puedes iniciar sesión con tu nueva contraseña.'}
            </p>
          </div>
          <div className="bg-card border border-border rounded-xl p-6 shadow-sm text-center">
            <button
              onClick={() => router.push(canGoHome ? '/' : '/login')}
              className="w-full py-2.5 rounded-lg bg-[var(--color-primary)] text-white font-medium text-sm hover:opacity-90 transition-opacity"
            >
              {canGoHome ? 'Ir al dashboard' : 'Ir a iniciar sesión'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Form ─────────────────────────────────────────────────────────────
  const isInvite = mode === 'supabase-invite';
  const title = isInvite
    ? (inviteType === 'recovery' ? 'Define tu nueva contraseña' : 'Bienvenido — define tu contraseña')
    : 'Restablece tu contraseña';
  const subtitle = isInvite
    ? 'Elige una contraseña para tu cuenta. Después entras directo al dashboard.'
    : 'Elige una nueva contraseña. Si tu cuenta estaba bloqueada, se desbloquea aquí.';

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <AuthBrand />

        <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
          <h2 className="text-lg font-semibold mb-2">{title}</h2>
          <p className="text-sm text-muted-foreground mb-6">{subtitle}</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="password" className="block text-sm font-medium mb-1.5">Nueva contraseña</label>
              <div className="relative">
                <input
                  id="password"
                  type={show ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  minLength={8}
                  required
                  autoFocus
                  autoComplete="new-password"
                  className="w-full pr-11 px-3 py-2.5 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                />
                <button
                  type="button"
                  onClick={() => setShow(v => !v)}
                  aria-label={show ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground rounded-r-lg"
                >
                  {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Mínimo 8 caracteres.</p>
            </div>

            <div>
              <label htmlFor="confirm" className="block text-sm font-medium mb-1.5">Confirmar contraseña</label>
              <input
                id="confirm"
                type={show ? 'text' : 'password'}
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                minLength={8}
                required
                autoComplete="new-password"
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
              className="w-full py-2.5 rounded-lg bg-[var(--color-primary)] text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading
                ? <><Loader2 className="w-4 h-4 animate-spin" />Guardando…</>
                : (isInvite ? 'Activar cuenta' : 'Actualizar contraseña')}
            </button>
          </form>

          <div className="mt-4 text-center">
            <button
              onClick={() => router.push('/login')}
              className="flex items-center gap-2 mx-auto text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="w-4 h-4" />
              Volver al inicio de sesión
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-background"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>}>
      <ResetPasswordInner />
    </Suspense>
  );
}
