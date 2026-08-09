// ─────────────────────────────────────────────────────────────────────────────
// La campanita muestra lo que hay en la bandeja y marcar leído persiste.
//
// Se insertan las filas con service role (igual que el servidor en producción,
// donde el alta NUNCA viene del navegador) y se lee por la UI, que pasa por
// RLS con la sesión del usuario. Así el test cubre las dos mitades: que el
// emisor escriba donde corresponde y que la política deje leerlo.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { login } from './helpers';
import { loadEnvLocal } from './env';

const E2E_AUTH_USER = 'c96c5638-ea52-4212-95b3-8a90653f0d1b';
const E2E_COMPANY = '25940fa9-807d-4868-a49b-06498d46c2c0';

function admin() {
  const env = loadEnvLocal();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

test('la bandeja muestra los avisos y marcar leído persiste', async ({ page }) => {
  const db = admin();
  await db.from('notifications').delete().eq('user_id', E2E_AUTH_USER);
  await db.from('notifications').insert([
    {
      company_id: E2E_COMPANY, user_id: E2E_AUTH_USER,
      type: 'ledger.not_posted', severity: 'critical',
      params: { channel: 'Coinsbuy', date: '2026-08-09', reason: 'Ajuste fuera de rango.' },
      link: '/balances',
    },
    {
      company_id: E2E_COMPANY, user_id: E2E_AUTH_USER,
      type: 'order.pending', severity: 'high',
      params: { number: 'OP-2026-0007', amount: '1.500,00 USD', beneficiary: 'Proveedor SA' },
      link: '/ordenes-pago',
    },
  ]);

  await login(page);
  await page.waitForTimeout(2500);

  // El contador aparece sin recargar: el hook consulta al montar.
  const bell = page.getByRole('button', { name: /Notificaciones|notifications/i }).first();
  await expect(bell).toBeVisible();
  await expect(bell).toContainText('2');

  await bell.click();
  // El texto se arma en la UI desde type+params, así que ver el número de
  // orden prueba la interpolación completa.
  await expect(page.getByText('OP-2026-0007', { exact: false })).toBeVisible();
  await expect(page.getByText('Coinsbuy', { exact: false }).first()).toBeVisible();

  await page.getByRole('button', { name: /Marcar todo como leído|Mark all as read/i }).click();
  await page.waitForTimeout(1500);

  // Persistió en la base, no solo en pantalla.
  const { data } = await db
    .from('notifications')
    .select('read_at')
    .eq('user_id', E2E_AUTH_USER);
  expect(data?.every((r) => r.read_at !== null), 'quedaron avisos sin marcar').toBe(true);

  await db.from('notifications').delete().eq('user_id', E2E_AUTH_USER);
});
