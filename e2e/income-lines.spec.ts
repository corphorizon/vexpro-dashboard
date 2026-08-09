// ─────────────────────────────────────────────────────────────────────────────
// Los ingresos por concepto se cargan desde la pantalla y el total que la
// cadena de socios reparte es lo COBRADO, no lo facturado.
//
// Ese invariante es el corazón del módulo: una factura emitida y no cobrada no
// es plata que exista para repartir. Si alguien "arregla" la materialización
// para que use el facturado, la distribución empieza a repartir dinero que
// todavía no entró y nadie lo nota hasta que falta en la caja.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { login } from './helpers';
import { loadEnvLocal } from './env';

const COMPANY = '25940fa9-807d-4868-a49b-06498d46c2c0';

function admin() {
  const env = loadEnvLocal();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

test('una factura sin cobrar suma al facturado pero no a lo distribuible', async ({ page }) => {
  const db = admin();
  const { data: period } = await db
    .from('periods').select('id').eq('company_id', COMPANY)
    .order('year', { ascending: false }).order('month', { ascending: false })
    .limit(1).single();
  await db.from('income_lines').delete().eq('period_id', period!.id);

  await login(page);
  await page.goto('/upload');
  await page.getByRole('button', { name: 'Ingresos Operativos', exact: true }).click();
  await page.waitForTimeout(2500);

  // Alta: facturado 5.000, cobrado 2.000 → por cobrar 3.000.
  // Selectores por nombre accesible: por índice se rompen en cuanto la
  // pantalla suma un campo.
  await page.getByRole('textbox', { name: 'Concepto del ingreso' }).fill('Consultoría E2E');
  await page.getByRole('textbox', { name: 'Cliente del ingreso' }).fill('Cliente E2E');
  await page.getByRole('spinbutton', { name: 'Monto facturado' }).fill('5000');
  await page.getByRole('spinbutton', { name: 'Monto cobrado' }).fill('2000');
  await page.getByRole('button', { name: 'Agregar', exact: true }).click();

  await expect(page.getByText('Consultoría E2E')).toBeVisible({ timeout: 15_000 });

  await expect.poll(async () => {
    const { data } = await db
      .from('income_lines').select('amount, received, pending').eq('period_id', period!.id);
    return data?.length ?? 0;
  }, { timeout: 15_000 }).toBe(1);

  const { data: lines } = await db
    .from('income_lines').select('amount, received, pending').eq('period_id', period!.id);
  expect(Number(lines![0].amount)).toBe(5000);
  expect(Number(lines![0].received)).toBe(2000);

  // Lo que la cadena reparte es SOLO lo cobrado.
  const { data: oi } = await db
    .from('operating_income').select('other').eq('period_id', period!.id).single();
  expect(Number(oi!.other), 'la cadena estaría repartiendo plata no cobrada').toBe(2000);

  await db.from('income_lines').delete().eq('period_id', period!.id);
});
