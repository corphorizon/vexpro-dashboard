import { describe, it, expect } from 'vitest';
import {
  API_WITHDRAWAL_CHANNELS,
  sumApiWithdrawals,
  withdrawalChannelLabel,
  type WithdrawalsByChannel,
} from './withdrawal-channels';
import { ACCEPTED_STATUS, PAYPROS_PAYOUT_STATUS } from './api-integrations/totals';

describe('API_WITHDRAWAL_CHANNELS — el registro', () => {
  it('incluye Pay-Pros: es el pedido que originó el archivo', () => {
    expect(API_WITHDRAWAL_CHANNELS.map((c) => c.key)).toEqual(['coinsbuy', 'paypros']);
  });

  it('no copia los status: los toma de totals.ts', () => {
    // Si alguien "arregla" un status en un solo lado, este test lo agarra. Es
    // la defensa contra la tercera lista del mismo dato.
    const byKey = Object.fromEntries(API_WITHDRAWAL_CHANNELS.map((c) => [c.key, c.status]));
    expect(byKey.coinsbuy).toBe(ACCEPTED_STATUS['coinsbuy-withdrawals']);
    expect(byKey.paypros).toBe(PAYPROS_PAYOUT_STATUS);
  });

  it('Pay-Pros usa el status de SALIDA, no el de entrada', () => {
    const paypros = API_WITHDRAWAL_CHANNELS.find((c) => c.key === 'paypros');
    expect(paypros?.status).toBe('payout_paid');
    // El provider es el mismo para las dos puntas: si el registro guardara
    // solo el slug, un retiro y un depósito serían indistinguibles.
    expect(paypros?.slug).toBe('paypros');
    expect(paypros?.status).not.toBe(ACCEPTED_STATUS.paypros);
  });
});

describe('sumApiWithdrawals', () => {
  it('suma los canales con dato', () => {
    // Cifras reales del espejo del CRM al 2026-08-31 (Vex Pro): 6 retiros
    // Pay-Pros aprobados por US$ 2.617,62.
    const by: WithdrawalsByChannel = { coinsbuy: 469_650.98, paypros: 2_617.62 };
    expect(sumApiWithdrawals(by).total).toBeCloseTo(472_268.6, 2);
    expect(sumApiWithdrawals(by).channelsWithoutData).toEqual([]);
  });

  it('cuenta el cero como cero: "no hubo retiros" es un dato', () => {
    const by: WithdrawalsByChannel = { coinsbuy: 100, paypros: 0 };
    expect(sumApiWithdrawals(by).total).toBe(100);
    expect(sumApiWithdrawals(by).channelsWithoutData).toEqual([]);
  });

  it('null NO se cuenta como cero, y se informa cuál faltó', () => {
    const by: WithdrawalsByChannel = { coinsbuy: 100, paypros: null };
    const res = sumApiWithdrawals(by);
    expect(res.total).toBe(100);
    expect(res.channelsWithoutData).toEqual(['paypros']);
  });

  it('un canal ausente del objeto es "no lo sabemos", no cero', () => {
    const res = sumApiWithdrawals({ coinsbuy: 100 });
    expect(res.channelsWithoutData).toEqual(['paypros']);
  });

  it('descarta un número roto en vez de propagar NaN al total', () => {
    // Un NaN sumado sería un total NaN en pantalla — o peor, un 0 tras un `|| 0`.
    const res = sumApiWithdrawals({ coinsbuy: 100, paypros: Number.NaN });
    expect(res.total).toBe(100);
    expect(res.channelsWithoutData).toEqual(['paypros']);
  });

  it('sin ningún dato el total es 0 y los DOS canales se reportan', () => {
    const res = sumApiWithdrawals({});
    expect(res.total).toBe(0);
    expect(res.channelsWithoutData).toEqual(['coinsbuy', 'paypros']);
  });
});

describe('withdrawalChannelLabel', () => {
  it('usa la MISMA clave i18n que los depósitos', () => {
    const t = (k: string) => (k === 'movements.channelLabel.paypros' ? 'Pay-Pros (Medio Local)' : k);
    expect(withdrawalChannelLabel('paypros', t)).toBe('Pay-Pros (Medio Local)');
  });

  it('sin traducción cae a la clave del canal, nunca a la clave cruda', () => {
    const t = (k: string) => k;
    expect(withdrawalChannelLabel('coinsbuy', t)).toBe('coinsbuy');
  });
});
