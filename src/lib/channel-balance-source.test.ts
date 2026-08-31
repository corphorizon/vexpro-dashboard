// Prioridad de fuentes del reporte de balances por canal (auditoría 2026-08, A1).
//
// El reporte leía SOLO `channel_balances`; /balances prioriza el libro. Una
// ubicación manual operada por libro salía en $0 en el PDF y el email mientras
// la pantalla mostraba el saldo real.

import { describe, it, expect } from 'vitest';
import {
  COINSBUY_RECONCILE_KEY,
  balanceAgeInDays,
  expandCoinsbuyRows,
  isStaleBalance,
  pickChannelAmount,
  pickLiveOrStored,
} from './channel-balance-source';

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

  it('una sub-clave por wallet NUNCA encuentra libro — el bug del ítem 12', () => {
    // `hasLedger('coinsbuy:1079')` es true (no está en NON_LEDGER_CHANNELS),
    // pero el libro sólo tiene la clave agregada `coinsbuy`. Este test fija que
    // pasar la sub-clave con un ledgerBalance es un error del llamador: el
    // desglose por wallet se resuelve en expandCoinsbuyRows.
    expect(
      pickChannelAmount({
        channelKey: 'coinsbuy:1079',
        snapshot: { amount: 244_079.51, source: 'api' },
      }),
    ).toEqual({ amount: 244_079.51, source: 'live' });
  });
});

describe('expandCoinsbuyRows', () => {
  const wallets = [
    { wallet_id: '1079', wallet_label: 'Main' },
    { wallet_id: '1087', wallet_label: 'Savings Vex Pro' },
  ];

  it('una fila por wallet, con el saldo de su propio snapshot', () => {
    const rows = expandCoinsbuyRows({
      aggregate: { amount: 1_500, source: 'ledger' },
      pinnedWallets: wallets,
      snapshotByKey: new Map([
        ['coinsbuy:1079', { amount: 1_000, source: 'api' }],
        ['coinsbuy:1087', { amount: 500, source: 'api' }],
      ]),
    });
    expect(rows.map((r) => [r.key, r.amount, r.source])).toEqual([
      ['coinsbuy:1079', 1_000, 'live'],
      ['coinsbuy:1087', 500, 'live'],
    ]);
    // Cuadra con el agregado → no hace falta fila de ajuste.
    expect(rows.some((r) => r.key === COINSBUY_RECONCILE_KEY)).toBe(false);
  });

  it('el total sigue siendo el del canal, y la diferencia se ve', () => {
    // El caso real: el libro cerró el día en 1.500 y los snapshots por wallet
    // son la foto de las 00:00 UTC (1.200). Antes del arreglo el reporte
    // sumaba 1.200 y /balances mostraba 1.500, sin que nada avisara.
    const rows = expandCoinsbuyRows({
      aggregate: { amount: 1_500, source: 'ledger' },
      pinnedWallets: wallets,
      snapshotByKey: new Map([
        ['coinsbuy:1079', { amount: 800, source: 'api' }],
        ['coinsbuy:1087', { amount: 400, source: 'api' }],
      ]),
    });
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(1_500, 6);
    const ajuste = rows.find((r) => r.key === COINSBUY_RECONCILE_KEY);
    expect(ajuste).toBeDefined();
    expect(ajuste?.amount).toBeCloseTo(300, 6);
    expect(ajuste?.source).toBe('ledger');
  });

  it('una wallet sin snapshot sale `missing`, no como cuenta vacía', () => {
    const rows = expandCoinsbuyRows({
      aggregate: { amount: 0, source: 'missing' },
      pinnedWallets: [wallets[0]],
      snapshotByKey: new Map(),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: 0, source: 'missing' });
  });

  it('una diferencia de redondeo no genera una fila de ajuste', () => {
    const rows = expandCoinsbuyRows({
      aggregate: { amount: 1_000.001, source: 'ledger' },
      pinnedWallets: [wallets[0]],
      snapshotByKey: new Map([['coinsbuy:1079', { amount: 1_000, source: 'api' }]]),
    });
    expect(rows.some((r) => r.key === COINSBUY_RECONCILE_KEY)).toBe(false);
  });

  it('el ajuste puede ser negativo (los snapshots suman de más)', () => {
    const rows = expandCoinsbuyRows({
      aggregate: { amount: 900, source: 'ledger' },
      pinnedWallets: [wallets[0]],
      snapshotByKey: new Map([['coinsbuy:1079', { amount: 1_000, source: 'api' }]]),
    });
    expect(rows.find((r) => r.key === COINSBUY_RECONCILE_KEY)?.amount).toBeCloseTo(-100, 6);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(900, 6);
  });
});

describe('saldo en vivo con respaldo (ítem 13)', () => {
  const libro = { amount: 244_079.51, source: 'ledger' as const };

  it('API de Coinsbuy caída: muestra el libro, NO $0,00', () => {
    // El caso exacto de la auditoría: `if (isToday) return pinnedWalletsTotal;`
    // sin fallback daba $0,00 con la API caída.
    const row = pickLiveOrStored({
      live: null,
      liveFailed: true,
      liveAsOf: null,
      stored: libro,
      storedAsOf: '2026-08-20',
    });
    expect(row.amount).toBeCloseTo(244_079.51, 2);
    expect(row.source).toBe('ledger');
    expect(row.degraded).toBe(true);
  });

  it('con la API respondiendo, manda el vivo y no hay cartel', () => {
    const row = pickLiveOrStored({
      live: 251_000,
      liveFailed: false,
      liveAsOf: '2026-08-31T12:00:00.000Z',
      stored: libro,
      storedAsOf: '2026-08-20',
    });
    expect(row).toEqual({
      amount: 251_000,
      source: 'live',
      asOf: '2026-08-31T12:00:00.000Z',
      degraded: false,
    });
  });

  it('un 0 EN VIVO es un dato: no cae al libro', () => {
    // Distinto de `null`. Si la API dice cero, cero es la respuesta.
    const row = pickLiveOrStored({
      live: 0,
      liveFailed: false,
      liveAsOf: '2026-08-31T12:00:00.000Z',
      stored: libro,
      storedAsOf: '2026-08-20',
    });
    expect(row.amount).toBe(0);
    expect(row.source).toBe('live');
  });

  it('todavía cargando: muestra el respaldo pero SIN cartel de error', () => {
    const row = pickLiveOrStored({
      live: null,
      liveFailed: false,
      liveAsOf: null,
      stored: libro,
      storedAsOf: '2026-08-20',
    });
    expect(row.amount).toBeCloseTo(244_079.51, 2);
    expect(row.degraded).toBe(false);
  });

  it('un vivo NaN no se toma por bueno', () => {
    const row = pickLiveOrStored({
      live: Number.NaN,
      liveFailed: false,
      liveAsOf: null,
      stored: libro,
      storedAsOf: '2026-08-20',
    });
    expect(row.amount).toBeCloseTo(244_079.51, 2);
  });

  it('sin vivo y sin respaldo, el 0 sale marcado `missing`, no como saldo', () => {
    const row = pickLiveOrStored({
      live: null,
      liveFailed: true,
      liveAsOf: null,
      stored: { amount: 0, source: 'missing' },
      storedAsOf: null,
    });
    expect(row).toEqual({ amount: 0, source: 'missing', asOf: null, degraded: true });
  });
});

describe('antigüedad del saldo (ítem 23)', () => {
  it('«otros» del 05/08 mirado el 31/08 todavía no es viejo; el 04/09 sí', () => {
    // El caso exacto de producción: un único asiento del 2026-08-05 por
    // $14.493, pintado con el mismo peso visual que Coinsbuy en vivo.
    expect(balanceAgeInDays('2026-08-05', '2026-08-31')).toBe(26);
    expect(
      isStaleBalance({ source: 'ledger', updatedAt: '2026-08-05', asOf: '2026-08-31' }),
    ).toBe(false); // 26 < 30
    expect(
      isStaleBalance({ source: 'ledger', updatedAt: '2026-08-05', asOf: '2026-09-04' }),
    ).toBe(true); // 30 justos
  });

  it('lo que está en vivo o se recalcula solo nunca es viejo', () => {
    for (const source of ['live', 'computed'] as const) {
      expect(isStaleBalance({ source, updatedAt: '2020-01-01', asOf: '2026-08-31' })).toBe(
        false,
      );
    }
  });

  it('«no hay dato» no se marca viejo: ya tiene un cartel peor', () => {
    expect(isStaleBalance({ source: 'missing', updatedAt: null, asOf: '2026-08-31' })).toBe(
      false,
    );
  });

  it('sin fecha no se sabe la antigüedad — y no saber no es "está al día"', () => {
    expect(balanceAgeInDays(null, '2026-08-31')).toBeNull();
    expect(balanceAgeInDays('no es una fecha', '2026-08-31')).toBeNull();
    // No se marca viejo porque no hay con qué afirmarlo; la UI lo dice aparte.
    expect(isStaleBalance({ source: 'snapshot', updatedAt: null, asOf: '2026-08-31' })).toBe(
      false,
    );
  });

  it('una fecha en el futuro es cero días, no antigüedad negativa', () => {
    expect(balanceAgeInDays('2026-09-01', '2026-08-31')).toBe(0);
  });

  it('acepta ISO completo además de YYYY-MM-DD', () => {
    expect(balanceAgeInDays('2026-08-01T13:45:00.000Z', '2026-08-31')).toBe(29);
  });
});
