// Lo que estas pruebas protegen no es que las reglas se evalúen bien —eso lo
// hace `rules.test.ts`— sino que NINGUNA regla del reglamento desaparezca del
// informe. Una regla que no aparece se lee como "no aplica", y la diferencia
// entre "no aplica" y "nadie la miró" es la única que importa cuando alguien
// firma un pago.

import { describe, it, expect } from 'vitest';
import { evaluateWithdrawal, type PropfirmWithdrawal } from './propfirm-auto';
import { PROGRAM_RULES, rulesForProgram } from './programs';
import type { Trade } from './types';

const retiro = (programName: string): PropfirmWithdrawal => ({
  withdrawId: 'w1', login: 1, username: 'x', userEmail: null,
  programName, requestedAmount: 100,
  requestedDate: new Date('2026-08-20T00:00:00Z'),
});

/**
 * `index` es la POSICIÓN en el array, desde cero — `ruleGrid` hace
 * `trades[t.index]`. Numerarlas desde 1 acá reventaba el motor, que es
 * exactamente el mismo tropiezo que tuvo el cargador desde MT5.
 */
const trade = (i: number, over: Partial<Trade> = {}): Trade => {
  // Un día distinto por operación: así no se solapan y el grid no salta por
  // culpa de los datos de prueba en lugar de por lo que se está probando.
  const dia = String(1 + i).padStart(2, '0');
  return {
    index: i, position: 1000 + i, symbol: 'EURUSD', type: 'buy', volume: 1,
    openPrice: 1, closePrice: 1, sl: null, tp: null,
    openTime: new Date(`2026-07-${dia}T10:00:00Z`),
    closeTime: new Date(`2026-07-${dia}T11:00:00Z`),
    commission: 0, swap: 0, profit: 10, durationMinutes: 60, ...over,
  };
};

const trades = Array.from({ length: 10 }, (_, i) => trade(i));

/** Un ciclo ya resuelto, para no tener que hablar con MT5 en las pruebas. */
const ciclo = (t: Trade[] = trades) => ({
  trades: t, startedAt: new Date('2026-06-30T00:00:00Z'),
  startedBy: 'creacion' as const, excludedFromPreviousCycles: 0,
});

describe('ninguna regla del reglamento desaparece', () => {
  for (const p of PROGRAM_RULES) {
    it(`${p.label}: informa TODAS las reglas declaradas`, () => {
      const r = evaluateWithdrawal(retiro(p.orionNames[0]), ciclo());
      const informadas = new Set(r.checks.map((c) => c.id));
      for (const spec of p.rules) {
        expect(informadas.has(spec.id), `falta ${spec.id} en ${p.label}`).toBe(true);
      }
    });

    it(`${p.label}: lo no comprobado se marca, nunca se da por cumplido`, () => {
      const r = evaluateWithdrawal(retiro(p.orionNames[0]), ciclo());
      for (const c of r.checks) {
        if (c.status === 'unverifiable') expect(c.whyNot).toBeTruthy();
        // Un `pass` sin haber mirado nada sería la mentira peligrosa.
        expect(['pass', 'fail', 'unverifiable']).toContain(c.status);
      }
    });
  }
});

describe('cada programa aplica SU reglamento', () => {
  it('X12 no arrastra las reglas de los demás', () => {
    // El programa se vende como "elimina casi todas las restricciones": grid,
    // martingala y hedging están permitidos, y no hay consistencia ni 5 min.
    const x12 = rulesForProgram('LEVERAGE X12')!;
    const ids = new Set(x12.rules.map((r) => r.id));
    expect(ids.has('grid')).toBe(false);
    expect(ids.has('martingale')).toBe(false);
    expect(ids.has('lot_consistency')).toBe(false);
    expect(ids.has('min_duration')).toBe(false);
    // Pero lo que sigue prohibido, sigue declarado.
    expect(ids.has('copy_trading')).toBe(true);
    expect(ids.has('trades_after_request')).toBe(true);
  });

  it('Vex2Pro exige 2 minutos y no 5', () => {
    // Es la diferencia que se pierde si el motor tuviera un número global.
    const dos = rulesForProgram('VEX2PRO FOREX')!.rules.find((r) => r.id === 'min_duration');
    const cinco = rulesForProgram('VEX INSTANT FOREX')!.rules.find((r) => r.id === 'min_duration');
    expect(dos?.params?.minutos).toBe(2);
    expect(cinco?.params?.minutos).toBe(5);
  });

  it('un programa desconocido NO se revisa con el reglamento de otro', () => {
    const r = evaluateWithdrawal(retiro('PROGRAMA QUE NO EXISTE'), ciclo());
    expect(r.outcome).toBe('cannot_review');
    expect(r.checks).toHaveLength(0);
    expect(r.warnings.join(' ')).toContain('no está en el registro');
  });
});

describe('operar después de solicitar rechaza solo', () => {
  it('una sola operación posterior deniega sin período nuevo', () => {
    const despues = [...trades, trade(trades.length, {
      openTime: new Date('2026-08-21T10:00:00Z'),
      closeTime: new Date('2026-08-21T12:00:00Z'),
    })];
    const r = evaluateWithdrawal(retiro('LEVERAGE X12'), ciclo(despues));
    expect(r.outcome).toBe('denied_no_new_period');
    const c = r.checks.find((x) => x.id === 'trades_after_request');
    expect(c?.status).toBe('fail');
    expect(c?.offendingTrades).toBe(1);
  });
});
