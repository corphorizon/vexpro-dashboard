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

  // Anclado al canal por su etiqueta: "el primer input" cambiaba de fila
  // según cómo viniera ordenada la tabla, y tras recargar el assert podía
  // estar mirando otro canal.
  const input = page.getByRole('row', { name: /Coinsbuy/ }).locator('input[type="number"]');
  // Vaciar primero: pressSequentially AGREGA al valor existente, y si otro
  // spec dejó un monto cargado el resultado sería un número distinto (o
  // inválido, que en type=number se lee como cadena vacía).
  await input.fill('');
  await input.click();
  await input.pressSequentially('12345', { delay: 250 });

  // Hay que ESPERAR de verdad: el debounce dispara 3 s después de la última
  // tecla. Un poll sobre el input se cumpliría al instante (el valor local ya
  // está escrito) y recargaríamos antes de que el guardado salga.
  await page.waitForTimeout(7000);
  expect(await input.inputValue(), 'el autosave pisó el valor a medio tipear').toBe('12345');

  // Y sobrevive a recargar. Se espera con poll porque la pantalla pinta
  // primero desde el caché de arranque y revalida después (fase 4b): el
  // valor correcto puede tardar un instante en aparecer.
  await page.reload();
  await expect
    .poll(() => page.getByRole('row', { name: /Coinsbuy/ }).locator('input[type="number"]').inputValue(), {
      message: 'el monto no quedó guardado',
      timeout: 20_000,
    })
    .toBe('12345');
});
