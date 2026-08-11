import { NextResponse } from 'next/server';
import { TWOFA_COOKIE, twofaCookieOptions } from '@/lib/auth/twofa-session';

// ---------------------------------------------------------------------------
// DELETE /api/auth/2fa-seal
//
// Borra el sello de verificación 2FA (cookie httpOnly, ver
// src/lib/auth/twofa-session.ts). Se llama en cada SIGNED_OUT — logout
// explícito, cierre por inactividad, expiración o signOut desde otra pestaña.
//
// Por qué importa: sin esto el sello sobrevive al logout en el navegador. En
// una máquina compartida, alguien con la contraseña de la víctima podría
// entrar sin PIN reutilizando el sello que quedó. No requiere sesión válida
// —justamente se llama cuando ya no la hay— y lo único que puede hacer es
// borrar una cookie propia: no hay nada que un atacante gane invocándola.
// ---------------------------------------------------------------------------
export async function DELETE() {
  const response = NextResponse.json({ success: true });
  response.cookies.set(TWOFA_COOKIE, '', { ...twofaCookieOptions(0), maxAge: 0 });
  return response;
}
