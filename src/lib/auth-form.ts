// ─────────────────────────────────────────────────────────────────────────────
// auth-form — reglas puras de los formularios de acceso (login, 2FA, reset).
//
// POR QUÉ (2026-10-12, rediseño «Libro mayor» de las pantallas de acceso):
//   · El largo mínimo de contraseña (8) estaba escrito CUATRO veces: en
//     /reset-password (`password.length < 8`, `minLength={8}` y el texto
//     «Mínimo 8 caracteres») y en /api/auth/reset-password-confirm
//     (`newPassword.length < 8`). Una lista duplicada que se desincroniza en
//     silencio es el modo de falla nº 1 del repo (AGENTS.md): si el servidor
//     sube a 10 y la pantalla sigue diciendo 8, el usuario ve un «requisito
//     cumplido» que después falla. Ahora la constante vive acá y la usan las
//     dos puntas.
//   · El indicador de requisitos muestra SÓLO lo que el código valida de verdad
//     (largo mínimo y que coincidan). Inventar «una mayúscula, un número…» que
//     nadie verifica sería un check verde mentiroso.
//   · El mensaje de un login fallido (bloqueo / intentos restantes / genérico)
//     estaba armado inline en la página con plurales a mano. Extraído para
//     poder testearlo y traducirlo sin tocar la lógica: mismo orden de
//     decisión que antes (locked → attemptsLeft > 0 → error del servidor).
//   · `sanitizeOtp` reemplaza las cuatro copias de
//     `.replace(/\D/g, '').slice(0, 6)` (login, setup-2fa, reset-2fa, modal).
//
// DESCARTADO: medir «fortaleza» (zxcvbn o similar). Sería un requisito nuevo
// que el servidor no exige; si se quiere, se agrega primero en el servidor.
// ─────────────────────────────────────────────────────────────────────────────

/** Largo mínimo de contraseña. Lo valida también /api/auth/reset-password-confirm. */
export const PASSWORD_MIN_LENGTH = 8;

/** Dígitos de un código TOTP / de verificación por email. */
export const OTP_LENGTH = 6;

export type PasswordRequirementId = 'minLength' | 'match';

export interface PasswordRequirement {
  id: PasswordRequirementId;
  met: boolean;
}

/**
 * Estado de cada requisito, en el orden en que se muestran. `match` sólo se
 * da por cumplido cuando hay algo escrito en la confirmación: dos campos
 * vacíos «coinciden», pero un check verde antes de escribir sería ruido.
 */
export function passwordRequirements(password: string, confirm: string): PasswordRequirement[] {
  return [
    { id: 'minLength', met: password.length >= PASSWORD_MIN_LENGTH },
    { id: 'match', met: confirm.length > 0 && password === confirm },
  ];
}

/** El primer requisito que falla al enviar, o null. Mismo orden que validaba la página. */
export function passwordError(password: string, confirm: string): 'tooShort' | 'mismatch' | null {
  if (password.length < PASSWORD_MIN_LENGTH) return 'tooShort';
  if (password !== confirm) return 'mismatch';
  return null;
}

/** Sólo dígitos, como mucho OTP_LENGTH (pegar «123 456» o «123-456» funciona). */
export function sanitizeOtp(value: string): string {
  return value.replace(/\D/g, '').slice(0, OTP_LENGTH);
}

export interface LoginFailure {
  locked?: boolean;
  attemptsLeft?: number;
  error?: string;
}

type T = (key: string, params?: Record<string, string>) => string;

/**
 * Mensaje de un login fallido. El texto del servidor manda cuando existe
 * (bloqueo, rate limit): es el que sabe por qué. Los intentos restantes se
 * cuentan con número — «quedan 2» no es lo mismo que «credenciales inválidas».
 */
export function loginFailureMessage(result: LoginFailure, t: T): string {
  if (result.locked) return result.error ?? t('auth.login.locked');
  if (typeof result.attemptsLeft === 'number' && result.attemptsLeft > 0) {
    return result.attemptsLeft === 1
      ? t('auth.login.attemptsOne')
      : t('auth.login.attemptsMany', { n: String(result.attemptsLeft) });
  }
  return result.error ?? t('auth.login.invalid');
}
