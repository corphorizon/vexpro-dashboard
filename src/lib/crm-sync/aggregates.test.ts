// ─────────────────────────────────────────────────────────────────────────────
// La aduana del conector de Orion.
//
// `tradingaccounts` guarda `masterPassword` e `investorPassword` EN TEXTO PLANO
// en el origen. La defensa real es la PROYECCIÓN: lo que no se pide no viaja
// por la red, no llega a memoria y no puede terminar en un log.
//
// Estos tests son la afirmación contra la que se comprueba esa defensa. Atlas
// tiene los suyos del otro lado; acordamos que la lista viva en los dos,
// porque la de ellos protege lo que entra por SU sync y no lo que salga por
// una API nuestra.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  ORION_WALLET_FIELDS,
  ORION_TRADING_ACCOUNT_FIELDS,
  ORION_SOCIAL_ACCOUNT_FIELDS,
  ORION_FORBIDDEN_FIELDS,
  projectionOf,
} from './aggregates';

const TODAS_LAS_LISTAS = [
  ['wallets', ORION_WALLET_FIELDS],
  ['tradingaccounts', ORION_TRADING_ACCOUNT_FIELDS],
  ['socialtradingaccounts', ORION_SOCIAL_ACCOUNT_FIELDS],
] as const;

describe('aduana: ningún campo prohibido se pide a Orion', () => {
  it.each(TODAS_LAS_LISTAS)('%s no pide ningún campo prohibido', (_coleccion, campos) => {
    for (const prohibido of ORION_FORBIDDEN_FIELDS) {
      expect(campos as readonly string[]).not.toContain(prohibido);
    }
  });

  it.each(TODAS_LAS_LISTAS)('la proyección de %s tampoco los incluye', (_coleccion, campos) => {
    // Se comprueba sobre la proyección REAL que se manda a Mongo, no sobre la
    // lista: si alguien construyera la proyección de otra forma, esto lo caza.
    const proyeccion = projectionOf(campos);
    for (const prohibido of ORION_FORBIDDEN_FIELDS) {
      expect(proyeccion).not.toHaveProperty(prohibido);
    }
  });

  it('las contraseñas de MetaTrader están en la lista de prohibidos', () => {
    // Si alguien las saca de la lista, los tests de arriba dejan de proteger
    // en silencio. Por eso se fijan por nombre.
    expect(ORION_FORBIDDEN_FIELDS).toContain('masterPassword');
    expect(ORION_FORBIDDEN_FIELDS).toContain('investorPassword');
    // La billetera de destino de un retiro: un agente de call center no tiene
    // ningún motivo para verla.
    expect(ORION_FORBIDDEN_FIELDS).toContain('targetAddress');
  });

  it('de KYC no entra ningún documento, sólo el estado', () => {
    for (const doc of ['frontPageId', 'backPageId', 'proofOfAddress', 'selfie']) {
      expect(ORION_FORBIDDEN_FIELDS).toContain(doc);
    }
  });
});

describe('projectionOf', () => {
  it('pide exactamente lo listado y nada más', () => {
    expect(projectionOf(['a', 'b'])).toEqual({ a: 1, b: 1 });
  });

  it('las listas son mínimas: pedir de más es exponerse de más', () => {
    // Cada campo que se agregue acá viaja por la red. La lista de
    // tradingaccounts es la más sensible: es la que tiene las contraseñas.
    expect(ORION_TRADING_ACCOUNT_FIELDS).toEqual(['userId', 'real']);
    expect(ORION_SOCIAL_ACCOUNT_FIELDS).toEqual(['userId']);
    expect(ORION_WALLET_FIELDS).toEqual(['userId', 'walletType', 'balance']);
  });
});
