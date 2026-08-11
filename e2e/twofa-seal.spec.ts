import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { login } from './helpers';
import { loadEnvLocal, E2E_COMPANY_SLUG, E2E_USER_EMAIL } from './env';

// ─────────────────────────────────────────────────────────────────────────────
// LA REGLA NUEVA, EN VIVO: sesión sin sello + twofa_enabled ⇒ rechazada.
//
// Reproduce exactamente el ataque que motivó el cambio: alguien con la
// contraseña correcta consigue una sesión válida de Supabase (POST directo a
// GoTrue con la anon key, que es pública) SIN pasar por el PIN. Esa sesión es
// idéntica a la del navegador salvo por una cosa: no lleva el sello firmado
// que sólo emite /api/auth/verify-2fa.
//
// Cómo se simula sin hablarle a GoTrue a mano: se inicia sesión normalmente
// (el usuario e2e no tiene 2FA), se BORRA la cookie del sello —dejando las
// cookies sb-* intactas, que es justo lo que tendría el atacante— y se
// habilita 2FA en la fila del usuario. Navegar entonces al dashboard debe
// terminar en /login.
//
// El estado se restaura SIEMPRE en el finally: si este test dejara
// twofa_enabled = true, el resto de la suite pediría PIN y fallaría entero.
// ─────────────────────────────────────────────────────────────────────────────

const TWOFA_COOKIE = 'fd_2fa';

function admin() {
  const env = loadEnvLocal();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function setTwofaEnabled(enabled: boolean): Promise<void> {
  const db = admin();
  const { data: company } = await db
    .from('companies')
    .select('id')
    .eq('slug', E2E_COMPANY_SLUG)
    .single();
  const { error } = await db
    .from('company_users')
    .update({ twofa_enabled: enabled })
    .eq('company_id', company!.id)
    .eq('email', E2E_USER_EMAIL);
  if (error) throw new Error(`No se pudo cambiar twofa_enabled: ${error.message}`);
}

test('una sesión sin sello no vale si el usuario tiene 2FA habilitado', async ({ page }) => {
  await login(page);

  // El login normal SÍ deja sello (usuario sin 2FA → lo emite login-gate).
  const cookiesAfterLogin = await page.context().cookies();
  expect(cookiesAfterLogin.some((c) => c.name === TWOFA_COOKIE)).toBe(true);

  try {
    // Sesión de Supabase válida, pero sin sello: la sesión del atacante.
    await page.context().clearCookies({ name: TWOFA_COOKIE });
    await setTwofaEnabled(true);

    await page.goto('/resumen-general', { waitUntil: 'domcontentloaded' });
    await page.waitForURL((url) => url.pathname.startsWith('/login'), { timeout: 30_000 });
    expect(page.url()).toContain('/login');
  } finally {
    await setTwofaEnabled(false);
  }
});

test('sin 2FA la sesión sigue entrando igual que siempre', async ({ page }) => {
  // Requisito innegociable 1: el cambio no puede tocar a quien no usa 2FA.
  // Además cubre la auto-curación: aun borrando el sello, un usuario sin 2FA
  // entra y se lleva uno nuevo emitido por el middleware.
  await login(page);
  await page.context().clearCookies({ name: TWOFA_COOKIE });

  await page.goto('/resumen-general', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/resumen-general/);

  const cookies = await page.context().cookies();
  expect(cookies.some((c) => c.name === TWOFA_COOKIE)).toBe(true);
});
