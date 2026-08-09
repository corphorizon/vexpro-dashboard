// ─────────────────────────────────────────────────────────────────────────────
// El shell del dashboard NO debe tener dos barras de scroll.
//
// El diseño es: <html>/<body> a la altura exacta del viewport, la barra
// lateral fija a un costado y SOLO el <main> scrolleando por dentro. Cuando el
// documento entero también scrollea, al bajar sube el shell completo y aparece
// una franja en blanco bajo la barra lateral — que es como se reportó el bug.
//
// La causa fue sutil y volverá si nadie la fija: los inputs de archivo llevan
// `sr-only` (position:absolute), y sin `relative` en el <main> su contenedor de
// bloque pasa a ser el <body>, así que ESCAPAN del overflow y estiran el
// documento. Hay inputs así en 9 pantallas, por eso el test barre varias.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { login } from './helpers';

const ROUTES = ['/ordenes-pago', '/upload', '/egresos', '/socios', '/rrhh', '/finanzas/reportes'];

test('ninguna pantalla estira el documento más allá del viewport', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1880, height: 960 });

  for (const route of ROUTES) {
    await page.goto(route);
    await page.waitForTimeout(2000);
    const m = await page.evaluate(() => ({
      docScrollH: document.documentElement.scrollHeight,
      vh: window.innerHeight,
    }));
    expect(m.docScrollH, `${route} estira el documento (segunda barra de scroll)`)
      .toBeLessThanOrEqual(m.vh + 2);
  }
});
