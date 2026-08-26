// El alcance del módulo: sólo cuentas vinculadas al CRM (Kevin, 2026-08-26).
//
// Se prueba la FORMA de la consulta y no su resultado, por la misma razón que
// en pnl.test.ts: si el filtro se cae, no hay error. Hay unas cuentas de más
// dentro de los totales, que es indistinguible de un día con más actividad.

import { describe, it, expect } from 'vitest';
import { SQL_POSITIONS, SQL_ACCOUNTS } from './exposure';

describe('alcance: sólo cuentas del CRM', () => {
  it('pide las posiciones POR LOGIN para poder cruzarlas contra el CRM', () => {
    // El cruce vive en Postgres y esta consulta corre en el MySQL del bróker:
    // si MySQL ya devolviera los totales consolidados, las cuentas de prueba
    // vendrían sumadas adentro y serían imposibles de restar.
    expect(SQL_POSITIONS).toContain('p.Login AS login');
    expect(SQL_POSITIONS).toContain('GROUP BY p.Login');
  });

  it('trae el login de las cuentas con margen', () => {
    expect(SQL_ACCOUNTS).toContain('a.Login');
  });

  it('deja las demo afuera en las dos consultas', () => {
    expect(SQL_POSITIONS).toContain("NOT LIKE 'demo%'");
    expect(SQL_ACCOUNTS).toContain("NOT LIKE 'demo%'");
  });

  it('sólo mira cuentas con margen usado', () => {
    // `Margin = 0` significa "sin posiciones", no "en riesgo": incluirlas
    // llenaría la lista de cuentas que no pueden liquidarse.
    expect(SQL_ACCOUNTS).toContain('a.Margin > 0');
  });

  it('ya no pide COUNT(DISTINCT Login): cada fila ES una cuenta', () => {
    // Si volviera, las cuentas se contarían dos veces — una por la fila y otra
    // por el conteo que MySQL ya trajo sumado.
    expect(SQL_POSITIONS).not.toContain('COUNT(DISTINCT');
  });
});
