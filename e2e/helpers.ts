import { expect, type Page } from '@playwright/test';
import { E2E_USER_EMAIL, getE2EPassword } from './env';

// ─── Login ───────────────────────────────────────────────────────────────────
// Custom auth: /login → login-gate → supabase.auth.signInWithPassword.
// NEXT_PUBLIC_DEV_SKIP_2FA=true bypasses the 2FA redirect on localhost.
// Pre-compile the routes the specs visit. `next dev` compiles on demand and
// the first hit of a route can trigger full-page reloads (Fast Refresh) or
// transient 500s ("Manifest file is empty") that reset in-progress forms.
// Hitting every route until it answers 200 up-front removes that flakiness.
export async function warmUpRoutes(page: Page): Promise<void> {
  const routes = ['/login', '/upload', '/egresos', '/socios', '/resumen-general', '/'];
  for (const route of routes) {
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        const res = await page.request.get(route, { timeout: 30_000 });
        if (res.ok()) break;
      } catch {
        // dev server mid-recompile — retry
      }
      if (Date.now() > deadline) throw new Error(`warm-up: ${route} never answered 200`);
      await page.waitForTimeout(1_000);
    }
  }
}

export async function login(page: Page): Promise<void> {
  await warmUpRoutes(page);
  // Retry loop: on a cold `next dev` the first compile can trigger full-page
  // reloads that reset the form mid-submit, so a single attempt is flaky.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await page.goto('/login', { waitUntil: 'domcontentloaded' });
      // The login page performs a one-shot reload a couple of seconds after
      // first load (dev only). Typing before it lands gets wiped, so let it
      // pass before touching the form.
      await page.waitForTimeout(4_000);
      await page.locator('#email').fill(E2E_USER_EMAIL);
      await page.locator('#password').fill(getE2EPassword());
      // If a late reload wiped the fields, refill before submitting.
      await page.waitForTimeout(750);
      if ((await page.locator('#email').inputValue().catch(() => '')) !== E2E_USER_EMAIL) {
        await page.locator('#email').fill(E2E_USER_EMAIL);
        await page.locator('#password').fill(getE2EPassword());
      }
      await page.getByRole('button', { name: 'Iniciar sesión' }).click();
      // router.push('/') → dashboard dispatcher. Anything not /login is fine.
      await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 });
      // Wait until the dashboard shell actually rendered (sidebar shows the
      // Finanzas group for our all-modules admin).
      await expect(page.getByText('Finanzas').first()).toBeVisible({ timeout: 60_000 });
      return;
    } catch (err) {
      lastError = err;
      // Only the error box INSIDE the form counts — Next's route announcer
      // is also role=alert and would false-positive here.
      const alert = await page
        .locator('form [role="alert"]')
        .allTextContents()
        .catch(() => [] as string[]);
      const realError = alert.map((t) => t.trim()).filter(Boolean);
      if (realError.length > 0) {
        throw new Error(`Login rejected: ${realError.join(' | ')}`);
      }
      console.log(`[login] attempt ${attempt} did not land on dashboard, retrying…`);
    }
  }
  throw lastError;
}

// ─── Money formatting (mirror of src/lib/utils.formatCurrency) ──────────────
export function fmtUSD(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

// ─── StatCard value lookup ──────────────────────────────────────────────────
// StatCard (src/components/ui/stat-card.tsx) renders:
//   <div class="min-w-0 flex-1"><div>{label}</div><p>{value}</p>...</div>
// The app revalidates in the background (SWR cache), so assert with polling:
// the value <p> of the card whose label matches must eventually equal `value`.
export async function expectStatValue(
  page: Page,
  label: string | RegExp,
  value: string,
  opts: { timeout?: number } = {},
): Promise<void> {
  const card = page
    .locator('div.min-w-0.flex-1')
    .filter({ hasText: label })
    .first();
  await expect(card.locator('p').first()).toHaveText(value, {
    timeout: opts.timeout ?? 30_000,
  });
}

// Upload page section tabs are buttons in the tab strip (the sidebar has
// links with the same names — role=button disambiguates).
export async function openUploadSection(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click();
}

// ─── Superadmin en modo "viendo como" ────────────────────────────────────────
// Los superadmins reales viven en `platform_users` de la base compartida y sus
// credenciales no se usan en los tests. Lo que SÍ se puede reproducir sin
// tocar la base es el lado cliente, que es donde estaban los bugs: el perfil
// se resuelve `company_users` → `platform_users`, así que devolvemos [] en la
// primera y una fila de plataforma en la segunda. El resultado es un `user`
// con role='superadmin', is_superadmin=true y company_id=null — exactamente
// lo que ve la UI de Kevin. El servidor sigue autenticando al admin real.
export async function actAsSuperadminClient(page: Page, companyId: string): Promise<void> {
  await page.route('**/rest/v1/company_users*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/rest/v1/platform_users*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'e2e-platform-user',
          user_id: 'e2e-platform-user',
          email: 'e2e-superadmin@e2e-test.local',
          name: 'E2E Superadmin',
          twofa_enabled: true,
          force_2fa_setup: false,
        },
      ]),
    });
  });
  await page.addInitScript((cid) => {
    localStorage.setItem('horizon.superadmin.activeCompanyId', cid as string);
  }, companyId);
}
