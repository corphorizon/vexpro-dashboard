// ─────────────────────────────────────────────────────────────────────────────
// EL BUG DEL DÍA 1
//
// `buildReportData` acepta `referenceDate` para fijar «este mes» / «el mes
// anterior», y los TRES llamadores lo omitían: se quedaban con el default
// `new Date()` = HOY. El 1 de septiembre a las 00:05 UTC el cron diario informa
// el 31 de agosto, pero «este mes» resolvía a SEPTIEMBRE —cinco minutos de
// vida—, así que los KPI del mes salían en casi cero justo en el correo del
// cierre de mes. El mensual, que corre el mismo día y cuyo informe ES un mes,
// tenía el mismo problema.
//
// La referencia correcta es el último día que el informe CUBRE. Estos tests
// fijan las tres cadencias con la fecha real del incidente.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { referenceDateFor } from './data';
import { previousDayRange, previousWeekRange, previousMonthRange } from './send';

/** Mes (1-12) contra el que `buildReportData` resolvería «este mes». */
function contextMonth(to: string): { year: number; month: number } {
  const d = referenceDateFor(to);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

describe('referenceDateFor', () => {
  it('el mes del informe es el del último día que cubre, no el de hoy', () => {
    expect(contextMonth('2026-08-31')).toEqual({ year: 2026, month: 8 });
    expect(contextMonth('2026-09-01')).toEqual({ year: 2026, month: 9 });
  });

  it('cruza el fin de año sin depender de la zona local', () => {
    expect(contextMonth('2025-12-31')).toEqual({ year: 2025, month: 12 });
    expect(contextMonth('2026-01-01')).toEqual({ year: 2026, month: 1 });
  });

  it('una fecha ilegible NO tira: cae a hoy, que es el comportamiento viejo', () => {
    expect(referenceDateFor('no-es-una-fecha').getTime()).not.toBeNaN();
  });
});

describe('cada cron reporta el mes del que habla', () => {
  // 2026-09-01 00:05 UTC: el momento exacto del bug.
  const day1 = new Date('2026-09-01T00:05:00Z');

  it('DIARIO del día 1: informa el 31/08 y su contexto es AGOSTO', () => {
    const range = previousDayRange(day1);
    expect(range).toEqual({ from: '2026-08-31', to: '2026-08-31' });
    // Éste es el bug: sin referenceDate el contexto era septiembre.
    expect(contextMonth(range.to)).toEqual({ year: 2026, month: 8 });
  });

  it('MENSUAL del día 1: informa agosto entero y su contexto es AGOSTO', () => {
    const range = previousMonthRange(day1);
    expect(range).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(contextMonth(range.to)).toEqual({ year: 2026, month: 8 });
  });

  it('SEMANAL a caballo de dos meses: el contexto es el mes que CIERRA', () => {
    // Lunes 2026-09-07 00:05 UTC → semana 31/08 → 06/09.
    const range = previousWeekRange(new Date('2026-09-07T00:05:00Z'));
    expect(range).toEqual({ from: '2026-08-31', to: '2026-09-06' });
    expect(contextMonth(range.to)).toEqual({ year: 2026, month: 9 });
  });

  it('un día cualquiera del mes no cambia de contexto', () => {
    const range = previousDayRange(new Date('2026-08-15T00:05:00Z'));
    expect(range).toEqual({ from: '2026-08-14', to: '2026-08-14' });
    expect(contextMonth(range.to)).toEqual({ year: 2026, month: 8 });
  });
});
