// ─────────────────────────────────────────────────────────────────────────────
// El superadmin en modo "viendo como" tiene que poder ADMINISTRAR, no solo
// mirar.
//
// Kevin (2026-08-09, empresa Horizon en producción) reportó dos cosas que se
// veían como bugs distintos y eran el mismo: en Balances no podía quitar los
// canales que estaban ni agregar nuevos, y en Carga de Datos las acciones no
// respondían. Un superadmin NO tiene fila en `company_users`, así que llega al
// cliente con `role='superadmin'`; cualquier gate escrito como
// `user.role === 'admin'` lo deja afuera y la UI directamente no dibuja el
// botón. Sin botón no hay error: "no pasa nada".
//
// Estos tests fijan el contrato: con el perfil de superadmin, Balances muestra
// la configuración de canales y el alta/baja funciona de punta a punta, y el
// detalle de ingresos se guarda.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { login, actAsSuperadminClient, openUploadSection } from './helpers';
import { loadEnvLocal } from './env';

const COMPANY = '25940fa9-807d-4868-a49b-06498d46c2c0';

function admin() {
  const env = loadEnvLocal();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

test('superadmin: Balances le ofrece administrar canales y ubicaciones', async ({ page }) => {
  const db = admin();
  await db.from('channel_configs').delete().eq('company_id', COMPANY);

  await login(page);
  // `next dev` compila /balances a demanda y el primer hit puede tardar más
  // que el timeout del expect — se precompila antes de mirar la UI.
  await page.request.get('/balances', { timeout: 120_000 });
  // El panel de configuración abre pidiendo canales, unidades y su reparto:
  // en `next dev` cada endpoint compila la primera vez que lo tocan y ese
  // arranque se come el timeout del expect.
  for (const url of ['/api/admin/channel-configs', '/api/admin/business-units', '/api/admin/location-units']) {
    await page.request.get(url, { timeout: 120_000 });
  }
  await actAsSuperadminClient(page, COMPANY);
  await page.goto('/balances');

  // ESTE es el bug: con `user.role === 'admin'` ninguno de los dos existía
  // para el superadmin, así que no había forma de quitar ni agregar canales.
  const configBtn = page.getByRole('button', { name: 'Configurar', exact: true });
  await expect(configBtn).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Unidades de negocio' })).toBeVisible();

  // Y el panel abre con la lista completa y el alta de canales.
  await configBtn.click();
  await expect(page.getByText('Configurar Balances por Canal')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Ocultar canal' }).first()).toBeVisible();
  await expect(page.getByPlaceholder(/^Nombre \(ej/)).toBeVisible();
});

test('ocultar un canal propio no le borra el nombre', async ({ page }) => {
  // `custom_label` omitido en el upsert se guardaba como null: cada toggle de
  // visibilidad dejaba al canal personalizado mostrándose como `custom_<uuid>`.
  const db = admin();
  await db.from('channel_configs').delete().eq('company_id', COMPANY);

  await login(page);
  await page.request.get('/balances', { timeout: 120_000 });
  // El panel de configuración abre pidiendo canales, unidades y su reparto:
  // en `next dev` cada endpoint compila la primera vez que lo tocan y ese
  // arranque se come el timeout del expect.
  for (const url of ['/api/admin/channel-configs', '/api/admin/business-units', '/api/admin/location-units']) {
    await page.request.get(url, { timeout: 120_000 });
  }
  await page.goto('/balances');
  await page.getByRole('button', { name: 'Configurar', exact: true }).click();
  await expect(page.getByText('Configurar Balances por Canal')).toBeVisible({ timeout: 30_000 });

  await page.getByPlaceholder(/^Nombre \(ej/).fill('Banco Superadmin');
  await page.getByRole('button', { name: /^Agregar$/ }).click();
  await expect(page.getByText('Canal creado')).toBeVisible({ timeout: 30_000 });

  const customRow = page
    .locator('div.rounded-lg.border')
    .filter({ hasText: 'Banco Superadmin' })
    .first();
  await customRow.getByRole('button', { name: 'Ocultar canal' }).click();

  await expect
    .poll(async () => {
      const { data } = await db
        .from('channel_configs')
        .select('custom_label,is_visible')
        .eq('company_id', COMPANY)
        .eq('is_custom', true)
        .maybeSingle();
      return `${data?.custom_label}/${data?.is_visible}`;
    }, { timeout: 30_000 })
    .toBe('Banco Superadmin/false');

  await db.from('channel_configs').delete().eq('company_id', COMPANY);
});

test('superadmin: editar una línea de ingreso la persiste', async ({ page }) => {
  const db = admin();
  const { data: period } = await db
    .from('periods').select('id').eq('company_id', COMPANY)
    .order('year', { ascending: false }).order('month', { ascending: false })
    .limit(1).single();
  // El caso exacto de Kevin: una fila cobrada a la que le falta el cliente.
  await db.rpc('replace_income_lines', {
    p_company_id: COMPANY,
    p_period_id: period!.id,
    p_lines: [
      { concept: 'Ofina Medellin', client: '', amount: 1300, received: 1300, pending: 0, sort_order: 0 },
    ],
  });

  await login(page);
  await actAsSuperadminClient(page, COMPANY);
  await page.goto('/upload');
  await openUploadSection(page, 'Ingresos Operativos');

  const row = page.locator('table tbody tr').first();
  await expect(row).toContainText('Ofina Medellin', { timeout: 30_000 });
  await row.getByRole('button', { name: 'Editar' }).click();
  await page.locator('table tbody tr').first().getByLabel('Cliente del ingreso').fill('Vex');
  await page.locator('table tbody tr').first().getByRole('button', { name: 'Guardar' }).click();

  await expect
    .poll(async () => {
      const { data } = await db
        .from('income_lines').select('client').eq('period_id', period!.id).maybeSingle();
      return data?.client ?? null;
    }, { timeout: 30_000 })
    .toBe('Vex');
});
