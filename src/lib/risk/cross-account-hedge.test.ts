import { describe, it, expect } from 'vitest';
import { detectarCoberturaCruzada, MIN_PARES, TOLERANCIA_VOLUMEN } from './cross-account-hedge';
import type { Trade } from '@/lib/risk/types';

const T0 = new Date('2026-08-01T12:00:00.000Z').getTime();

function op(over: Partial<Trade> & { index: number }): Trade {
  const abre = new Date(T0 + (over.index ?? 0) * 60_000);
  return {
    position: over.index + 1,
    symbol: 'XAUUSD.',
    type: 'buy',
    volume: 1,
    openPrice: 100,
    closePrice: 101,
    sl: null,
    tp: null,
    openTime: abre,
    closeTime: new Date(abre.getTime() + 600_000),
    commission: 0,
    swap: 0,
    profit: 1,
    durationMinutes: 10,
    ...over,
  };
}

/** N operaciones separadas un minuto, arrancando en T0 + `offsetSeg`. */
function serie(n: number, over: Partial<Trade> = {}, offsetSeg = 0): Trade[] {
  return Array.from({ length: n }, (_, i) =>
    op({
      ...over,
      index: i,
      openTime: new Date(T0 + i * 60_000 + offsetSeg * 1000),
    }),
  );
}

describe('detectarCoberturaCruzada', () => {
  it('con una sola cuenta no hay nada que cruzar', () => {
    const r = detectarCoberturaCruzada(new Map([[111, serie(10)]]));
    expect(r.total).toBe(0);
    expect(r.pares).toHaveLength(0);
  });

  it('detecta las puntas opuestas simultáneas en dos cuentas', () => {
    // A compra y B vende el mismo símbolo, con 5 segundos de diferencia y el
    // mismo volumen: en conjunto el riesgo de mercado es cero.
    const r = detectarCoberturaCruzada(new Map([
      [111, serie(6, { type: 'buy' })],
      [222, serie(6, { type: 'sell' }, 5)],
    ]));
    expect(r.total).toBe(6);
    expect(r.pares[0].loginA).toBe(111);
    expect(r.pares[0].loginB).toBe(222);
    expect(r.pares[0].symbol).toBe('XAUUSD.');
    expect(r.logins).toEqual([111, 222]);
  });

  it('NO marca dos cuentas que van en la MISMA dirección', () => {
    // Eso es copia, no cobertura, y la mide otro módulo. Confundirlas daría el
    // veredicto opuesto sobre la misma evidencia.
    const r = detectarCoberturaCruzada(new Map([
      [111, serie(10, { type: 'buy' })],
      [222, serie(10, { type: 'buy' }, 5)],
    ]));
    expect(r.total).toBe(0);
  });

  it('NO marca operaciones opuestas separadas en el tiempo', () => {
    // Una hora de diferencia no es cobertura: son dos decisiones distintas.
    const r = detectarCoberturaCruzada(new Map([
      [111, serie(10, { type: 'buy' })],
      [222, serie(10, { type: 'sell' }, 3600)],
    ]));
    expect(r.total).toBe(0);
  });

  it('NO marca volúmenes muy distintos', () => {
    // Una cobertura deliberada usa tamaños parecidos: es lo que neutraliza el
    // riesgo. Sin este filtro entrarían dos operaciones sin relación que por
    // casualidad cayeron juntas y opuestas.
    const r = detectarCoberturaCruzada(new Map([
      [111, serie(10, { type: 'buy', volume: 1 })],
      [222, serie(10, { type: 'sell', volume: 10 })],
    ]));
    expect(r.total).toBe(0);
  });

  it('acepta el volumen dentro de la tolerancia', () => {
    const dentro = 1 - TOLERANCIA_VOLUMEN / 2;
    const r = detectarCoberturaCruzada(new Map([
      [111, serie(6, { type: 'buy', volume: 1 })],
      [222, serie(6, { type: 'sell', volume: dentro }, 5)],
    ]));
    expect(r.total).toBe(6);
  });

  it('NO marca símbolos distintos', () => {
    const r = detectarCoberturaCruzada(new Map([
      [111, serie(10, { type: 'buy', symbol: 'XAUUSD.' })],
      [222, serie(10, { type: 'sell', symbol: 'EURUSD.' }, 5)],
    ]));
    expect(r.total).toBe(0);
  });

  it('no cuenta la misma operación de B dos veces', () => {
    // Sin marcar las usadas, un racimo de operaciones de A dentro de la ventana
    // se cubriría todo con la MISMA de B y contaría como muchas coberturas.
    const a = [
      op({ index: 0, type: 'buy', openTime: new Date(T0) }),
      op({ index: 1, type: 'buy', openTime: new Date(T0 + 1000) }),
      op({ index: 2, type: 'buy', openTime: new Date(T0 + 2000) }),
      op({ index: 3, type: 'buy', openTime: new Date(T0 + 3000) }),
    ];
    const b = [op({ index: 0, type: 'sell', openTime: new Date(T0 + 1500) })];
    const r = detectarCoberturaCruzada(new Map([[111, a], [222, b]]));
    // Una sola punta de B: como mucho una cobertura, que queda por debajo del
    // mínimo para reportar.
    expect(r.total).toBe(0);
  });

  it('exige un mínimo de coincidencias para reportar', () => {
    const pocas = MIN_PARES - 1;
    const r = detectarCoberturaCruzada(new Map([
      [111, serie(pocas, { type: 'buy' })],
      [222, serie(pocas, { type: 'sell' }, 5)],
    ]));
    expect(r.pares).toHaveLength(0);
  });
});
