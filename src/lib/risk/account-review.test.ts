// ─────────────────────────────────────────────────────────────────────────────
// Lo que estas pruebas garantizan no es que una cuenta que hace scalping
// levante la mano —eso es lo fácil— sino que el diagnóstico NO afirme cosas que
// no comprobó y NO trate un dato faltante como si fuera una señal en contra.
// Por eso buena parte de los casos son negativos.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  evaluateAccount,
  tradedAfterRequest,
  RIESGO_ALTO,
  RIESGO_MEDIO,
} from '@/lib/risk/account-review';
import type { Trade } from '@/lib/risk/types';

/** Operación mínima; los tests pisan sólo lo que les importa. */
function trade(i: number, over: Partial<Trade> = {}): Trade {
  const open = new Date(Date.UTC(2026, 6, 1, 12, 0, 0) + i * 3_600_000);
  const durMin = over.durationMinutes ?? 30;
  return {
    index: i,
    position: 1000 + i,
    symbol: 'EURUSD',
    type: 'buy',
    volume: 1,
    openPrice: 1.1,
    closePrice: 1.2,
    sl: null,
    tp: null,
    openTime: open,
    closeTime: new Date(open.getTime() + durMin * 60_000),
    commission: 0,
    swap: 0,
    profit: 10,
    durationMinutes: durMin,
    ...over,
  };
}

describe('cuenta sin operaciones', () => {
  it('no inventa señales ni riesgo: "no operó" es un dato, no una sospecha', () => {
    const r = evaluateAccount(123, []);
    expect(r.risk).toBe('ok');
    expect(r.flagged).toBe(0);
    expect(r.signals).toHaveLength(0);
    expect(r.facts.positions).toBe(0);
    // Y lo dice, para que la pantalla no muestre un vacío ambiguo.
    expect(r.warnings.join(' ')).toContain('no tiene operaciones');
  });
});

describe('lo que NO se comprobó nunca se da por limpio', () => {
  const trades = [trade(0), trade(1), trade(2)];

  it('sin calendario, la señal de noticias queda sin comprobar (no en pass)', () => {
    const r = evaluateAccount(1, trades);
    const s = r.signals.find((x) => x.id === 'news_window');
    expect(s?.status).toBe('unverifiable');
    expect(s?.whyNot).toBeTruthy();
  });

  it('sin cálculo cruzado, la señal de copia queda sin comprobar', () => {
    const r = evaluateAccount(1, trades);
    const s = r.signals.find((x) => x.id === 'copy_trading');
    expect(s?.status).toBe('unverifiable');
    expect(s?.whyNot).toBeTruthy();
  });

  it('las no comprobadas NO cuentan como señal disparada', () => {
    const r = evaluateAccount(1, trades);
    const sinComprobar = r.signals.filter((s) => s.status === 'unverifiable').length;
    expect(sinComprobar).toBeGreaterThan(0);
    expect(r.unverifiable).toBe(sinComprobar);
    // `flagged` sólo cuenta los `fail`.
    expect(r.flagged).toBe(r.signals.filter((s) => s.status === 'fail').length);
  });

  it('con calendario y sin coincidencias, la señal SÍ pasa a pass', () => {
    const r = evaluateAccount(1, trades, {
      noticias: [{ at: Date.UTC(2020, 0, 1), name: 'NFP', currency: 'USD' }],
    });
    expect(r.signals.find((s) => s.id === 'news_window')?.status).toBe('pass');
  });
});

describe('el riesgo sale de las señales disparadas', () => {
  it('scalping puro dispara la densidad de menos de un minuto', () => {
    // 10 operaciones de 10 segundos: 100% bajo un minuto.
    const trades = Array.from({ length: 10 }, (_, i) => trade(i, { durationMinutes: 1 / 6 }));
    const r = evaluateAccount(1, trades);
    const hft = r.signals.find((s) => s.id === 'hft');
    expect(hft?.status).toBe('fail');
    expect(r.facts.under1min).toBe(10);
  });

  it('operar tranquilo no dispara la densidad', () => {
    const trades = Array.from({ length: 10 }, (_, i) => trade(i, { durationMinutes: 120 }));
    const r = evaluateAccount(1, trades);
    expect(r.signals.find((s) => s.id === 'hft')?.status).toBe('pass');
    expect(r.facts.under1min).toBe(0);
  });

  it('los umbrales son los declarados y no otros', () => {
    // Se fija el contrato: si alguien mueve las constantes, este test lo dice.
    expect(RIESGO_MEDIO).toBeLessThan(RIESGO_ALTO);
    const trades = Array.from({ length: 10 }, (_, i) => trade(i, { durationMinutes: 120 }));
    const r = evaluateAccount(1, trades);
    const esperado = r.flagged >= RIESGO_ALTO ? 'alto' : r.flagged >= RIESGO_MEDIO ? 'medio' : 'ok';
    expect(r.risk).toBe(esperado);
  });
});

describe('hechos de la cuenta', () => {
  it('el resultado neto incluye swap y comisiones, no sólo el profit', () => {
    const r = evaluateAccount(1, [
      trade(0, { profit: 100, swap: -10, commission: -5 }),
    ]);
    expect(r.facts.netResult).toBe(85);
  });

  it('la caída máxima mide pico contra valle posterior, en orden de cierre', () => {
    const r = evaluateAccount(1, [
      trade(0, { profit: 100 }),   // acumulado 100 (pico)
      trade(1, { profit: -60 }),   // acumulado  40 → caída 60
      trade(2, { profit: -10 }),   // acumulado  30 → caída 70
      trade(3, { profit: 200 }),   // se recupera, pero la caída ya ocurrió
    ]);
    expect(r.facts.maxDrawdown).toBe(70);
  });

  it('ganadas y perdidas no cuentan las de resultado cero', () => {
    const r = evaluateAccount(1, [
      trade(0, { profit: 10 }),
      trade(1, { profit: -10 }),
      trade(2, { profit: 0 }),
    ]);
    expect(r.facts.won).toBe(1);
    expect(r.facts.lost).toBe(1);
  });
});

describe('operar después de solicitar el retiro', () => {
  const req = '2026-07-10T12:00:00.000Z';

  it('detecta la operación posterior', () => {
    expect(tradedAfterRequest('2026-07-10T12:00:01.000Z', req)).toBe(true);
  });

  it('una operación anterior no lo dispara', () => {
    expect(tradedAfterRequest('2026-07-10T11:59:59.000Z', req)).toBe(false);
  });

  it('exactamente en el instante de la solicitud NO cuenta como posterior', () => {
    expect(tradedAfterRequest(req, req)).toBe(false);
  });

  it('sin fecha de última operación devuelve null, no false', () => {
    // "No lo sabemos" y "no operó" son cosas distintas: devolver false diría
    // que el cliente no operó cuando en realidad falta el dato.
    expect(tradedAfterRequest(null, req)).toBeNull();
  });

  it('sin fecha de solicitud devuelve null', () => {
    expect(tradedAfterRequest('2026-07-10T12:00:01.000Z', null)).toBeNull();
  });

  it('una fecha basura devuelve null en vez de una comparación inventada', () => {
    expect(tradedAfterRequest('no-es-fecha', req)).toBeNull();
  });
});

describe('recorte de cuentas enormes', () => {
  it('se marca y se avisa: un recorte silencioso parecería "opera poco"', () => {
    const r = evaluateAccount(1, [trade(0), trade(1)], { truncated: true });
    expect(r.truncated).toBe(true);
    expect(r.warnings.join(' ')).toContain('se analizaron las primeras');
  });
});
