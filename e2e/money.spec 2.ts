import { test, expect, type Page } from '@playwright/test';
import { computeDistributionChain } from '../src/lib/distribution';
import { round2 } from '../src/lib/utils';
import { login, fmtUSD, expectStatValue, openUploadSection } from './helpers';
import { E2E_RESERVE_PCT, E2E_PARTNERS } from './env';

// ─────────────────────────────────────────────────────────────────────────────
// MONEY flows — run against the seeded 'e2e-test' tenant (see global-setup).
// Serial: T3/T4 depend on the data entered in T1/T2. One shared logged-in
// page (login-gate is rate-limited, one login per run is plenty).
// ─────────────────────────────────────────────────────────────────────────────

const DEPOSIT_AMOUNT = 1000.5; // canal 'other'
const EXPENSE_AMOUNT = 200.25; // 'E2E gasto'
const BROKER_PNL = 5000;

// Expected distribution — same canonical formula the app uses
// (src/lib/distribution.ts :: computeDistributionChain).
const chain = computeDistributionChain([
  {
    periodId: 'p',
    brokerPnl: BROKER_PNL,
    other: 0,
    propFirmNetIncome: 0,
    investmentProfits: 0,
    totalExpenses: EXPENSE_AMOUNT,
    reservePct: E2E_RESERVE_PCT,
  },
]);
const EXPECTED = chain.get('p')!;
const EXPECTED_PARTNER_AMOUNTS = E2E_PARTNERS.map((p) =>
  round2(EXPECTED.montoDistribuir * p.percentage),
);

test.describe.serial('Flujos de dinero (tenant e2e-test)', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await login(page);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  // ── T1: Depósitos ────────────────────────────────────────────────────
  test('T1 — carga depósito manual (other) y total correcto', async () => {
    await page.goto('/upload');

    // Default tab is Depósitos: 4 fixed channel rows. 'other' → 'Otros Depósitos'.
    const row = page.getByRole('row', { name: /Otros Depósitos/ });
    await expect(row).toBeVisible({ timeout: 60_000 });

    await row.locator('input[type="number"]').fill(String(DEPOSIT_AMOUNT));
    await row.getByTitle('Guardar').click();

    // Success toast
    await expect(page.getByText('Depósito registrado').first()).toBeVisible();

    // Total row shows $1,000.50 (en-US, 2 decimals)
    const totalRow = page.getByRole('row', { name: /^Total/ });
    await expect(totalRow).toContainText(fmtUSD(DEPOSIT_AMOUNT));
  });

  // ── T2: Egresos ──────────────────────────────────────────────────────
  test('T2 — agrega egreso pendiente y lo marca pagado', async () => {
    await page.goto('/upload');
    await openUploadSection(page, 'Egresos');

    await page.getByPlaceholder('Concepto').fill('E2E gasto');
    await page.getByPlaceholder('Monto', { exact: true }).fill(String(EXPENSE_AMOUNT));
    // 'Pagado' left empty → whole amount stays pending.
    await page.getByRole('button', { name: 'Agregar', exact: true }).click();

    await expect(page.getByText('Egreso agregado').first()).toBeVisible();

    // Verify on /egresos: row exists, pending = $200.25, paid = $0.00
    await page.goto('/egresos');
    const expenseRow = page.getByRole('row', { name: /E2E gasto/ });
    await expect(expenseRow).toBeVisible({ timeout: 60_000 });
    await expect(expenseRow).toContainText(fmtUSD(EXPENSE_AMOUNT));

    await expectStatValue(page, 'Pendiente', fmtUSD(EXPENSE_AMOUNT));
    await expectStatValue(page, 'Pagado', fmtUSD(0));

    // Mark as paid (check button) → paid $200.25 / pending $0.00
    await page.getByRole('button', { name: 'Marcar E2E gasto como pagado' }).click();

    await expectStatValue(page, 'Pagado', fmtUSD(EXPENSE_AMOUNT));
    await expectStatValue(page, 'Pendiente', fmtUSD(0));
  });

  // ── T3: Ingresos + Socios ────────────────────────────────────────────
  test('T3 — carga broker P&L y verifica distribución a socios', async () => {
    await page.goto('/upload');
    await openUploadSection(page, 'Ingresos Operativos');

    const brokerInput = page.locator('label:has-text("Broker P&L") + input');
    await expect(brokerInput).toBeVisible({ timeout: 60_000 });
    await brokerInput.fill(String(BROKER_PNL));
    await page.getByRole('button', { name: 'Guardar Ingresos' }).click();

    await expect(page.getByText('Ingresos operativos guardados').first()).toBeVisible();

    // /socios — Monto a Distribuir = (5000 − 200.25) menos reserva 10%
    // computed with the app's own computeDistributionChain (round2 exact).
    await page.goto('/socios');
    await expectStatValue(page, 'Monto a Distribuir', fmtUSD(EXPECTED.montoDistribuir), {
      timeout: 60_000,
    });

    // 60/40 split per partner (round2 each)
    for (let i = 0; i < E2E_PARTNERS.length; i++) {
      const partnerRow = page.getByRole('row', { name: new RegExp(E2E_PARTNERS[i].name) }).first();
      await expect(partnerRow).toContainText(fmtUSD(EXPECTED_PARTNER_AMOUNTS[i]));
    }
  });

  // ── T4: Resumen General ──────────────────────────────────────────────
  test('T4 — resumen general coherente con depósitos y egresos', async () => {
    await page.goto('/resumen-general');
    await expectStatValue(page, 'Depósitos Totales', fmtUSD(DEPOSIT_AMOUNT), { timeout: 60_000 });
    await expectStatValue(page, 'Egresos Operativos', fmtUSD(EXPENSE_AMOUNT));
  });
});
