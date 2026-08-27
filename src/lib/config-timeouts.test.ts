// Los techos de tiempo del arranque tienen que ser DISTINGUIBLES entre sí.
//
// El caso real: `LOCK_HOLD_CEILING_MS` del lock de auth valía 15_000, el mismo
// número EXACTO que `LOAD_TIMEOUT_MS`. Cuando reventaba el lock, el usuario
// veía "La carga tardó demasiado" —el mismo mensaje, al mismo tiempo, que un
// fallo real de datos— y en telemetría los dos modos de falla eran el mismo
// evento. Nunca supimos cuántos arranques fallidos eran en realidad un refresh
// de token colgado.
//
// Este test no valida "buenos" valores: valida que nadie los vuelva a hacer
// coincidir sin darse cuenta.

import { describe, it, expect } from 'vitest';
import {
  LOAD_BOOTSTRAP_TIMEOUT_MS,
  LOAD_TIMEOUT_MS,
  LOAD_MAX_RETRIES,
  LOAD_WATCHDOG_MS,
  LOAD_SLOW_HINT_MS,
  AUTH_LOCK_HOLD_CEILING_MS,
} from './config';

describe('presupuesto de tiempo del arranque', () => {
  it('el techo del lock de auth NO coincide con ningún timeout de carga', () => {
    expect(AUTH_LOCK_HOLD_CEILING_MS).not.toBe(LOAD_TIMEOUT_MS);
    expect(AUTH_LOCK_HOLD_CEILING_MS).not.toBe(LOAD_BOOTSTRAP_TIMEOUT_MS);
    expect(AUTH_LOCK_HOLD_CEILING_MS).not.toBe(LOAD_WATCHDOG_MS);
  });

  it('los cuatro techos son todos distintos', () => {
    const techos = [
      LOAD_BOOTSTRAP_TIMEOUT_MS,
      LOAD_TIMEOUT_MS,
      LOAD_WATCHDOG_MS,
      AUTH_LOCK_HOLD_CEILING_MS,
    ];
    expect(new Set(techos).size).toBe(techos.length);
  });

  it('el peor caso visible baja de los 31,5s que medimos', () => {
    // bootstrap (1 intento) + fallback (LOAD_MAX_RETRIES intentos) + 1,5s de
    // espera entre reintentos del fallback.
    const esperaEntreIntentos = 1_500 * Math.max(0, LOAD_MAX_RETRIES - 1);
    const peorCaso =
      LOAD_BOOTSTRAP_TIMEOUT_MS + LOAD_TIMEOUT_MS * LOAD_MAX_RETRIES + esperaEntreIntentos;
    expect(peorCaso).toBeLessThan(31_500);
  });

  it('el watchdog es la última red: cubre el peor caso completo', () => {
    const esperaEntreIntentos = 1_500 * Math.max(0, LOAD_MAX_RETRIES - 1);
    const peorCaso =
      LOAD_BOOTSTRAP_TIMEOUT_MS + LOAD_TIMEOUT_MS * LOAD_MAX_RETRIES + esperaEntreIntentos;
    expect(LOAD_WATCHDOG_MS).toBeGreaterThan(peorCaso);
  });

  it('el aviso de "está tardando" llega antes que cualquier timeout', () => {
    expect(LOAD_SLOW_HINT_MS).toBeLessThan(LOAD_TIMEOUT_MS);
    expect(LOAD_SLOW_HINT_MS).toBeLessThan(LOAD_BOOTSTRAP_TIMEOUT_MS);
  });
});
