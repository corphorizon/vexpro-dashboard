// ─────────────────────────────────────────────────────────────────────────────
// profile-view — decisiones puras de /perfil («Libro mayor», 2026-10-12).
//
// POR QUÉ: dos fallos que no daban error.
//   1. Guardar el nombre decía «Guardado» ANTES de saber nada: `updateUser`
//      no se esperaba y, además, se traga los errores (lib/auth-context.tsx
//      sólo hace console.error y return — fuera de esta tanda tocarlo). Lo
//      único verificable desde la pantalla es si, al terminar, el usuario de
//      la sesión tiene el nombre nuevo: `nameSaveOutcome` compara lo pedido
//      contra lo que quedó. Si no coincide, «no se pudo confirmar», nunca
//      «Guardado».
//   2. Activar 2FA: si generar el QR fallaba, el error se guardaba en el
//      estado pero sólo se dibujaba en el paso 2; el paso 1 quedaba sin QR,
//      sin código y sin aviso, con «Ya lo escaneé» habilitado.
//      `canContinueToVerify` exige un secreto real.
// ─────────────────────────────────────────────────────────────────────────────

/** Sólo dígitos, máximo 6 (código TOTP). Antes inline, dos copias. */
export function sanitizePin(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6);
}

export type NameSaveOutcome = 'idle' | 'saved' | 'unconfirmed';

/**
 * `expected` = el nombre que se pidió guardar (null si no hay guardado en
 * curso). `actual` = el nombre de la sesión DESPUÉS de esperar a updateUser.
 */
export function nameSaveOutcome(expected: string | null, actual: string | null | undefined): NameSaveOutcome {
  if (expected == null) return 'idle';
  return (actual ?? '').trim() === expected.trim() ? 'saved' : 'unconfirmed';
}

/** El paso «Ya lo escaneé» sólo tiene sentido con un secreto generado y sin error. */
export function canContinueToVerify(secret: string, error: string): boolean {
  return secret.trim().length > 0 && error === '';
}
