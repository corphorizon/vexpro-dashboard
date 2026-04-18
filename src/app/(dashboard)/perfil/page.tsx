'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth, ROLE_LABELS } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import { UserCircle, Lock, ShieldCheck, Eye, EyeOff, Check, X, Copy, Loader2 } from 'lucide-react';

export default function PerfilPage() {
  const { t } = useI18n();
  const { user, updateUser, changePassword, refreshUser } = useAuth();

  // Name editing
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(user?.name || '');
  const [nameSaved, setNameSaved] = useState(false);

  // Password change
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPw, setShowCurrentPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);

  // 2FA TOTP
  const [showTotpSetup, setShowTotpSetup] = useState(false);
  const [totpSecret, setTotpSecret] = useState('');
  const [totpQrCode, setTotpQrCode] = useState('');
  const [totpToken, setTotpToken] = useState('');
  const [totpStep, setTotpStep] = useState<'scan' | 'verify'>('scan');
  const [totpLoading, setTotpLoading] = useState(false);
  const [totpCopied, setTotpCopied] = useState(false);
  const [pinError, setPinError] = useState('');
  const [pinSuccess, setPinSuccess] = useState(false);

  // 2FA deactivation
  const [showDeactivateForm, setShowDeactivateForm] = useState(false);
  const [deactivatePin, setDeactivatePin] = useState('');
  const [deactivateError, setDeactivateError] = useState('');
  const [deactivateLoading, setDeactivateLoading] = useState(false);

  if (!user) return null;

  const handleSaveName = () => {
    if (!name.trim()) return;
    updateUser(user.id, { name: name.trim() });
    setEditingName(false);
    setNameSaved(true);
    setTimeout(() => setNameSaved(false), 2000);
  };

  const handleCancelName = () => {
    setName(user.name);
    setEditingName(false);
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess(false);

    if (newPassword.length < 6) {
      setPasswordError(t('profile.passwordTooShort'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError(t('profile.passwordMismatch'));
      return;
    }

    setPasswordLoading(true);
    try {
      const success = await changePassword(user.id, currentPassword, newPassword);
      if (success) {
        setPasswordSuccess(true);
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        setShowPasswordForm(false);
        setTimeout(() => setPasswordSuccess(false), 3000);
      } else {
        setPasswordError(t('profile.passwordWrong'));
      }
    } catch {
      setPasswordError(t('profile.passwordError'));
    } finally {
      setPasswordLoading(false);
    }
  };

  // Generate TOTP secret and QR code for setup
  const handleStartTotpSetup = async () => {
    setShowTotpSetup(true);
    setTotpStep('scan');
    setTotpToken('');
    setPinError('');
    setTotpLoading(true);

    try {
      const res = await fetch('/api/auth/setup-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate' }),
      });
      const data = await res.json();
      if (data.success) {
        setTotpSecret(data.secret);
        setTotpQrCode(data.qrCode);
      } else {
        setPinError(data.error || 'Error generando QR');
      }
    } catch {
      setPinError('Error de conexión');
    } finally {
      setTotpLoading(false);
    }
  };

  const handleVerifyTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError('');

    if (totpToken.length !== 6) {
      setPinError('El código debe tener 6 dígitos');
      return;
    }

    setTotpLoading(true);
    try {
      const res = await fetch('/api/auth/setup-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', secret: totpSecret, token: totpToken }),
      });
      const data = await res.json();

      if (data.success) {
        await refreshUser();
        setPinSuccess(true);
        setShowTotpSetup(false);
        setTotpToken('');
        setTimeout(() => setPinSuccess(false), 3000);
      } else {
        setPinError(data.error || 'Código incorrecto');
        setTotpToken('');
      }
    } catch {
      setPinError('Error de conexión');
    } finally {
      setTotpLoading(false);
    }
  };

  const handleCopyTotpSecret = async () => {
    try {
      await navigator.clipboard.writeText(totpSecret);
      setTotpCopied(true);
      setTimeout(() => setTotpCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const handleDisable2FA = () => {
    setShowDeactivateForm(true);
    setDeactivatePin('');
    setDeactivateError('');
  };

  const handleConfirmDeactivate = async (e: React.FormEvent) => {
    e.preventDefault();
    setDeactivateError('');

    if (deactivatePin.length !== 6) {
      setDeactivateError('El código debe tener 6 dígitos');
      return;
    }

    setDeactivateLoading(true);
    try {
      const res = await fetch('/api/auth/setup-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disable', token: deactivatePin }),
      });
      const data = await res.json();
      if (!data.success) {
        setDeactivateError(data.error || 'Código incorrecto');
        setDeactivatePin('');
        return;
      }
      await refreshUser();
      setShowDeactivateForm(false);
      setDeactivatePin('');
      setPinSuccess(true);
      setTimeout(() => setPinSuccess(false), 3000);
    } catch {
      setDeactivateError('Error de conexión');
    } finally {
      setDeactivateLoading(false);
    }
  };

  const handleCancelDeactivate = () => {
    setShowDeactivateForm(false);
    setDeactivatePin('');
    setDeactivateError('');
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('profile.title')}
        subtitle={t('profile.subtitle')}
        icon={UserCircle}
      />

      {/* Profile Info Card */}
      <Card>
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950/50">
            <UserCircle className="w-5 h-5 text-blue-500" />
          </div>
          <h2 className="text-lg font-semibold">{t('profile.personalInfo')}</h2>
        </div>

        <div className="space-y-5">
          {/* Name field - editable */}
          <div>
            <label className="block text-sm font-medium mb-1.5">{t('profile.name')}</label>
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                />
                <button
                  onClick={handleSaveName}
                  disabled={!name.trim()}
                  className="p-2 rounded-lg bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
                  title={t('common.save')}
                  aria-label={t('common.save')}
                >
                  <Check className="w-4 h-4" />
                </button>
                <button
                  onClick={handleCancelName}
                  className="p-2 rounded-lg border border-border hover:bg-muted transition-colors"
                  title={t('common.cancel')}
                  aria-label={t('common.cancel')}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="px-3 py-2 text-sm">{user.name}</span>
                <button
                  onClick={() => { setName(user.name); setEditingName(true); }}
                  className="text-xs text-[var(--color-primary)] hover:underline"
                >
                  {t('profile.edit')}
                </button>
                {nameSaved && (
                  <span className="text-xs text-emerald-600">{t('common.saved')}</span>
                )}
              </div>
            )}
          </div>

          {/* Email - read only */}
          <div>
            <label className="block text-sm font-medium mb-1.5">{t('profile.email')}</label>
            <div className="px-3 py-2 rounded-lg bg-muted/50 border border-border text-sm text-muted-foreground">
              {user.email}
            </div>
            <p className="text-xs text-muted-foreground mt-1">{t('profile.emailReadonly')}</p>
          </div>

          {/* Role - read only */}
          <div>
            <label className="block text-sm font-medium mb-1.5">{t('profile.role')}</label>
            <div className="px-3 py-2 rounded-lg bg-muted/50 border border-border text-sm text-muted-foreground">
              {ROLE_LABELS[user.role] || user.role}
            </div>
            <p className="text-xs text-muted-foreground mt-1">{t('profile.roleReadonly')}</p>
          </div>
        </div>
      </Card>

      {/* Password Card */}
      <Card>
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950/50">
            <Lock className="w-5 h-5 text-amber-500" />
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold">{t('profile.changePassword')}</h2>
            <p className="text-xs text-muted-foreground">{t('profile.passwordSubtitle')}</p>
          </div>
        </div>

        {passwordSuccess && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-400 text-sm" aria-live="polite">
            {t('profile.passwordSuccess')}
          </div>
        )}

        {!showPasswordForm ? (
          <button
            onClick={() => setShowPasswordForm(true)}
            className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
          >
            {t('profile.changePassword')}
          </button>
        ) : (
          <form onSubmit={handleChangePassword} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">{t('profile.currentPassword')}</label>
              <div className="relative">
                <input
                  type={showCurrentPw ? 'text' : 'password'}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)] pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowCurrentPw(!showCurrentPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="Toggle visibility"
                >
                  {showCurrentPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5">{t('profile.newPassword')}</label>
              <div className="relative">
                <input
                  type={showNewPw ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={6}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)] pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowNewPw(!showNewPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="Toggle visibility"
                >
                  {showNewPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{t('profile.passwordMinLength')}</p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5">{t('profile.confirmPassword')}</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
              />
            </div>

            {passwordError && (
              <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm" role="alert" aria-live="assertive">
                {passwordError}
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={passwordLoading}
                className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {passwordLoading ? t('common.saving') : t('profile.savePassword')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowPasswordForm(false);
                  setPasswordError('');
                  setCurrentPassword('');
                  setNewPassword('');
                  setConfirmPassword('');
                }}
                className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                {t('common.cancel')}
              </button>
            </div>
          </form>
        )}
      </Card>

      {/* 2FA Card */}
      <Card>
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/50">
            <ShieldCheck className="w-5 h-5 text-emerald-500" />
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold">{t('profile.twofa')}</h2>
            <p className="text-xs text-muted-foreground">{t('profile.twofaSubtitle')}</p>
          </div>
        </div>

        {pinSuccess && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-400 text-sm" aria-live="polite">
            {t('profile.pinSuccess')}
          </div>
        )}

        {/* Current status */}
        <div className="mb-4 flex items-center gap-3">
          <span className="text-sm font-medium">{t('profile.twofaStatus')}</span>
          {user.twofa_enabled ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              {t('profile.twofaActivated')}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700">
              <span className="w-2 h-2 rounded-full bg-gray-400" />
              {t('profile.twofaDeactivated')}
            </span>
          )}
        </div>

        {user.twofa_enabled ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Tu cuenta está protegida con autenticación de dos factores mediante tu app de autenticación.
            </p>

            <button
              onClick={handleDisable2FA}
              className="px-4 py-2 rounded-lg border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-sm font-medium hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors"
            >
              Desactivar 2FA
            </button>

            {/* Deactivation form */}
            {showDeactivateForm && (
              <form onSubmit={handleConfirmDeactivate} className="mt-2 p-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50/30 dark:bg-red-950/20 space-y-4">
                <p className="text-sm font-medium text-red-700 dark:text-red-400">
                  Ingresa el código de tu app de autenticación para confirmar:
                </p>
                <div>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={deactivatePin}
                    onChange={(e) => setDeactivatePin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    required
                    autoFocus
                    className="w-full max-w-xs px-3 py-2.5 rounded-lg border border-border bg-background text-sm text-center tracking-[0.5em] font-mono text-lg focus:outline-none focus:ring-2 focus:ring-red-300 dark:focus:ring-red-700"
                  />
                </div>

                {deactivateError && (
                  <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm" role="alert">
                    {deactivateError}
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={deactivatePin.length !== 6 || deactivateLoading}
                    className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50 flex items-center gap-2"
                  >
                    {deactivateLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                    Confirmar desactivación
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelDeactivate}
                    className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Protege tu cuenta activando la autenticación de dos factores con Google Authenticator, Authy u otra app compatible.
            </p>

            {!showTotpSetup && (
              <button
                onClick={handleStartTotpSetup}
                className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
              >
                Activar 2FA
              </button>
            )}
          </div>
        )}

        {/* TOTP Setup Flow */}
        {showTotpSetup && (
          <div className="mt-4 p-4 rounded-lg border border-border bg-muted/30 space-y-4">
            {totpLoading && !totpQrCode ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : totpStep === 'scan' ? (
              <>
                <div className="px-4 py-3 rounded-lg bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-400 text-sm">
                  <strong>Paso 1:</strong> Escanea este código QR con tu app de autenticación.
                </div>

                {totpQrCode && (
                  <div className="flex justify-center">
                    <div className="p-3 bg-white rounded-xl border border-border shadow-sm">
                      <img src={totpQrCode} alt="QR Code" width={180} height={180} className="block" />
                    </div>
                  </div>
                )}

                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground text-center">Código manual:</p>
                  <div className="flex items-center gap-2 justify-center">
                    <code className="px-2.5 py-1.5 rounded-lg bg-muted border border-border text-xs font-mono tracking-wider select-all">
                      {totpSecret}
                    </code>
                    <button onClick={handleCopyTotpSecret} className="p-1.5 rounded border border-border hover:bg-muted transition-colors" title="Copiar">
                      {totpCopied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5 text-muted-foreground" />}
                    </button>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => { setTotpStep('verify'); setTotpToken(''); setPinError(''); }}
                    className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
                  >
                    Ya lo escaneé
                  </button>
                  <button
                    onClick={() => { setShowTotpSetup(false); setPinError(''); }}
                    className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </>
            ) : (
              <form onSubmit={handleVerifyTotp} className="space-y-4">
                <div className="px-4 py-3 rounded-lg bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-400 text-sm">
                  <strong>Paso 2:</strong> Ingresa el código de 6 dígitos de tu app.
                </div>

                <div>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={totpToken}
                    onChange={(e) => setTotpToken(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    required
                    autoFocus
                    className="w-full max-w-xs px-3 py-2.5 rounded-lg border border-border bg-background text-sm text-center tracking-[0.5em] font-mono text-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                  />
                  <p className="text-xs text-muted-foreground mt-1">El código cambia cada 30 segundos</p>
                </div>

                {pinError && (
                  <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm" role="alert">
                    {pinError}
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={totpToken.length !== 6 || totpLoading}
                    className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2"
                  >
                    {totpLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                    Verificar y activar
                  </button>
                  <button
                    type="button"
                    onClick={() => { setTotpStep('scan'); setPinError(''); }}
                    className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
                  >
                    Volver al QR
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
