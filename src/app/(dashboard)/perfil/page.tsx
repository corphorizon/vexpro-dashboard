'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /perfil — datos propios, contraseña y 2FA.
//
// «Libro mayor» (2026-10-12): tres Panel (borde 1 px, cabecera 15/600 + hint),
// campos con Field/Input (borde `control-border` 3:1), estado de 2FA con
// StatusBadge (mismo mapa que /usuarios: users-view.ts `twofaKind`), avisos
// con Notice y SuccessNote, botones ActionButton (los primarios eran
// `bg-[var(--color-primary)] text-white`; el de desactivar, `bg-red-600`).
// Sale la paleta cruda (azul, ámbar, esmeralda, gris, rojo) y sus `dark:`.
// Un solo primario visible por vez: los disparadores de cada panel son
// secundarios; el primario es el «guardar / verificar» del formulario abierto.
//
// NO cambió: endpoints (/api/auth/setup-2fa), payloads, ni las funciones de
// useAuth (`updateUser`, `changePassword`, `refreshUser`).
//
// Fallos que no daban error (profile-view.ts, con test):
//   · «Guardado» del nombre aparecía sin esperar a `updateUser` (que además
//     se traga los errores). Ahora se espera y se confirma contra el nombre
//     de la sesión; si no quedó, se dice.
//   · Si generar el QR de 2FA fallaba, el paso 1 quedaba vacío y sin aviso
//     (el error sólo se dibujaba en el paso 2) con «Ya lo escaneé»
//     habilitado. Ahora se avisa y no se puede avanzar sin secreto.
//   · Copiar el código manual fallaba en silencio (catch vacío): se avisa.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { Notice } from '@/components/ui/notice';
import { Field, Input } from '@/components/ui/field';
import { StatusBadge } from '@/components/ui/status-badge';
import { ActionButton, ROW_ACTION_CLASS } from '@/components/ui/action-button';
import { SuccessNote } from '@/components/success-note';
import { useAuth, ROLE_LABELS } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import { UserCircle, Eye, EyeOff, Check, X, Copy, Loader2 } from 'lucide-react';
import { twofaKind } from '../usuarios/users-view';
import { canContinueToVerify, nameSaveOutcome, sanitizePin } from './profile-view';

/** Valor de sólo lectura con la forma de un control (no editable, copiable). */
function ReadOnlyValue({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12.5px] font-medium text-text-2">{label}</span>
      <div className="flex min-h-9 items-center break-all rounded-ui-md border border-border bg-surface-2 px-2.5 text-[13px] text-text-2">
        {value}
      </div>
      <p className="text-[12px] leading-4 text-text-3">{hint}</p>
    </div>
  );
}

const PIN_INPUT_CLASS = 'max-w-[220px] text-center font-mono tracking-[0.5em] text-[18px]!';

export default function PerfilPage() {
  const { t } = useI18n();
  const { user, updateUser, changePassword, refreshUser } = useAuth();

  // Name editing
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(user?.name || '');
  const [nameSaving, setNameSaving] = useState(false);
  // Nombre pedido en el último guardado; se compara contra la sesión.
  const [nameExpected, setNameExpected] = useState<string | null>(null);

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
  const [totpCopyFailed, setTotpCopyFailed] = useState(false);
  const [pinError, setPinError] = useState('');
  const [pinSuccess, setPinSuccess] = useState(false);

  // 2FA deactivation
  const [showDeactivateForm, setShowDeactivateForm] = useState(false);
  const [deactivatePin, setDeactivatePin] = useState('');
  const [deactivateError, setDeactivateError] = useState('');
  const [deactivateLoading, setDeactivateLoading] = useState(false);

  const nameOutcome = nameSaveOutcome(nameExpected, user?.name);

  // «Guardado» se va solo a los 2 s; «no se pudo confirmar» queda hasta el
  // próximo intento.
  useEffect(() => {
    if (nameOutcome !== 'saved') return;
    const id = setTimeout(() => setNameExpected(null), 2000);
    return () => clearTimeout(id);
  }, [nameOutcome]);

  if (!user) return null;

  const handleSaveName = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setNameSaving(true);
    setNameExpected(null);
    // Misma llamada que antes; ahora se ESPERA antes de decir «Guardado».
    await updateUser(user.id, { name: trimmed });
    setNameSaving(false);
    setEditingName(false);
    setNameExpected(trimmed);
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

  const cancelPasswordForm = () => {
    setShowPasswordForm(false);
    setPasswordError('');
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  };

  // Generate TOTP secret and QR code for setup
  const handleStartTotpSetup = async () => {
    setShowTotpSetup(true);
    setTotpStep('scan');
    setTotpToken('');
    setPinError('');
    setTotpSecret('');
    setTotpQrCode('');
    setTotpLoading(true);

    try {
      const res = await apiFetch('/api/auth/setup-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate' }),
      });
      const data = await res.json();
      if (data.success) {
        setTotpSecret(data.secret);
        setTotpQrCode(data.qrCode);
      } else {
        setPinError(data.error || t('lmAdm.profile.qrError'));
      }
    } catch {
      setPinError(t('lmAdm.profile.connError'));
    } finally {
      setTotpLoading(false);
    }
  };

  const handleVerifyTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError('');

    if (totpToken.length !== 6) {
      setPinError(t('lmAdm.profile.pinLength'));
      return;
    }

    setTotpLoading(true);
    try {
      const res = await apiFetch('/api/auth/setup-2fa', {
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
        setPinError(data.error || t('lmAdm.profile.wrongCode'));
        setTotpToken('');
      }
    } catch {
      setPinError(t('lmAdm.profile.connError'));
    } finally {
      setTotpLoading(false);
    }
  };

  const handleCopyTotpSecret = async () => {
    setTotpCopyFailed(false);
    try {
      await navigator.clipboard.writeText(totpSecret);
      setTotpCopied(true);
      setTimeout(() => setTotpCopied(false), 2000);
    } catch {
      // Antes: catch vacío — el botón no hacía nada y nadie sabía por qué.
      setTotpCopyFailed(true);
    }
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
      setDeactivateError(t('lmAdm.profile.pinLength'));
      return;
    }

    setDeactivateLoading(true);
    try {
      const res = await apiFetch('/api/auth/setup-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disable', token: deactivatePin }),
      });
      const data = await res.json();
      if (!data.success) {
        setDeactivateError(data.error || t('lmAdm.profile.wrongCode'));
        setDeactivatePin('');
        return;
      }
      await refreshUser();
      setShowDeactivateForm(false);
      setDeactivatePin('');
      setPinSuccess(true);
      setTimeout(() => setPinSuccess(false), 3000);
    } catch {
      setDeactivateError(t('lmAdm.profile.connError'));
    } finally {
      setDeactivateLoading(false);
    }
  };

  const handleCancelDeactivate = () => {
    setShowDeactivateForm(false);
    setDeactivatePin('');
    setDeactivateError('');
  };

  const visibilityLabel = t('lmAdm.profile.toggleVisibility');

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('profile.title')}
        subtitle={t('profile.subtitle')}
        icon={UserCircle}
      />

      {/* Datos personales */}
      <Panel title={t('profile.personalInfo')}>
        <div className="grid gap-4 md:grid-cols-2">
          {/* Name field - editable */}
          <div className="md:col-span-2">
            {editingName ? (
              <Field label={t('profile.name')}>
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); void handleSaveName(); }
                      if (e.key === 'Escape') handleCancelName();
                    }}
                    autoComplete="name"
                    autoFocus
                    className="max-w-sm"
                  />
                  <ActionButton
                    variant="primary"
                    onClick={() => void handleSaveName()}
                    disabled={!name.trim()}
                    loading={nameSaving}
                  >
                    {!nameSaving && <Check aria-hidden className="size-[15px]" strokeWidth={1.75} />}
                    {t('common.save')}
                  </ActionButton>
                  <button
                    type="button"
                    onClick={handleCancelName}
                    className={ROW_ACTION_CLASS}
                    title={t('common.cancel')}
                    aria-label={t('common.cancel')}
                  >
                    <X aria-hidden className="size-4" strokeWidth={1.75} />
                  </button>
                </div>
              </Field>
            ) : (
              <div className="flex flex-col gap-1">
                <span className="text-[12.5px] font-medium text-text-2">{t('profile.name')}</span>
                <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-[14px] font-medium text-foreground">{user.name}</span>
                  <ActionButton variant="ghost" onClick={() => { setName(user.name); setEditingName(true); }}>
                    {t('profile.edit')}
                  </ActionButton>
                  {nameOutcome === 'saved' && (
                    <span role="status" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-pos">
                      <Check aria-hidden className="size-3.5" strokeWidth={2} />
                      {t('common.saved')}
                    </span>
                  )}
                </div>
              </div>
            )}
            {nameOutcome === 'unconfirmed' && nameExpected != null && (
              <Notice kind="bad" title={t('lmAdm.profile.nameUnconfirmedTitle')} className="mt-3">
                {t('lmAdm.profile.nameUnconfirmedBody', { name: user.name })}
              </Notice>
            )}
          </div>

          {/* Email - read only */}
          <ReadOnlyValue label={t('profile.email')} value={user.email} hint={t('profile.emailReadonly')} />

          {/* Role - read only */}
          <ReadOnlyValue
            label={t('profile.role')}
            value={ROLE_LABELS[user.role] || user.role}
            hint={t('profile.roleReadonly')}
          />
        </div>
      </Panel>

      {/* Contraseña */}
      <Panel title={t('profile.changePassword')} hint={t('profile.passwordSubtitle')}>
        <div className="space-y-4">
          {passwordSuccess && <SuccessNote>{t('profile.passwordSuccess')}</SuccessNote>}

          {!showPasswordForm ? (
            <ActionButton onClick={() => setShowPasswordForm(true)}>
              {t('profile.changePassword')}
            </ActionButton>
          ) : (
            <form onSubmit={handleChangePassword} className="max-w-md space-y-4">
              <Field label={t('profile.currentPassword')} required>
                <div className="relative">
                  <Input
                    type={showCurrentPw ? 'text' : 'password'}
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    autoComplete="current-password"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCurrentPw(!showCurrentPw)}
                    className="absolute right-0.5 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-ui-md text-text-3 hover:text-foreground"
                    aria-label={visibilityLabel}
                    aria-pressed={showCurrentPw}
                  >
                    {showCurrentPw ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
                  </button>
                </div>
              </Field>

              <Field label={t('profile.newPassword')} hint={t('profile.passwordMinLength')} required>
                <div className="relative">
                  <Input
                    type={showNewPw ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    minLength={6}
                    autoComplete="new-password"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPw(!showNewPw)}
                    className="absolute right-0.5 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-ui-md text-text-3 hover:text-foreground"
                    aria-label={visibilityLabel}
                    aria-pressed={showNewPw}
                  >
                    {showNewPw ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
                  </button>
                </div>
              </Field>

              <Field label={t('profile.confirmPassword')} required>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </Field>

              {passwordError && <Notice kind="bad" title={passwordError} />}

              <div className="flex flex-wrap gap-2">
                <ActionButton type="submit" variant="primary" loading={passwordLoading}>
                  {passwordLoading ? t('common.saving') : t('profile.savePassword')}
                </ActionButton>
                <ActionButton onClick={cancelPasswordForm}>
                  {t('common.cancel')}
                </ActionButton>
              </div>
            </form>
          )}
        </div>
      </Panel>

      {/* 2FA */}
      <Panel
        title={t('profile.twofa')}
        hint={t('profile.twofaSubtitle')}
        actions={
          <StatusBadge
            kind={twofaKind(user.twofa_enabled)}
            label={user.twofa_enabled ? t('profile.twofaActivated') : t('profile.twofaDeactivated')}
          />
        }
      >
        <div className="space-y-4">
          {pinSuccess && <SuccessNote>{t('profile.pinSuccess')}</SuccessNote>}

          {user.twofa_enabled ? (
            <>
              <p className="text-[13px] text-text-2">{t('lmAdm.profile.twofaOnBody')}</p>

              {!showDeactivateForm && (
                <ActionButton variant="danger" onClick={handleDisable2FA}>
                  {t('profile.deactivate2fa')}
                </ActionButton>
              )}

              {/* Deactivation form */}
              {showDeactivateForm && (
                <form onSubmit={handleConfirmDeactivate} className="space-y-4 rounded-ui-md border border-neg/35 p-4">
                  <Field label={t('lmAdm.profile.deactivatePrompt')} required>
                    <Input
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={deactivatePin}
                      onChange={(e) => setDeactivatePin(sanitizePin(e.target.value))}
                      placeholder="000000"
                      autoFocus
                      className={PIN_INPUT_CLASS}
                    />
                  </Field>

                  {deactivateError && <Notice kind="bad" title={deactivateError} />}

                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      type="submit"
                      variant="danger"
                      disabled={deactivatePin.length !== 6}
                      loading={deactivateLoading}
                    >
                      {t('profile.confirmDeactivation')}
                    </ActionButton>
                    <ActionButton onClick={handleCancelDeactivate}>
                      {t('common.cancel')}
                    </ActionButton>
                  </div>
                </form>
              )}
            </>
          ) : (
            <>
              <p className="text-[13px] text-text-2">{t('lmAdm.profile.twofaOffBody')}</p>

              {!showTotpSetup && (
                <ActionButton variant="primary" onClick={() => void handleStartTotpSetup()}>
                  {t('profile.activate2fa')}
                </ActionButton>
              )}
            </>
          )}

          {/* TOTP Setup Flow */}
          {showTotpSetup && (
            <div className="space-y-4 rounded-ui-md border border-border bg-surface-2 p-4">
              {totpLoading && !totpQrCode ? (
                <div className="flex items-center justify-center py-8" role="status" aria-label={t('common.loading')}>
                  <Loader2 aria-hidden className="size-6 animate-spin text-text-3" />
                </div>
              ) : totpStep === 'scan' ? (
                <>
                  {/* Antes el error de generar sólo se dibujaba en el paso 2. */}
                  {pinError ? (
                    <Notice kind="bad" title={t('lmAdm.profile.qrFailedTitle')}>
                      {pinError}
                    </Notice>
                  ) : (
                    <Notice kind="info" title={t('lmAdm.profile.step1')} />
                  )}

                  {totpQrCode && (
                    <div className="flex justify-center">
                      {/* Blanco fijo a propósito: el QR necesita fondo claro
                          para leerse, también en tema oscuro. */}
                      <div className="rounded-ui-lg border border-border bg-white p-3 shadow-1">
                        <img src={totpQrCode} alt={t('lmAdm.profile.qrAlt')} width={180} height={180} className="block" />
                      </div>
                    </div>
                  )}

                  {totpSecret && (
                    <div className="space-y-1.5 text-center">
                      <p className="text-[12px] text-text-3">{t('lmAdm.profile.manualCode')}</p>
                      <div className="flex flex-wrap items-center justify-center gap-1">
                        <code className="select-all break-all rounded-ui-md border border-border bg-card px-2.5 py-1.5 font-mono text-[12px] tracking-wider text-foreground">
                          {totpSecret}
                        </code>
                        <button
                          type="button"
                          onClick={() => void handleCopyTotpSecret()}
                          className={ROW_ACTION_CLASS}
                          title={t('lmAdm.profile.copy')}
                          aria-label={t('lmAdm.profile.copy')}
                        >
                          {totpCopied
                            ? <Check aria-hidden className="size-4 text-pos" strokeWidth={2} />
                            : <Copy aria-hidden className="size-4" strokeWidth={1.75} />}
                        </button>
                      </div>
                      {totpCopied && <p role="status" className="text-[12px] text-pos">{t('lmAdm.profile.copied')}</p>}
                      {totpCopyFailed && <p role="alert" className="text-[12px] text-neg">{t('lmAdm.profile.copyFailed')}</p>}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      variant="primary"
                      disabled={!canContinueToVerify(totpSecret, pinError)}
                      onClick={() => { setTotpStep('verify'); setTotpToken(''); setPinError(''); }}
                    >
                      {t('lmAdm.profile.scanned')}
                    </ActionButton>
                    {pinError && (
                      <ActionButton onClick={() => void handleStartTotpSetup()}>
                        {t('lmAdm.retry')}
                      </ActionButton>
                    )}
                    <ActionButton onClick={() => { setShowTotpSetup(false); setPinError(''); }}>
                      {t('common.cancel')}
                    </ActionButton>
                  </div>
                </>
              ) : (
                <form onSubmit={handleVerifyTotp} className="space-y-4">
                  <Notice kind="info" title={t('lmAdm.profile.step2')} />

                  <Field label={t('lmAdm.profile.codeLabel')} hint={t('lmAdm.profile.codeChanges')} required>
                    <Input
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={totpToken}
                      onChange={(e) => setTotpToken(sanitizePin(e.target.value))}
                      placeholder="000000"
                      autoFocus
                      className={PIN_INPUT_CLASS}
                    />
                  </Field>

                  {pinError && <Notice kind="bad" title={pinError} />}

                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      type="submit"
                      variant="primary"
                      disabled={totpToken.length !== 6}
                      loading={totpLoading}
                    >
                      {t('lmAdm.profile.verifyActivate')}
                    </ActionButton>
                    <ActionButton onClick={() => { setTotpStep('scan'); setPinError(''); }}>
                      {t('lmAdm.profile.backToQr')}
                    </ActionButton>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
