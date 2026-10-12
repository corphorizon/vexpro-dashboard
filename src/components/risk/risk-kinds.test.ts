import { describe, expect, it } from 'vitest';
import {
  bandKind,
  checkKind,
  decisionKind,
  depositStatusKind,
  factorKind,
  levelKind,
  marginKind,
  outcomeKind,
  withdrawalStatusKind,
} from './risk-kinds';

describe('bandKind — banda del score → color', () => {
  it('bajo = ok, medio = pend, alto = bad', () => {
    expect(bandKind('low')).toBe('ok');
    expect(bandKind('medium')).toBe('pend');
    expect(bandKind('high')).toBe('bad');
  });
  it('sin banda (nunca se revisó) es neutral, nunca ok', () => {
    expect(bandKind(null)).toBe('neutral');
    expect(bandKind(undefined)).toBe('neutral');
  });
});

describe('withdrawalStatusKind — status_norm de crm_withdrawals', () => {
  it('approved (= COMPLETED) es ok — el mapa viejo preguntaba por «completed» y lo dejaba gris', () => {
    expect(withdrawalStatusKind('approved')).toBe('ok');
    // `completed` NO existe en el CHECK de retiros (migración 088).
    expect(withdrawalStatusKind('completed')).toBe('neutral');
  });
  it('rejected = bad, pending = pend, cancelled = neutral', () => {
    expect(withdrawalStatusKind('rejected')).toBe('bad');
    expect(withdrawalStatusKind('pending')).toBe('pend');
    expect(withdrawalStatusKind('cancelled')).toBe('neutral');
  });
  it('un estado desconocido o null es neutral', () => {
    expect(withdrawalStatusKind('ON_FIRE')).toBe('neutral');
    expect(withdrawalStatusKind(null)).toBe('neutral');
    // Una clave heredada de Object.prototype no es un estado.
    expect(withdrawalStatusKind('toString')).toBe('neutral');
  });
});

describe('depositStatusKind — status_norm de crm_deposits', () => {
  it('completed = ok, in_review = info, pending = pend', () => {
    expect(depositStatusKind('completed')).toBe('ok');
    expect(depositStatusKind('in_review')).toBe('info');
    expect(depositStatusKind('pending')).toBe('pend');
    expect(depositStatusKind('cancelled')).toBe('neutral');
  });
});

describe('decisionKind / factorKind', () => {
  it('escalar requiere a finanzas (pend); aprobar ok; rechazar bad', () => {
    expect(decisionKind('escalate')).toBe('pend');
    expect(decisionKind('approve')).toBe('ok');
    expect(decisionKind('reject')).toBe('bad');
    expect(decisionKind(null)).toBe('neutral');
  });
  it('un factor que empuja a rechazar es bad', () => {
    expect(factorKind('down')).toBe('bad');
    expect(factorKind('up')).toBe('ok');
    expect(factorKind('neutral')).toBe('neutral');
  });
});

describe('checkKind — «sin comprobar» NO es cumplida', () => {
  it('unverifiable va en pend, nunca en ok', () => {
    expect(checkKind('unverifiable')).toBe('pend');
    expect(checkKind('pass')).toBe('ok');
    expect(checkKind('fail')).toBe('bad');
  });
});

describe('levelKind / outcomeKind / marginKind', () => {
  it('riesgo de cuenta y toxicidad', () => {
    expect(levelKind('alto')).toBe('bad');
    expect(levelKind('medio')).toBe('pend');
    expect(levelKind('ok')).toBe('ok');
    expect(levelKind(null)).toBe('neutral');
  });
  it('veredicto del reglamento de prop firm', () => {
    expect(outcomeKind('ok')).toBe('ok');
    expect(outcomeKind('denied_new_period')).toBe('pend');
    expect(outcomeKind('denied_no_new_period')).toBe('bad');
    expect(outcomeKind('cannot_review')).toBe('neutral');
    expect(outcomeKind(null)).toBe('neutral');
  });
  it('margen: la lista del server decide el color', () => {
    expect(marginKind('critical')).toBe('bad');
    expect(marginKind('watch')).toBe('pend');
  });
});
