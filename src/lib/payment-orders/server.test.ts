// En qué período contable entra el egreso de una orden pagada
// (auditoría 2026-08, A3).
//
// Antes se elegía SIEMPRE el último período abierto: una orden marcada pagada
// con atraso mandaba su egreso al mes equivocado, con el agravante de que el
// egreso ya se fecha con `payment_date` — la fecha y el mes que la contabiliza
// decían cosas distintas.

import { describe, it, expect } from 'vitest';
import { pickExpensePeriod, type ExpensePeriodRow } from './server';

const P = (id: string, year: number, month: number, is_closed = false): ExpensePeriodRow => ({
  id, year, month, is_closed,
});

describe('pickExpensePeriod', () => {
  const periods = [P('mar', 2026, 3), P('abr', 2026, 4), P('may', 2026, 5)];

  it('usa el período de la FECHA DE PAGO, no el último abierto', () => {
    expect(pickExpensePeriod(periods, '2026-03-28')).toEqual({
      periodId: 'mar',
      warning: null,
    });
  });

  it('el mes del pago cerrado cae al último abierto CON warning', () => {
    const withClosed = [P('mar', 2026, 3, true), P('abr', 2026, 4), P('may', 2026, 5)];
    const got = pickExpensePeriod(withClosed, '2026-03-28');
    expect(got.periodId).toBe('may');
    expect(got.warning).toMatch(/marzo 2026/);
    expect(got.warning).toMatch(/cerrado/);
  });

  it('un mes de pago que no existe también avisa', () => {
    const got = pickExpensePeriod(periods, '2025-11-02');
    expect(got.periodId).toBe('may');
    expect(got.warning).toMatch(/no existe el período noviembre 2025/);
  });

  it('sin fecha de pago mantiene el comportamiento histórico (último abierto)', () => {
    expect(pickExpensePeriod(periods, null)).toEqual({ periodId: 'may', warning: null });
    expect(pickExpensePeriod(periods, '')).toEqual({ periodId: 'may', warning: null });
  });

  it('el último abierto compara año Y mes, no solo el mes', () => {
    const cross = [P('dic25', 2025, 12), P('ene26', 2026, 1)];
    expect(pickExpensePeriod(cross, null).periodId).toBe('ene26');
  });

  it('sin ningún período abierto no registra el egreso y lo dice', () => {
    const allClosed = [P('mar', 2026, 3, true), P('abr', 2026, 4, true)];
    const got = pickExpensePeriod(allClosed, '2026-03-28');
    expect(got.periodId).toBeNull();
    expect(got.warning).toMatch(/no hay un período abierto/);
  });

  it('el período del pago abierto gana aunque haya meses posteriores abiertos', () => {
    expect(pickExpensePeriod(periods, '2026-04-15').periodId).toBe('abr');
  });
});
