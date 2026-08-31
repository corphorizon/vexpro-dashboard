import { describe, it, expect } from 'vitest';
import {
  analizarOrigen,
  analizarEjecucion,
  evaluarToxicidad,
  nombreMotivo,
} from './broker-toxicity';
import type { Trade } from '@/lib/risk/types';

/** Una operación con lo mínimo, para poder sobreescribir sólo lo que importa. */
function op(over: Partial<Trade> = {}): Trade {
  const abre = new Date('2026-08-01T12:00:00.000Z');
  return {
    index: 0,
    position: 1,
    symbol: 'XAUUSD.',
    type: 'buy',
    volume: 0.1,
    openPrice: 100,
    closePrice: 101,
    sl: null,
    tp: null,
    openTime: abre,
    closeTime: new Date(abre.getTime() + 30 * 60_000),
    commission: 0,
    swap: 0,
    profit: 10,
    durationMinutes: 30,
    ...over,
  };
}

const muchas = (n: number, over: Partial<Trade> = {}) =>
  Array.from({ length: n }, (_, i) => op({ ...over, index: i, position: i + 1 }));

describe('nombreMotivo', () => {
  it('traduce los motivos de MT5, incluido el 16 que no es estándar', () => {
    expect(nombreMotivo(1)).toBe('Móvil');
    expect(nombreMotivo(3)).toBe('Experto (bot)');
    expect(nombreMotivo(4)).toBe('Stop loss');
    // MT5 define 0..9; este bróker usa 16 para el cierre contra otra posición.
    expect(nombreMotivo(16)).toBe('Cierre contra otra posición');
  });

  it('no inventa nombres para lo que no conoce', () => {
    expect(nombreMotivo(99)).toBe('Motivo 99');
    expect(nombreMotivo(null)).toBe('Sin dato');
  });
});

describe('analizarOrigen', () => {
  it('encuentra el bot aunque el motivo diga móvil', () => {
    // El caso real de la cuenta 137983: 259 operaciones con Reason = MOBILE y
    // comentario «EMABOT R1 M1». Leer sólo el motivo diría «operativa manual».
    const trades = [
      ...muchas(5, { openReason: 1, comment: 'EMABOT R1 M1' }),
      ...muchas(3, { openReason: 1, comment: 'EMABOT R1 M2' }),
    ];
    const o = analizarOrigen(trades);
    expect(o.bots.map((b) => b.name)).toContain('EMABOT R1 M1');
    expect(o.botDisfrazado).toBe(true);
  });

  it('NO cuenta como bot los comentarios que genera MT5 solo', () => {
    // `#2092250 by #2092242` es el comentario de un cierre contra otra
    // posición: es distinto en cada operación. Contarlos daría cientos de
    // «bots» que no existen.
    const trades = [
      op({ index: 0, comment: '#2092250 by #2092242' }),
      op({ index: 1, comment: '#2106284 by #2107890' }),
      op({ index: 2, comment: '123.45' }),
    ];
    expect(analizarOrigen(trades).bots).toHaveLength(0);
  });

  it('sin comentarios no hay bot disfrazado', () => {
    const o = analizarOrigen(muchas(5, { openReason: 1, comment: null }));
    expect(o.bots).toHaveLength(0);
    expect(o.botDisfrazado).toBe(false);
  });
});

describe('analizarEjecucion', () => {
  it('cuenta como normal la ejecución exacta en el bid o el ask', () => {
    // Lo medido en producción: las ejecuciones caen EXACTAMENTE en el bid o el
    // ask. Eso es lo normal y no debe marcarse.
    const compras = muchas(10, { type: 'buy', openPrice: 101, openBid: 100, openAsk: 101 });
    const ventas = muchas(10, { type: 'sell', openPrice: 100, openBid: 100, openAsk: 101 });
    const e = analizarEjecucion([...compras, ...ventas]);
    expect(e.enMercado).toBe(20);
    expect(e.aFavor).toBe(0);
    expect(e.pctAFavor).toBe(0);
  });

  it('detecta la compra por debajo del ask y la venta por encima del bid', () => {
    const e = analizarEjecucion([
      op({ index: 0, type: 'buy', openPrice: 100.5, openBid: 100, openAsk: 101 }),
      op({ index: 1, type: 'sell', openPrice: 100.5, openBid: 100, openAsk: 101 }),
    ]);
    expect(e.aFavor).toBe(2);
    expect(e.enContra).toBe(0);
  });

  it('ignora las operaciones sin precio de mercado', () => {
    // `undefined` es «este origen no lo trae» — el cargador manual de prop
    // firm, por ejemplo. No es una ejecución en el mercado.
    const e = analizarEjecucion(muchas(5, { openBid: undefined, openAsk: undefined }));
    expect(e.comparables).toBe(0);
    expect(e.spreadMedio).toBeNull();
  });
});

describe('evaluarToxicidad', () => {
  it('no marca nada con pocas operaciones: deja las señales sin comprobar', () => {
    // «No se pudo medir» NO es «está limpio». Con `hit: null` la pantalla lo
    // dice, en vez de dar por buena una cuenta que nadie miró.
    const t = evaluarToxicidad(muchas(3));
    expect(t.senales.every((s) => s.hit === null)).toBe(true);
    expect(t.flagged).toBe(0);
    expect(t.level).toBe('ok');
  });

  it('NO marca a la cuenta que gana con trailing stops', () => {
    // El caso real de la 152870: 98% de acierto, +63.847, cerrando por
    // `Reason = STOP LOSS` con ganancia. Si «acierto alto» fuera señal por sí
    // solo, esta cuenta sana saldría marcada. Dura 57 minutos: no es arbitraje.
    const trades = muchas(100, {
      durationMinutes: 57,
      profit: 90,
      closeReason: 4,
      openPrice: 101,
      openBid: 100,
      openAsk: 101,
      closePrice: 108,
    });
    const t = evaluarToxicidad(trades);
    expect(t.senales.find((s) => s.key === 'ganador_relampago')?.hit).not.toBe(true);
    expect(t.level).toBe('ok');
  });

  it('marca al que gana consistente en operaciones de segundos', () => {
    const trades = muchas(50, {
      durationMinutes: 0.2, // 12 segundos
      profit: 5,
      openPrice: 101,
      openBid: 100,
      openAsk: 101,
      closePrice: 101.05,
    });
    const t = evaluarToxicidad(trades);
    expect(t.senales.find((s) => s.key === 'ganador_relampago')?.hit).toBe(true);
  });

  it('marca la ejecución sistemáticamente a favor del cliente', () => {
    const trades = muchas(50, { type: 'buy', openPrice: 100.2, openBid: 100, openAsk: 101 });
    const t = evaluarToxicidad(trades);
    expect(t.senales.find((s) => s.key === 'ejecucion_favorable')?.hit).toBe(true);
  });

  it('hacen falta DOS señales para el nivel alto', () => {
    // Una sola puede tener explicación honesta; dos que coinciden ya no.
    //
    // `closePrice` bien lejos a propósito: con un recorrido corto se disparaba
    // TAMBIÉN la señal de captura de spread y el caso dejaba de probar lo que
    // dice probar. Las señales se solapan y el fixture tiene que aislarlas.
    const unaSola = muchas(50, {
      type: 'buy',
      openPrice: 100.2,
      openBid: 100,
      openAsk: 101,
      closePrice: 140,
      durationMinutes: 120,
    });
    const t = evaluarToxicidad(unaSola);
    expect(t.senales.filter((s) => s.hit === true).map((s) => s.key)).toEqual(['ejecucion_favorable']);
    expect(t.level).toBe('medio');
  });

  it('detecta el cierre contra la posición opuesta', () => {
    const trades = [
      ...muchas(30, { closeReason: 16 }),
      ...muchas(20, { closeReason: 4 }),
    ].map((t, i) => ({ ...t, index: i }));
    const s = evaluarToxicidad(trades).senales.find((x) => x.key === 'cierre_contra_opuesta');
    expect(s?.hit).toBe(true);
    expect(s?.detail).toContain('60%');
  });
});
