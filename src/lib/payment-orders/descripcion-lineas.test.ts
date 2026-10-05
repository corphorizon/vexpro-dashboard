// ─────────────────────────────────────────────────────────────────────────────
// descripcionDeLineas — el registro ÚNICO que arma el subtítulo de Egresos
// (payment_order_description) desde las líneas jsonb de una orden de pago.
//
// Se testea pura porque la consumen DOS caminos (api/bootstrap y
// fetchExpenses) y el bug del 2026-10-05 fue justamente que divergieran.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import { descripcionDeLineas } from './types';

describe('descripcionDeLineas', () => {
  it('una línea → su descripción tal cual', () => {
    expect(descripcionDeLineas([{ description: 'Salario Recepción Medellin' }]))
      .toBe('Salario Recepción Medellin');
  });

  it('varias líneas → unidas con ·', () => {
    expect(
      descripcionDeLineas([
        { description: 'Relojes y pillas' },
        { description: 'Mesas y sillas' },
      ]),
    ).toBe('Relojes y pillas · Mesas y sillas');
  });

  it('descripciones vacías o con espacios se saltan', () => {
    expect(
      descripcionDeLineas([
        { description: '  ' },
        { description: 'Wiki Finance EXPO Cyprus 2026' },
        { description: '' },
      ]),
    ).toBe('Wiki Finance EXPO Cyprus 2026');
  });

  it('todas vacías → null (la UI no muestra subtítulo)', () => {
    expect(descripcionDeLineas([{ description: '' }, { description: '   ' }])).toBeNull();
  });

  it('jsonb con forma inesperada → null, nunca lanza', () => {
    expect(descripcionDeLineas(null)).toBeNull();
    expect(descripcionDeLineas(undefined)).toBeNull();
    expect(descripcionDeLineas('texto suelto')).toBeNull();
    expect(descripcionDeLineas({ description: 'objeto, no array' })).toBeNull();
    expect(descripcionDeLineas([null, 42, 'x'])).toBeNull();
  });

  it('línea sin description u otra basura dentro del array no rompe las demás', () => {
    expect(
      descripcionDeLineas([{ amount: 10 }, { description: 'Metaquotes Exura' }, null]),
    ).toBe('Metaquotes Exura');
  });
});
