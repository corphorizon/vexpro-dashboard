import { describe, expect, it } from 'vitest';
import { provisionalFileName, provisionalPeriodLabel, PROVISIONAL_NOTE } from './pdf-provisional';

describe('PDF provisional', () => {
  it('el archivo de un mes abierto lleva el sufijo; el cerrado queda igual', () => {
    expect(provisionalFileName('Distribucion_Socios_Sep_26.pdf', true)).toBe('Distribucion_Socios_Sep_26_PROVISIONAL.pdf');
    expect(provisionalFileName('Cierre_Mensual_Septiembre_2026.pdf', false)).toBe('Cierre_Mensual_Septiembre_2026.pdf');
  });
  it('el historial marca sólo los meses abiertos', () => {
    expect(provisionalPeriodLabel('Oct 26', false)).toBe('Oct 26 (provisional)');
    expect(provisionalPeriodLabel('Sep 26', true)).toBe('Sep 26');
  });
  it('el aviso dice por qué puede cambiar', () => {
    expect(PROVISIONAL_NOTE).toMatch(/período sigue abierto/);
    expect(PROVISIONAL_NOTE).toMatch(/7 días/);
  });
});
