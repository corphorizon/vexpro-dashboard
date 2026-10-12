import { describe, expect, it } from 'vitest';
import { accountBalanceRows, attributionGap, splitCheck } from './liquidity-view';

describe('attributionGap', () => {
  it('cuadra al centavo', () => {
    expect(attributionGap(1000, 1000.004)).toEqual({ gap: 0, matches: true });
  });
  it('positivo = falta atribuir', () => {
    expect(attributionGap(800, 1000)).toEqual({ gap: 200, matches: false });
  });
  it('negativo = se atribuyó de más (no se esconde con un abs)', () => {
    expect(attributionGap(1200, 1000)).toEqual({ gap: -200, matches: false });
  });
  it('sin total no hay comparación: null, y no «cuadra»', () => {
    expect(attributionGap(0, null)).toEqual({ gap: null, matches: false });
    expect(attributionGap(0, Number.NaN)).toEqual({ gap: null, matches: false });
  });
});

describe('accountBalanceRows', () => {
  const accounts = [
    { id: 'a', mt_number: '1' },
    { id: 'b', mt_number: '2' },
    { id: 'c', mt_number: '3' },
    { id: 'd', mt_number: '4' },
  ];
  it('deja sólo las cuentas con saldo, de mayor a menor', () => {
    const out = accountBalanceRows(accounts, { a: 10, b: 500, c: 0.001, d: -40 });
    expect(out.map((r) => r.id)).toEqual(['b', 'a', 'd']);
  });
  it('una cuenta sin entrada en el mapa no aparece como $0', () => {
    expect(accountBalanceRows(accounts, {})).toEqual([]);
  });
});

describe('splitCheck', () => {
  const mov = { deposit: 1000, withdrawal: 0 };
  it('ok cuando las partes suman exacto', () => {
    const r = splitCheck([{ deposit: '600', withdrawal: '' }, { deposit: '400', withdrawal: '' }], mov);
    expect(r).toMatchObject({ dep: 1000, wit: 0, diffDep: 0, diffWit: 0, ok: true });
  });
  it('dice cuánto falta (negativo) y no da ok', () => {
    const r = splitCheck([{ deposit: '600', withdrawal: '' }, { deposit: '', withdrawal: '' }], mov);
    expect(r.diffDep).toBe(-400);
    expect(r.ok).toBe(false);
  });
  it('dice cuánto sobra (positivo) y no da ok', () => {
    const r = splitCheck([{ deposit: '700', withdrawal: '' }, { deposit: '400', withdrawal: '' }], mov);
    expect(r.diffDep).toBe(100);
    expect(r.ok).toBe(false);
  });
  it('una salida que aparece en las partes sin estar en el original rompe el cuadre', () => {
    const r = splitCheck([{ deposit: '1000', withdrawal: '5' }], mov);
    expect(r.diffWit).toBe(5);
    expect(r.ok).toBe(false);
  });
  it('texto no numérico cuenta como 0, no como NaN', () => {
    const r = splitCheck([{ deposit: 'abc', withdrawal: '' }], mov);
    expect(r.dep).toBe(0);
    expect(r.ok).toBe(false);
  });
  it('sin errores de coma flotante: 0.1 + 0.2 = 0.3', () => {
    expect(splitCheck([{ deposit: '0.1', withdrawal: '' }, { deposit: '0.2', withdrawal: '' }], { deposit: 0.3, withdrawal: 0 }).ok).toBe(true);
  });
});
