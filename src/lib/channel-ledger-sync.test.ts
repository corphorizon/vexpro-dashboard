// ─────────────────────────────────────────────────────────────────────────────
// Tope de ajuste del libro por canal.
//
// El tope es lo único que separa "el libro cerró contra el saldo real" de "el
// libro se tragó un dato roto". Con la wallet on-chain dejó de poder vivir en
// un Record por clave: su canal puede ser `wallet_externa` o un `custom_<uuid>`
// distinto en cada empresa.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_ADJUSTMENT,
  MAX_ADJUSTMENT,
  ONCHAIN_MAX_ADJUSTMENT,
  maxAdjustmentFor,
} from './channel-ledger-sync';
import { API_LEDGER_CHANNELS } from './channel-ledger';

describe('maxAdjustmentFor', () => {
  it('respeta el tope propio de cada canal built-in', () => {
    expect(maxAdjustmentFor('coinsbuy')).toBe(MAX_ADJUSTMENT.coinsbuy);
    expect(maxAdjustmentFor('unipayment')).toBe(MAX_ADJUSTMENT.unipayment);
    expect(maxAdjustmentFor('paypros')).toBe(MAX_ADJUSTMENT.paypros);
  });

  it('un canal manual cualquiera se queda con el default conservador', () => {
    expect(maxAdjustmentFor('custom_1234')).toBe(DEFAULT_MAX_ADJUSTMENT);
    expect(maxAdjustmentFor('wallet_externa')).toBe(DEFAULT_MAX_ADJUSTMENT);
  });

  it('el MISMO canal, marcado on-chain, sube al tope de cadena', () => {
    // Es exactamente el caso de Vex Pro: `wallet_externa` deja de ser manual
    // cuando se le cargan direcciones, y su movimiento diario real (fees de
    // gas + variación de precio + redes sin historial) revienta los $1.000.
    expect(maxAdjustmentFor('wallet_externa', { onchain: true })).toBe(ONCHAIN_MAX_ADJUSTMENT);
    expect(maxAdjustmentFor('custom_1234', { onchain: true })).toBe(ONCHAIN_MAX_ADJUSTMENT);
  });

  it('un canal con tope propio NO se lo pierde por ser on-chain', () => {
    // Si algún día Coinsbuy pasara por este camino, su tope estricto manda:
    // ahí el ajuste son comisiones de red de $1-4 y aflojarlo taparía un bug.
    expect(maxAdjustmentFor('coinsbuy', { onchain: true })).toBe(MAX_ADJUSTMENT.coinsbuy);
  });

  it('el tope on-chain cubre el salto del alta de Vex Pro (≈ −497)', () => {
    // 17.613 cargado a mano → ~17.116 reales. Si el tope no lo cubriera, el
    // primer asiento abortaría y la wallet nunca arrancaría.
    expect(ONCHAIN_MAX_ADJUSTMENT).toBeGreaterThan(600);
  });

  it('el tope de FairPay cubre su salto real de agosto (+6.747,05)', () => {
    // FairPay no tiene extracto: la variación ENTERA del saldo cae en la línea
    // de conciliación, todos los días. Con el default de 1.000 el asiento del
    // 2026-08-17 (0 → 6.747,05) habría abortado y el canal seguiría en $0,00,
    // que es justo el síntoma que este trabajo vino a arreglar.
    expect(maxAdjustmentFor('fairpay')).toBe(MAX_ADJUSTMENT.fairpay);
    expect(maxAdjustmentFor('fairpay')).toBeGreaterThan(6_747.05);
    expect(maxAdjustmentFor('fairpay')).toBeGreaterThan(DEFAULT_MAX_ADJUSTMENT);
  });

  it('todo canal de libro automático tiene tope propio, no el default', () => {
    // Itera el registro: un canal automático nuevo que se olvide de su tope
    // rompe acá en vez de abortar todas las noches en producción.
    for (const key of API_LEDGER_CHANNELS) {
      expect(MAX_ADJUSTMENT[key]).toBeDefined();
      expect(maxAdjustmentFor(key)).not.toBe(DEFAULT_MAX_ADJUSTMENT);
    }
  });
});
