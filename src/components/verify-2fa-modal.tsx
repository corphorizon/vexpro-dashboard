'use client';

import { useState, useCallback } from 'react';
import { ShieldCheck, Loader2, X } from 'lucide-react';

interface Verify2FAModalProps {
  open: boolean;
  onVerified: () => void;
  onClose: () => void;
}

export function Verify2FAModal({ open, onVerified, onClose }: Verify2FAModalProps) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (token.length !== 6) {
      setError('El codigo debe tener 6 digitos');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: token }),
      });
      const data = await res.json();

      if (data.success) {
        setToken('');
        setError('');
        onVerified();
      } else {
        setError(data.error || 'Codigo incorrecto');
        setToken('');
      }
    } catch {
      setError('Error de conexion');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setToken('');
    setError('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-xl p-6 shadow-xl w-full max-w-sm mx-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950/50">
              <ShieldCheck className="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <h3 className="text-base font-semibold">Verificacion 2FA</h3>
              <p className="text-xs text-muted-foreground">Ingresa el codigo de tu app</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 rounded-lg hover:bg-muted transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
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
            <p className="text-xs text-muted-foreground mt-1.5 text-center">
              Codigo de Google Authenticator / Authy
            </p>
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm" role="alert">
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
              'Verificar y descargar'
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * Hook that wraps any export/download function with 2FA verification.
 * If the user has 2FA enabled, shows a modal first. Otherwise, runs directly.
 *
 * Usage:
 *   const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
 *
 *   const handleExport = () => {
 *     verify2FA(() => { downloadCSV(...) });
 *   };
 *
 *   return <>{Modal2FA}<button onClick={handleExport}>Export</button></>
 */
export function useExport2FA(twofa_enabled: boolean | undefined) {
  const [show, setShow] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const verify2FA = useCallback((action: () => void) => {
    if (twofa_enabled) {
      setPendingAction(() => action);
      setShow(true);
    } else {
      // No 2FA configured — run immediately
      action();
    }
  }, [twofa_enabled]);

  const handleVerified = useCallback(() => {
    setShow(false);
    if (pendingAction) {
      pendingAction();
      setPendingAction(null);
    }
  }, [pendingAction]);

  const handleClose = useCallback(() => {
    setShow(false);
    setPendingAction(null);
  }, []);

  const Modal2FA = (
    <Verify2FAModal
      open={show}
      onVerified={handleVerified}
      onClose={handleClose}
    />
  );

  return { verify2FA, Modal2FA };
}
