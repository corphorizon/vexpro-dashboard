import { describe, it, expect } from 'vitest';
import {
  API_DEPOSIT_CHANNELS,
  ALL_DEPOSIT_CHANNELS,
  apiSlugForChannel,
  depositChannelLabel,
  manualDepositsByChannel,
  sumApiDeposits,
} from './deposit-channels';
import type { Deposit } from './types';

// El bug que fija esta batería: la tarjeta «Depósitos» de /movimientos sumaba
// tres canales cableados a mano mientras el backend contaba cuatro, y
// Pay-Pros (61 tx, US$ 44.653,95 al 2026-08-31) no aparecía en ningún lado de
// la pantalla. Todo lo de acá abajo existe para que ese olvido rompa un test
// y no una cifra.

const dep = (channel: Deposit['channel'], amount: number) =>
  ({ channel, amount }) as Pick<Deposit, 'channel' | 'amount'>;

describe('registro de canales de depósito', () => {
  it('incluye Pay-Pros entre los canales con API', () => {
    const channels = API_DEPOSIT_CHANNELS.map((c) => c.channel);
    expect(channels).toContain('paypros');
    expect(apiSlugForChannel('paypros')).toBe('paypros');
  });

  it('mapea cada canal de API a su slug de api_transactions', () => {
    expect(apiSlugForChannel('coinsbuy')).toBe('coinsbuy-deposits');
    expect(apiSlugForChannel('fairpay')).toBe('fairpay');
    expect(apiSlugForChannel('unipayment')).toBe('unipayment');
  });

  it("'other' es manual puro: no tiene slug de API", () => {
    expect(apiSlugForChannel('other')).toBeNull();
  });

  it("la lista de pantalla son los canales de API + 'other' al final", () => {
    expect(ALL_DEPOSIT_CHANNELS).toEqual([
      'coinsbuy',
      'fairpay',
      'unipayment',
      'paypros',
      'other',
    ]);
  });
});

describe('manualDepositsByChannel', () => {
  it('devuelve 0 (no undefined) para los canales sin fila cargada', () => {
    const manual = manualDepositsByChannel([dep('coinsbuy', 100)]);
    expect(manual.coinsbuy).toBe(100);
    expect(manual.paypros).toBe(0);
    expect(manual.other).toBe(0);
    // Todos los canales presentes: un `undefined` suelto propaga NaN al total.
    for (const ch of ALL_DEPOSIT_CHANNELS) {
      expect(typeof manual[ch]).toBe('number');
    }
  });

  it('lee el manual de Pay-Pros el día que exista (migración 105)', () => {
    const manual = manualDepositsByChannel([dep('paypros', 250)]);
    expect(manual.paypros).toBe(250);
  });
});

describe('sumApiDeposits — «Depósitos Totales (API)»', () => {
  it('suma Pay-Pros junto con los otros tres canales', () => {
    const total = sumApiDeposits(
      { coinsbuy: 1000, fairpay: 200, unipayment: 300, paypros: 44653.95 },
      { coinsbuy: 0, fairpay: 0, unipayment: 0, paypros: 0, other: 0 },
    );
    expect(total).toBeCloseTo(46153.95, 2);
  });

  it('API y manual coexisten en el mismo canal (se suman, no se pisan)', () => {
    const total = sumApiDeposits(
      { coinsbuy: 100, paypros: 50 },
      { coinsbuy: 10, paypros: 5, other: 999 },
    );
    // 100+10 + 50+5. 'other' NO entra: es manual puro y se suma aparte al
    // total del período, no a «Depósitos Totales (API)».
    expect(total).toBe(165);
  });

  it('un canal ausente en los dos mapas aporta 0, no NaN', () => {
    expect(sumApiDeposits({}, {})).toBe(0);
  });
});

describe('depositChannelLabel', () => {
  it('usa la traducción cuando existe', () => {
    const t = (key: string) =>
      key === 'movements.channelLabel.paypros' ? 'Pay-Pros (Local payment)' : key;
    expect(depositChannelLabel('paypros', t)).toBe('Pay-Pros (Local payment)');
  });

  it('cae a la etiqueta castellana cuando falta la clave i18n', () => {
    const t = (key: string) => key; // así responde useI18n ante una clave ausente
    expect(depositChannelLabel('paypros', t)).toBe('Pay-Pros (Medio Local)');
    expect(depositChannelLabel('coinsbuy', t)).toBe('Coinsbuy (Crypto)');
  });
});
