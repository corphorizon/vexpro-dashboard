// ─────────────────────────────────────────────────────────────────────────────
// El guard de guardado de /comisiones (dueño, 2026-10-20, migración 132).
//
// Septiembre se cerró con grupos a medias: alguien guardó mientras el insumo
// del CRM no había llegado. Este test fija que eso sea IMPOSIBLE en un mes
// abierto, y —la mitad de los casos— que el guard NO estorbe donde no tiene
// que estorbar: mes cerrado, cache vieja, el PnL caído para quien sólo guarda
// net deposit.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import {
  edadDelCalculo,
  motivoBloqueoGuardado,
  type EstadoInsumoCrm,
  type InsumosQueGuarda,
} from './guardado-comisiones';

const LISTO: EstadoInsumoCrm = {
  usaAutomatico: true,
  cargando: false,
  refrescando: false,
  ndListo: true,
  pnlListo: true,
};

const GUARDADOS: Record<string, InsumosQueGuarda> = {
  'tab Equipos / fila ND': { nd: true, pnl: false },
  'filas PnL': { nd: false, pnl: true },
  'Guardar de Individual': { nd: true, pnl: true },
};

describe('motivoBloqueoGuardado — bloquea con el insumo a medio llegar', () => {
  for (const [nombre, guarda] of Object.entries(GUARDADOS)) {
    it(`${nombre}: fetch en curso → esperando`, () => {
      expect(motivoBloqueoGuardado({ ...LISTO, cargando: true, ndListo: false, pnlListo: false }, guarda)).toBe('esperando');
    });

    it(`${nombre}: «Actualizar» en curso → esperando, aunque los datos viejos estén`, () => {
      expect(motivoBloqueoGuardado({ ...LISTO, refrescando: true }, guarda)).toBe('esperando');
    });

    it(`${nombre}: todo falló → bloqueado`, () => {
      expect(motivoBloqueoGuardado({ ...LISTO, ndListo: false, pnlListo: false }, guarda)).not.toBeNull();
    });
  }

  it('ND caído bloquea lo que guarda ND', () => {
    expect(motivoBloqueoGuardado({ ...LISTO, ndListo: false }, GUARDADOS['tab Equipos / fila ND'])).toBe('sin-nd');
    expect(motivoBloqueoGuardado({ ...LISTO, ndListo: false }, GUARDADOS['Guardar de Individual'])).toBe('sin-nd');
  });

  it('PnL caído bloquea lo que guarda PnL', () => {
    expect(motivoBloqueoGuardado({ ...LISTO, pnlListo: false }, GUARDADOS['filas PnL'])).toBe('sin-pnl');
    expect(motivoBloqueoGuardado({ ...LISTO, pnlListo: false }, GUARDADOS['Guardar de Individual'])).toBe('sin-pnl');
  });
});

describe('motivoBloqueoGuardado — NO estorba donde no tiene que estorbar', () => {
  for (const [nombre, guarda] of Object.entries(GUARDADOS)) {
    it(`${nombre}: mes cerrado (lee congelado) → nunca bloquea, aunque no haya nada del CRM`, () => {
      const cerrado: EstadoInsumoCrm = {
        usaAutomatico: false, cargando: false, refrescando: false, ndListo: false, pnlListo: false,
      };
      expect(motivoBloqueoGuardado(cerrado, guarda)).toBeNull();
    });

    it(`${nombre}: insumo completo → deja guardar (la cache vieja es dato válido)`, () => {
      expect(motivoBloqueoGuardado(LISTO, guarda)).toBeNull();
    });
  }

  it('PnL caído NO bloquea lo que sólo guarda ND (dos grupos de gente distintos)', () => {
    expect(motivoBloqueoGuardado({ ...LISTO, pnlListo: false }, GUARDADOS['tab Equipos / fila ND'])).toBeNull();
  });

  it('ND caído NO bloquea lo que sólo guarda PnL', () => {
    expect(motivoBloqueoGuardado({ ...LISTO, ndListo: false }, GUARDADOS['filas PnL'])).toBeNull();
  });

  it('un botón que no guarda ningún insumo CRM no se bloquea', () => {
    expect(motivoBloqueoGuardado({ ...LISTO, cargando: true }, { nd: false, pnl: false })).toBeNull();
  });
});

describe('edadDelCalculo', () => {
  const T = Date.parse('2026-10-20T12:00:00Z');

  it('minutos, horas y días', () => {
    expect(edadDelCalculo('2026-10-20T11:30:00Z', T)).toEqual({ unidad: 'min', n: 30 });
    expect(edadDelCalculo('2026-10-20T09:35:00Z', T)).toEqual({ unidad: 'h', n: 2 });
    expect(edadDelCalculo('2026-10-17T12:00:00Z', T)).toEqual({ unidad: 'd', n: 3 });
  });

  it('menos de un minuto, o un reloj del cliente adelantado → «recién», nunca negativo', () => {
    expect(edadDelCalculo('2026-10-20T11:59:30Z', T)).toEqual({ unidad: 'recien', n: 0 });
    expect(edadDelCalculo('2026-10-20T12:05:00Z', T)).toEqual({ unidad: 'recien', n: 0 });
  });

  it('sin fecha o ilegible → null (no se inventa un «hace 0 min»)', () => {
    expect(edadDelCalculo(null, T)).toBeNull();
    expect(edadDelCalculo(undefined, T)).toBeNull();
    expect(edadDelCalculo('ayer', T)).toBeNull();
  });
});
