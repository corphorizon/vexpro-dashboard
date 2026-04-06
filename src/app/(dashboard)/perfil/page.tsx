'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { useAuth, ROLE_LABELS } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import { UserCircle, Lock, ShieldCheck, Eye, EyeOff, Check, X } from 'lucide-react';

export default function PerfilPage() {
  const { t } = useI18n();
  const { user, updateUser, changePassword } = useAuth();

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

  // 2FA
  const [showPinSetup, setShowPinSetup] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [pinSuccess, setPinSuccess] = useState(false);

  // 2FA deactivation
  const [showDeactivateForm, setShowDeactivateForm] = useState(false);
  const [deactivatePin, setDeactivatePin] = useState('');
  const [deactivateError, setDeactivateError] = useState('');
  const [showForgotPin, setShowForgotPin] = useState(false);
  const [forgotPinEmailSent, setForgotPinEmailSent] = useState(false);
  const [showSetupNewPin, setShowSetupNewPin] = useState(false);

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

  const handleEnable2FA = (e: React.FormEvent) => {
    e.preventDefault();
    setPinError('');
    setPinSuccess(false);

    if (newPin.length !== 6) {
      setPinError(t('profile.pinMustBe6'));
      return;
    }

    updateUser(user.id, {
      twofa_enabled: true,
      twofa_secret: newPin,
    });
    setPinSuccess(true);
    setNewPin('');
    setShowPinSetup(false);
    setTimeout(() => setPinSuccess(false), 3000);
  };

  const handleDisable2FA = () => {
    setShowDeactivateForm(true);
    setDeactivatePin('');
    setDeactivateError('');
    setShowForgotPin(false);
    setForgotPinEmailSent(false);
    setShowSetupNewPin(false);
  };

  const handleConfirmDeactivate = (e: React.FormEvent) => {
    e.preventDefault();
    setDeactivateError('');

    if (deactivatePin.length !== 6) {
      setDeactivateError(t('profile.pinMustBe6'));
      return;
    }

    if (deactivatePin !== user.twofa_secret) {
      setDeactivateError(t('profile.pinIncorrect'));
      return;
    }

    updateUser(user.id, {
      twofa_enabled: false,
      twofa_secret: null,
    });
    setShowDeactivateForm(false);
    setDeactivatePin('');
  };

  const handleCancelDeactivate = () => {
    setShowDeactivateForm(false);
    setDeactivatePin('');
    setDeactivateError('');
    setShowForgotPin(false);
    setForgotPinEmailSent(false);
    setShowSetupNewPin(false);
  };

  const handleForgotPinSendEmail = () => {
    if (forgotPinEmailSent) return; // Prevent multiple clicks
    setForgotPinEmailSent(true);
    setTimeout(() => {
      updateUser(user.id, {
        twofa_enabled: false,
        twofa_secret: null,
      });
      setShowDeactivateForm(false);
      setShowForgotPin(false);
      setForgotPinEmailSent(false);
      setShowSetupNewPin(true);
      setPinSuccess(true);
      setTimeout(() => setPinSuccess(false), 3000);
    }, 3000);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">{t('profile.title')}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t('profile.subtitle')}</p>
      </div>

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
              {t('profile.twofaProtectedMsg')}
            </p>

            <div className="flex gap-2">
              <button
                onClick={() => { setShowPinSetup(true); setNewPin(''); setPinError(''); }}
                className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                {t('profile.changePin')}
              </button>
              <button
                onClick={handleDisable2FA}
                className="px-4 py-2 rounded-lg border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-sm font-medium hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors"
              >
                {t('profile.deactivate2fa')}
              </button>
            </div>

            {/* Deactivation PIN confirmation form */}
            {showDeactivateForm && (
              <form onSubmit={handleConfirmDeactivate} className="mt-2 p-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50/30 dark:bg-red-950/20 space-y-4">
                <p className="text-sm font-medium text-red-700 dark:text-red-400">
                  {t('profile.deactivateConfirm')}
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
                  <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm" role="alert" aria-live="assertive">
                    {deactivateError}
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={deactivatePin.length !== 6}
                    className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50"
                  >
                    {t('profile.confirmDeactivation')}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelDeactivate}
                    className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
                  >
                    {t('common.cancel')}
                  </button>
                </div>

                {/* Forgot PIN link */}
                {!showForgotPin && !forgotPinEmailSent && (
                  <button
                    type="button"
                    onClick={() => setShowForgotPin(true)}
                    className="text-xs text-[var(--color-primary)] hover:underline"
                  >
                    {t('profile.forgotPin')}
                  </button>
                )}

                {/* Forgot PIN recovery flow */}
                {showForgotPin && !forgotPinEmailSent && (
                  <div className="p-3 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 space-y-3">
                    <p className="text-sm text-muted-foreground">
                      {t('profile.forgotPinMsg')}<span className="font-medium text-foreground">{user.email}</span>
                    </p>
                    <button
                      type="button"
                      onClick={handleForgotPinSendEmail}
                      disabled={forgotPinEmailSent}
                      className="px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors disabled:opacity-50"
                    >
                      {t('profile.sendLink')}
                    </button>
                  </div>
                )}

                {/* Email sent confirmation */}
                {forgotPinEmailSent && (
                  <div className="p-3 rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20 space-y-2">
                    <p className="text-sm text-emerald-700 dark:text-emerald-400">
                      {t('profile.emailSent', { email: user.email })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('profile.deactivatingAuto')}
                    </p>
                  </div>
                )}
              </form>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t('profile.activate2faMsg')}
            </p>

            {/* Option to set up new PIN after recovery */}
            {showSetupNewPin && !showPinSetup && (
              <div className="p-3 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20 space-y-3">
                <p className="text-sm text-muted-foreground">
                  {t('profile.recoveryMsg')}
                </p>
                <button
                  onClick={() => { setShowPinSetup(true); setNewPin(''); setPinError(''); setShowSetupNewPin(false); }}
                  className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
                >
                  {t('profile.setupNewPin')}
                </button>
              </div>
            )}

            {!showPinSetup && !showSetupNewPin ? (
              <button
                onClick={() => { setShowPinSetup(true); setNewPin(''); setPinError(''); }}
                className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
              >
                {t('profile.activate2fa')}
              </button>
            ) : null}
          </div>
        )}

        {/* PIN Setup Form */}
        {showPinSetup && (
          <form onSubmit={handleEnable2FA} className="mt-4 p-4 rounded-lg border border-border bg-muted/30 space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">
                {user.twofa_enabled ? t('profile.newPinLabel') : t('profile.setPinLabel')}
              </label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={newPin}
                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                required
                autoFocus
                className="w-full max-w-xs px-3 py-2.5 rounded-lg border border-border bg-background text-sm text-center tracking-[0.5em] font-mono text-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {t('profile.pinLoginMsg')}
              </p>
            </div>

            {pinError && (
              <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm" role="alert" aria-live="assertive">
                {pinError}
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={newPin.length !== 6}
                className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {user.twofa_enabled ? t('profile.updatePin') : t('profile.activate2fa')}
              </button>
              <button
                type="button"
                onClick={() => { setShowPinSetup(false); setPinError(''); setNewPin(''); }}
                className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                {t('common.cancel')}
              </button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
