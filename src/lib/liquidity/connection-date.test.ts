import { describe, it, expect } from 'vitest';
import { validarFechaConexion } from './connection-date';

describe('validarFechaConexion', () => {
  it('acepta el YYYY-MM-DD que manda un <input type="date">', () => {
    const r = validarFechaConexion('2026-03-15');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fecha.toISOString().slice(0, 10)).toBe('2026-03-15');
  });

  it('ancla el día a mediodía UTC y no a medianoche', () => {
    // El bug que evita: a las 00:00 UTC, un navegador en UTC-5 lee la fecha
    // como el día ANTERIOR. Si eso cae un día 1, el mes de conexión cambia y
    // el PnL arranca un mes antes sin que nadie lo haya pedido.
    const r = validarFechaConexion('2026-03-01');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fecha.getUTCHours()).toBe(12);
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
