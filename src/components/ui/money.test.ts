// Money: formatea con formatMoney, nunca inventa un 0, colorea según tono.
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Money, moneyText, moneyToneClass, hasValue } from './money';

const render = (props: Parameters<typeof Money>[0]) => renderToStaticMarkup(createElement(Money, props));

describe('moneyText', () => {
  it('null / undefined / NaN / Infinity → «—», nunca $0.00', () => {
    for (const v of [null, undefined, NaN, Infinity, -Infinity]) {
      expect(moneyText(v as number | null | undefined)).toBe('—');
      expect(hasValue(v as number | null | undefined)).toBe(false);
    }
  });

  it('un cero de verdad sí es $0.00 (null y 0 no son lo mismo)', () => {
    expect(moneyText(0)).toBe('$0.00');
    expect(moneyText(-0.001)).toBe('$0.00');
  });

  it('delega en formatMoney (signo antes del símbolo, signed con U+2212, compact)', () => {
    expect(moneyText(-1234.5)).toBe('-$1,234.50');
    expect(moneyText(-12, { signed: true })).toBe('−$12.00');
    expect(moneyText(12, { signed: true })).toBe('+$12.00');
    expect(moneyText(45_205, { compact: true })).toBe('$45.2K');
  });
});

describe('moneyToneClass', () => {
  it("'auto' sólo pinta negativos", () => {
    expect(moneyToneClass(-1)).toBe('text-neg');
    expect(moneyToneClass(1)).toBeUndefined();
    expect(moneyToneClass(0)).toBeUndefined();
  });
  it("'sign' pinta los dos signos; lo que redondea a 0 no se pinta", () => {
    expect(moneyToneClass(5, 'sign')).toBe('text-pos');
    expect(moneyToneClass(-5, 'sign')).toBe('text-neg');
    expect(moneyToneClass(0.004, 'sign')).toBeUndefined();
    expect(moneyToneClass(-0.004, 'sign')).toBeUndefined();
  });
  it("'neutral' nunca colorea; 'pos'/'neg' fuerzan; null no tiene color", () => {
    expect(moneyToneClass(-5, 'neutral')).toBeUndefined();
    expect(moneyToneClass(-5, 'pos')).toBe('text-pos');
    expect(moneyToneClass(5, 'neg')).toBe('text-neg');
    expect(moneyToneClass(null, 'neg')).toBeUndefined();
  });
});

describe('<Money>', () => {
  it('lleva la clase de cifra (tabular, slashed-zero, nowrap)', () => {
    const out = render({ value: 1 });
    expect(out).toContain('num tabular-nums slashed-zero whitespace-nowrap');
    expect(out).toContain('$1.00');
  });

  it('null → «—» con texto para lectores, sin $0.00', () => {
    const out = render({ value: null, nullLabel: 'Sin dato' });
    expect(out).toContain('—');
    expect(out).toContain('Sin dato');
    expect(out).not.toContain('$0.00');
  });

  it('stale: subrayado punteado violeta, text-2, sin color de signo, title con el porqué', () => {
    const out = render({ value: -60_180.12, stale: 'Saldo de hace 26 h' });
    expect(out).toContain('decoration-dotted decoration-stale');
    expect(out).toContain('text-text-2');
    expect(out).not.toContain('text-neg');
    expect(out).toContain('title="Saldo de hace 26 h"');
    expect(out).toContain('data-stale="true"');
  });

  it('compact deja el valor exacto en el title', () => {
    const out = render({ value: 45_205, compact: true });
    expect(out).toContain('$45.2K');
    expect(out).toContain('title="$45,205.00"');
  });
});
