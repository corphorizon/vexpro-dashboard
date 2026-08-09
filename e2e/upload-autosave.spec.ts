// ─────────────────────────────────────────────────────────────────────────────
// El autosave de /upload NO puede comerse lo que el usuario está escribiendo.
//
// Bug reportado por Kevin (2026-08-09): tipear "12345" en un depósito guardaba
// "1". El debounce se armaba con la primera tecla y no se reiniciaba (dependía
// de `dirtySections`, que está memoizado y no cambia de identidad entre
// teclas), así que a los 3 s guardaba el prefijo y el re-sync re-hidrataba el
// input con lo guardado, borrando el resto.
//
// Este test tipea a ritmo humano (250 ms/tecla → 1 s de sobra por encima del
// debounce) y verifica que lo que persiste es el número COMPLETO.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { login } from './helpers';

test('un monto largo tipeado despacio se guarda entero', async ({ page }) => {
  await login(page);
  await page.goto('/upload');
  await page.waitForTimeout(3000);

  const input = page.locator('input[type="number"]').first();
  await input.click();
  await input.pressSequentially('12345', { delay: 250 });

  // Autosave (3 s tras la última tecla) + refresh.
  await page.waitForTimeout(6000);
  expect(await input.inputValue(), 'el autosave pisó el valor a medio tipear').toBe('12345');

  // Y quedó realmente en la base.
  await page.reload();
  await page.waitForTimeout(4000);
  expect(await page.locator('input[type="number"]').first().inputValue()).toBe('12345');
});
