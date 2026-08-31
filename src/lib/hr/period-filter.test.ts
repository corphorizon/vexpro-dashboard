import { describe, it, expect } from 'vitest';
import {
  HR_PERIOD_PRESETS,
  esMesValido,
  mesAnterior,
  mesDePeriodo,
  periodIdsForPreset,
  type PeriodoRef,
} from './period-filter';

const periodos: PeriodoRef[] = [
  { id: 'p1', year: 2026, month: 1 },
  { id: 'p2', year: 2026, month: 2 },
  { id: 'p3', year: 2026, month: 3 },
  { id: 'p7', year: 2026, month: 7 },
  { id: 'p8', year: 2026, month: 8 },
  { id: 'q1-25', year: 2025, month: 3 },
];

describe('mes ancla', () => {
  it('valida la forma YYYY-MM y rechaza el resto', () => {
    expect(esMesValido('2026-08')).toBe(true);
    expect(esMesValido('2026-13')).toBe(false);
    expect(esMesValido('2026-00')).toBe(false);
    expect(esMesValido('2026-08-01')).toBe(false);
    expect(esMesValido('agosto')).toBe(false);
  });

  it('mesAnterior cruza el año sin romperse', () => {
    expect(mesAnterior(new Date('2026-08-15T00:00:00Z'))).toBe('2026-07');
    expect(mesAnterior(new Date('2026-01-03T00:00:00Z'))).toBe('2025-12');
    // El 1 del mes es el caso que rompía restando 30 días.
    expect(mesAnterior(new Date('2026-03-01T00:00:00Z'))).toBe('2026-02');
  });

  it('mesDePeriodo rellena el cero', () => {
    expect(mesDePeriodo({ year: 2026, month: 3 })).toBe('2026-03');
  });
});

describe('periodIdsForPreset', () => {
  it('total ignora el ancla y devuelve todo', () => {
    expect(periodIdsForPreset(periodos, 'total', '2026-08', [])).toHaveLength(periodos.length);
  });

  it('custom devuelve exactamente lo tildado', () => {
    expect(periodIdsForPreset(periodos, 'custom', '2026-08', ['p2', 'p8'])).toEqual(['p2', 'p8']);
  });

  it('month devuelve el período de ese mes, y nada si no existe', () => {
    expect(periodIdsForPreset(periodos, 'month', '2026-08', [])).toEqual(['p8']);
    expect(periodIdsForPreset(periodos, 'month', '2026-05', [])).toEqual([]);
  });

  it('quarter agrupa por trimestre calendario del mismo año', () => {
    expect(periodIdsForPreset(periodos, 'quarter', '2026-02', [])).toEqual(['p1', 'p2', 'p3']);
    expect(periodIdsForPreset(periodos, 'quarter', '2026-08', [])).toEqual(['p7', 'p8']);
  });

  it('semester parte en 1-6 y 7-12', () => {
    expect(periodIdsForPreset(periodos, 'semester', '2026-01', [])).toEqual(['p1', 'p2', 'p3']);
    expect(periodIdsForPreset(periodos, 'semester', '2026-12', [])).toEqual(['p7', 'p8']);
  });

  it('annual no se lleva los períodos de otro año', () => {
    expect(periodIdsForPreset(periodos, 'annual', '2026-08', [])).toEqual(['p1', 'p2', 'p3', 'p7', 'p8']);
    expect(periodIdsForPreset(periodos, 'annual', '2025-01', [])).toEqual(['q1-25']);
  });

  it('el trimestre se conoce aunque el mes ancla NO tenga período creado', () => {
    // Era el bug de la versión vieja: anclada en un period_id inexistente,
    // trimestre/semestre/año devolvían [] = "cero pesos" con cara de dato bueno.
    // No hay período de septiembre, pero su trimestre (jul-sep) sí trae p7/p8.
    expect(periodIdsForPreset(periodos, 'quarter', '2026-09', [])).toEqual(['p7', 'p8']);
    // Y un trimestre sin ningún período creado devuelve vacío por el motivo
    // correcto: no hay períodos, no "no supe cuál es el trimestre".
    expect(periodIdsForPreset(periodos, 'quarter', '2026-05', [])).toEqual([]);
  });

  it('un mes inválido no devuelve períodos de más (salvo total/custom)', () => {
    for (const preset of HR_PERIOD_PRESETS) {
      const ids = periodIdsForPreset(periodos, preset, 'basura', ['p1']);
      if (preset === 'total') expect(ids).toHaveLength(periodos.length);
      else if (preset === 'custom') expect(ids).toEqual(['p1']);
      else expect(ids).toEqual([]);
    }
  });
});
