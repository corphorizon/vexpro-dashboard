// Prioridad de fuentes del reporte de balances por canal (auditoría 2026-08, A1).
//
// El reporte leía SOLO `channel_balances`; /balances prioriza el libro. Una
// ubicación manual operada por libro salía en $0 en el PDF y el email mientras
// la pantalla mostraba el saldo real.

import { describe, it, expect } from 'vitest';
import { pickChannelAmount } from './balances-by-channel';

describe('pickChannelAmount', () => {
  it('el libro le gana al snapshot', () => {
    expect(
      pickChannelAmount({
        channelKey: 'banco_galicia',
        ledgerBalance: 12_500,
        snapshot: { amount: 3_000, source: 'manual' },
      }),
    ).toEqual({ amount: 12_500, source: 'ledger' });
  });

  it('un canal con libro y sin snapshot ya no sale en cero', () => {
    expect(
      pickChannelAmount({ channelKey: 'prestamo_juan', ledgerBalance: 8_000 }),
    ).toEqual({ amount: 8_000, source: 'ledger' });
  });

  it('un saldo de libro en cero es un dato, no una ausencia', () => {
    expect(pickChannelAmount({ channelKey: 'banco', ledgerBalance: 0 })).toEqual({
      amount: 0,
      source: 'ledger',
    });
  });

  it('liquidez / inversiones no llevan libro: manda el snapshot', () => {
    expect(
      pickChannelAmount({
        channelKey: 'liquidez',
        ledgerBalance: 999, // no debería ni mirarse
        snapshot: { amount: 500, source: 'manual' },
      }),
    ).toEqual({ amount: 500, source: 'snapshot' });
  });

  it('un snapshot recién escrito por la API se marca live', () => {
    expect(
      pickChannelAmount({
        channelKey: 'liquidez',
        snapshot: { amount: 77, source: 'api' },
      }),
    ).toEqual({ amount: 77, source: 'live' });
  });

  it('sin libro ni snapshot devuelve missing, no un 0 mudo', () => {
    expect(pickChannelAmount({ channelKey: 'banco_nuevo' })).toEqual({
      amount: 0,
      source: 'missing',
    });
  });

  it('FairPay: el cero del libro tapaba el saldo real — así se veía el bug', () => {
    // Reproduce exactamente el estado de producción del 2026-08-31: el libro
    // de `fairpay` tenía UN asiento (apertura manual de $0,00 del 05/08) y el
    // snapshot del día decía $7.163,47. Este test NO es un bug: fija que la
    // prioridad libro > snapshot es intencional. El arreglo es que el cron le
    // escriba el libro a FairPay (API_LEDGER_CHANNELS), no cambiar la
    // prioridad — si se cambiara, todas las ubicaciones manuales operadas por
    // libro volverían a mostrar un snapshot viejo (auditoría A1).
    expect(
      pickChannelAmount({
        channelKey: 'fairpay',
        ledgerBalance: 0,
        snapshot: { amount: 7_163.47, source: 'api' },
      }),
    ).toEqual({ amount: 0, source: 'ledger' });

    // Y con el libro ya asentado por el cron, la misma pantalla muestra el
    // saldo real de la cuenta bancaria.
    expect(
      pickChannelAmount({
        channelKey: 'fairpay',
        ledgerBalance: 7_163.47,
        snapshot: { amount: 7_163.47, source: 'api' },
      }),
    ).toEqual({ amount: 7_163.47, source: 'ledger' });
  });

  it('un balance de libro no numérico no se toma por bueno', () => {
    expect(
      pickChannelAmount({
        channelKey: 'banco',
        ledgerBalance: Number.NaN,
        snapshot: { amount: 42, source: 'manual' },
      }),
    ).toEqual({ amount: 42, source: 'snapshot' });
  });
});
