// ─────────────────────────────────────────────────────────────────────────────
// huellaDeEgresosManuales — el registro ÚNICO de la huella del período que
// comparan el servidor (POST /api/admin/expenses) y /upload.
//
// Se testea pura porque la consumen DOS puntas que tienen que dar idéntico:
// si divergen, o todo guardado da 409 (falso conflicto) o ninguno lo da y
// vuelve el pisón silencioso del 2026-10-08 (Horizon, $6,000 perdidos).
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import {
  huellaDeEgresosManuales,
  mismaHuella,
  parsearHuella,
  mensajeConflicto,
} from './huella-periodo';

describe('huellaDeEgresosManuales', () => {
  it('sin filas → count 0 y maxUpdatedAt null (no hay, no "no sé")', () => {
    expect(huellaDeEgresosManuales([])).toEqual({ count: 0, maxUpdatedAt: null });
  });

  it('las filas de órdenes de pago NO cuentan (las administra tesorería)', () => {
    expect(
      huellaDeEgresosManuales([
        { payment_order_id: '11111111-1111-1111-1111-111111111111', updated_at: '2026-10-08T15:00:00+00:00' },
        { payment_order_id: null, updated_at: '2026-10-08T10:00:00+00:00' },
      ]),
    ).toEqual({ count: 1, maxUpdatedAt: '2026-10-08T10:00:00+00:00' });
  });

  it('solo filas de OP → igual que vacío', () => {
    expect(
      huellaDeEgresosManuales([
        { payment_order_id: '11111111-1111-1111-1111-111111111111', updated_at: '2026-10-08T15:00:00+00:00' },
      ]),
    ).toEqual({ count: 0, maxUpdatedAt: null });
  });

  it('payment_order_id ausente o "" cuenta como manual (mismo criterio que la RPC)', () => {
    expect(
      huellaDeEgresosManuales([
        { updated_at: '2026-10-08T10:00:00+00:00' },
        { payment_order_id: '', updated_at: '2026-10-08T11:00:00+00:00' },
      ]),
    ).toEqual({ count: 2, maxUpdatedAt: '2026-10-08T11:00:00+00:00' });
  });

  it('updated_at faltante: la fila cuenta, pero no aporta al máximo', () => {
    expect(
      huellaDeEgresosManuales([
        { payment_order_id: null },
        { payment_order_id: null, updated_at: null },
        { payment_order_id: null, updated_at: '2026-10-08T09:00:00+00:00' },
      ]),
    ).toEqual({ count: 3, maxUpdatedAt: '2026-10-08T09:00:00+00:00' });
  });

  it('ninguna fila trae updated_at → maxUpdatedAt null, count real', () => {
    expect(huellaDeEgresosManuales([{ payment_order_id: null }, {}])).toEqual({
      count: 2,
      maxUpdatedAt: null,
    });
  });

  it('máximo correcto sin importar el orden de las filas', () => {
    expect(
      huellaDeEgresosManuales([
        { updated_at: '2026-10-08T12:00:00+00:00' },
        { updated_at: '2026-10-08T14:30:00+00:00' },
        { updated_at: '2026-09-30T23:59:59+00:00' },
      ]).maxUpdatedAt,
    ).toBe('2026-10-08T14:30:00+00:00');
  });

  it('fracción recortada por Postgres: el orden de strings sigue siendo el temporal', () => {
    // Postgres omite ceros finales: .1 / .12 / sin fracción conviven.
    expect(
      huellaDeEgresosManuales([
        { updated_at: '2026-10-08T14:03:22+00:00' },
        { updated_at: '2026-10-08T14:03:22.12+00:00' },
        { updated_at: '2026-10-08T14:03:22.1+00:00' },
      ]).maxUpdatedAt,
    ).toBe('2026-10-08T14:03:22.12+00:00');
  });
});

describe('mismaHuella', () => {
  const base = { count: 3, maxUpdatedAt: '2026-10-08T10:00:00+00:00' };

  it('idénticas → true', () => {
    expect(mismaHuella(base, { ...base })).toBe(true);
    expect(mismaHuella({ count: 0, maxUpdatedAt: null }, { count: 0, maxUpdatedAt: null })).toBe(true);
  });

  it('otra pestaña agregó un egreso → false', () => {
    expect(mismaHuella({ ...base, count: 4 }, base)).toBe(false);
  });

  it('otra pestaña guardó sin cambiar el count (borró una, agregó otra) → false', () => {
    expect(mismaHuella({ ...base, maxUpdatedAt: '2026-10-08T10:05:00+00:00' }, base)).toBe(false);
  });

  it('null no es igual a una fecha', () => {
    expect(mismaHuella({ count: 3, maxUpdatedAt: null }, base)).toBe(false);
  });
});

describe('parsearHuella', () => {
  it('forma válida → la huella', () => {
    expect(parsearHuella({ count: 2, maxUpdatedAt: '2026-10-08T10:00:00+00:00' })).toEqual({
      count: 2,
      maxUpdatedAt: '2026-10-08T10:00:00+00:00',
    });
    expect(parsearHuella({ count: 0, maxUpdatedAt: null })).toEqual({ count: 0, maxUpdatedAt: null });
  });

  it('formas rotas → null (la route responde 400, nunca guarda sin guard)', () => {
    expect(parsearHuella(null)).toBeNull();
    expect(parsearHuella(undefined)).toBeNull();
    expect(parsearHuella('3')).toBeNull();
    expect(parsearHuella({ count: '3', maxUpdatedAt: null })).toBeNull();
    expect(parsearHuella({ count: -1, maxUpdatedAt: null })).toBeNull();
    expect(parsearHuella({ count: 1.5, maxUpdatedAt: null })).toBeNull();
    expect(parsearHuella({ count: 1, maxUpdatedAt: 123 })).toBeNull();
    // maxUpdatedAt ausente no es lo mismo que null: falta el dato.
    expect(parsearHuella({ count: 1 })).toBeNull();
  });
});

describe('mensajeConflicto', () => {
  it('lleva los números reales de las dos puntas', () => {
    const msg = mensajeConflicto(
      { count: 14, maxUpdatedAt: '2026-10-08T15:00:00+00:00' },
      { count: 12, maxUpdatedAt: '2026-10-08T10:00:00+00:00' },
    );
    expect(msg).toContain('ahora tiene 14 egresos manuales');
    expect(msg).toContain('esta pantalla partió de 12');
    expect(msg).toContain('Recargá la página');
  });

  it('con el mismo count dice que se modificaron, no "tiene 3; partió de 3"', () => {
    const msg = mensajeConflicto(
      { count: 3, maxUpdatedAt: '2026-10-08T15:00:00+00:00' },
      { count: 3, maxUpdatedAt: '2026-10-08T10:00:00+00:00' },
    );
    expect(msg).toContain('se modificaron egresos desde otra pantalla');
    expect(msg).toContain('sigue habiendo 3');
    expect(msg).toContain('Recargá la página');
  });
});
