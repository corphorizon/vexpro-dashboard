import { describe, it, expect } from 'vitest';
import { validarFechaConexion, formatFechaConexion } from './connection-date';

describe('validarFechaConexion', () => {
  it('acepta el YYYY-MM-DD que manda un <input type="date">', () => {
    const r = validarFechaConexion('2026-03-15');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fecha.toISOString().slice(0, 10)).toBe('2026-03-15');
  });

  it('ancla el día a las 00:00 UTC, no a mediodía', () => {
    // El bug que fija: con el ancla en 12:00, la cuenta 136773 conectada el
    // 06/03 daba -2.662,49 en marzo contra los -3.437,67 del MT5 Manager. Las
    // 17 operaciones que faltaban eran de esa madrugada, 02h y 03h. Medio día
    // de operaciones desaparecía sin ningún error de por medio.
    const r = validarFechaConexion('2026-03-06');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fecha.toISOString()).toBe('2026-03-06T00:00:00.000Z');
      expect(r.fecha.getUTCHours()).toBe(0);
    }
  });

  it('no corre el día aunque el navegador esté al oeste de UTC', () => {
    // La `Z` explícita es lo que lo garantiza: sin ella, el texto se
    // interpretaría en el huso local y un día 1 se volvería el último del mes
    // anterior.
    const r = validarFechaConexion('2026-03-01');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fecha.getUTCDate()).toBe(1);
      expect(r.fecha.getUTCMonth()).toBe(2); // marzo
    }
  });

  it('acepta un ISO completo', () => {
    const r = validarFechaConexion('2026-03-15T08:30:00.000Z');
    expect(r.ok).toBe(true);
  });

  it('rechaza el futuro', () => {
    const enUnMes = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const r = validarFechaConexion(enUnMes.toISOString().slice(0, 10));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('futuro');
  });

  it('tolera el desfase de reloj entre navegador y servidor', () => {
    // Hoy tiene que pasar siempre, aunque el reloj del cliente vaya unas horas
    // adelantado: si no, el caso normal —conectar una cuenta ahora— fallaría
    // de forma intermitente y sin explicación.
    const hoy = new Date().toISOString().slice(0, 10);
    expect(validarFechaConexion(hoy).ok).toBe(true);
  });

  it('rechaza fechas absurdamente viejas', () => {
    // Sin piso, un año mal tipeado hace que el calculador recorra dos siglos
    // de calendario y devuelva una tabla sin sentido.
    const r = validarFechaConexion('1900-01-01');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('2000');
  });

  it('rechaza basura, vacío y nulo con un mensaje mostrable', () => {
    for (const malo of ['', '   ', 'ayer', '2026-13-45', null, undefined, {}]) {
      const r = validarFechaConexion(malo);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });
});

describe('formatFechaConexion', () => {
  it('muestra el día guardado, no el del huso del navegador', () => {
    // `formatDate` del repo usa hora local: con la conexión a las 00:00 UTC,
    // un navegador en UTC-5 mostraría el 5 de marzo. La fecha de conexión es
    // un DÍA, así que se lee en el mismo huso en que se guardó.
    expect(formatFechaConexion('2026-03-06T00:00:00.000Z')).toBe('06/03/2026');
  });

  it('no se rompe con nulo, vacío ni basura', () => {
    expect(formatFechaConexion(null)).toBe('');
    expect(formatFechaConexion(undefined)).toBe('');
    expect(formatFechaConexion('')).toBe('');
    expect(formatFechaConexion('ayer')).toBe('');
  });
});
