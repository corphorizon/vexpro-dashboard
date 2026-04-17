'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import Image from 'next/image';
import { ShieldCheck, ArrowRight, Copy, Check, Loader2 } from 'lucide-react';

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
  }, [user, router]);

  const generateSecret = async () => {
    try {
      const res = await fetch('/api/auth/setup-2fa', {
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
        setError(data.error || 'Error generando código QR');
      }
    } catch {
      setError('Error de conexión');
    }
  };

  const handleCopySecret = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (token.length !== 6) {
      setError('El código debe tener 6 dígitos');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/setup-2fa', {
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
        setError(data.error || 'Código incorrecto');
        setToken('');
      }
    } catch {
      setError('Error de conexión');
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
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground">Redirigiendo...</div>
      </div>
    );
  }

  // Success screen
  if (step === 'success') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-500 mb-4">
              <ShieldCheck className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-2xl font-bold">{t('profile.twofaEnabled')}</h1>
            <p className="text-muted-foreground text-sm mt-1">Tu cuenta está protegida con autenticación de dos factores</p>
          </div>

          <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
            <div className="space-y-4">
              <div className="px-4 py-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-400 text-sm">
                A partir de ahora, cada vez que inicies sesión necesitarás un código de tu app de autenticación.
              </div>

              <div className="px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-400 text-sm">
                <strong>Importante:</strong> No elimines la cuenta de VexPro FX de tu aplicación de autenticación. Si la pierdes, contacta al administrador.
              </div>

              <button
                onClick={handleContinue}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-[var(--color-primary)] text-white font-medium text-sm hover:opacity-90 transition-opacity"
              >
                Continuar al Dashboard
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
        {/* Header */}
        <div className="text-center mb-8">
          <Image
            src="/vex-logofull.png"
            alt="VexPro FX"
            width={180}
            height={50}
            className="mx-auto mb-4 block dark:hidden"
            priority
          />
          <Image
            src="/vex-logofull-white.png"
            alt="VexPro FX"
            width={180}
            height={50}
            className="mx-auto mb-4 hidden dark:block"
            priority
          />
          <p className="text-muted-foreground text-sm mt-1">Configuración de seguridad</p>
        </div>

        <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950/50">
              <ShieldCheck className="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Autenticación de dos factores</h2>
              <p className="text-xs text-muted-foreground">Google Authenticator / Authy</p>
            </div>
          </div>

          {step === 'loading' && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          )}

          {step === 'scan' && (
            <div className="space-y-5">
              {/* Step 1: Instructions */}
              <div className="px-4 py-3 rounded-lg bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-400 text-sm">
                <strong>Paso 1:</strong> Abre tu app de autenticación (Google Authenticator, Authy, etc.) y escanea este código QR.
              </div>

              {/* QR Code */}
              {qrCode && (
                <div className="flex justify-center">
                  <div className="p-4 bg-white rounded-xl border border-border shadow-sm">
                    <img
                      src={qrCode}
                      alt="Código QR para autenticación"
                      width={200}
                      height={200}
                      className="block"
                    />
                  </div>
                </div>
              )}

              {/* Manual secret */}
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground text-center">
                  ¿No puedes escanear? Ingresa este código manualmente:
                </p>
                <div className="flex items-center gap-2 justify-center">
                  <code className="px-3 py-2 rounded-lg bg-muted border border-border text-sm font-mono tracking-wider select-all">
                    {secret}
                  </code>
                  <button
                    onClick={handleCopySecret}
                    className="p-2 rounded-lg border border-border hover:bg-muted transition-colors"
                    title="Copiar"
                  >
                    {copied ? (
                      <Check className="w-4 h-4 text-emerald-500" />
                    ) : (
                      <Copy className="w-4 h-4 text-muted-foreground" />
                    )}
                  </button>
                </div>
              </div>

              {/* Continue to verify */}
              <button
                onClick={() => { setStep('verify'); setToken(''); setError(''); }}
                className="w-full py-2.5 rounded-lg bg-[var(--color-primary)] text-white font-medium text-sm hover:opacity-90 transition-opacity"
              >
                Ya escaneé el código
              </button>

              <div className="text-center">
                <button
                  onClick={handleSkip}
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  Omitir por ahora
                </button>
              </div>
            </div>
          )}

          {step === 'verify' && (
            <div className="space-y-5">
              {/* Step 2: Verify */}
              <div className="px-4 py-3 rounded-lg bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-400 text-sm">
                <strong>Paso 2:</strong> Ingresa el código de 6 dígitos que aparece en tu aplicación de autenticación.
              </div>

              <form onSubmit={handleVerify} className="space-y-4">
                <div>
                  <label htmlFor="totp-code" className="block text-sm font-medium mb-1.5">
                    Código de verificación
                  </label>
                  <input
                    id="totp-code"
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={token}
                    onChange={(e) => setToken(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    required
                    autoFocus
                    className="w-full px-3 py-2.5 rounded-lg border border-border bg-background text-sm text-center tracking-[0.5em] font-mono text-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                  />
                  <p className="text-xs text-muted-foreground mt-1.5">
                    El código cambia cada 30 segundos
                  </p>
                </div>

                {error && (
                  <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm" role="alert" aria-live="assertive">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={token.length !== 6 || loading}
                  className="w-full py-2.5 rounded-lg bg-[var(--color-primary)] text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Verificando...
                    </>
                  ) : (
                    'Verificar y activar'
                  )}
                </button>
              </form>

              <button
                onClick={() => { setStep('scan'); setError(''); }}
                className="w-full text-center text-sm text-[var(--color-primary)] hover:underline"
              >
                Volver al código QR
              </button>
            </div>
          )}
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Puedes cambiar esta configuración en cualquier momento desde tu perfil.
        </p>
      </div>
    </div>
  );
}
