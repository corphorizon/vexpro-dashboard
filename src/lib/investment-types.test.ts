import { describe, it, expect } from 'vitest';
import {
  inferMovementType,
  computeInvestmentTotals,
  movementTypeLabel,
  SELECTABLE_MOVEMENT_TYPES,
  MOVEMENT_TYPES,
} from './investment-types';

const row = (p: Partial<Parameters<typeof inferMovementType>[0]>) => ({
  deposit: 0, withdrawal: 0, profit: 0, concept: null, ...p,
});

describe('inferMovementType', () => {
  it('respeta el tipo ya guardado', () => {
    expect(inferMovementType(row({ deposit: 100, movement_type: 'profit_paid' }))).toBe('profit_paid');
  });

  it('un aporte es capital_in', () => {
    expect(inferMovementType(row({ deposit: 62500 }))).toBe('capital_in');
  });

  // El desempate por concepto es lo que evita que "Retiros" siga mezclando
  // devolución de capital con cobro de ganancias.
  it('distingue devolución de capital de cobro de ganancias por el concepto', () => {
    expect(inferMovementType(row({ withdrawal: 85000, concept: 'Reintegro inversión' })))
      .toBe('capital_out');
    expect(inferMovementType(row({ withdrawal: 5290, concept: 'Retiro profits' })))
      .toBe('profit_paid');
    expect(inferMovementType(row({ withdrawal: 2900, concept: 'Repartición Profit' })))
      .toBe('profit_paid');
    expect(inferMovementType(row({ withdrawal: 5106.21, concept: 'Devolucion profit Sergio a Coinsbuy' })))
      .toBe('profit_paid');
  });

  it('marca como mixta la fila con ganancia y retiro juntos', () => {
    expect(inferMovementType(row({ withdrawal: 3680, profit: 3680, concept: 'Profit Mayo 4%' })))
      .toBe('mixed');
  });

  it('una fila en cero no se clasifica', () => {
    expect(inferMovementType(row({}))).toBeNull();
  });
});

describe('computeInvestmentTotals', () => {
  // Reproduce la forma real de los datos de Vex Pro.
  const rows = [
    row({ deposit: 150000, concept: 'Inversión' }),
    row({ withdrawal: 85000, concept: 'Reintegro inversión' }),
    row({ profit: 6363.21, concept: 'Profit mayo 4.2421%' }),
    row({ withdrawal: 5290, concept: 'Retiro profits' }),
    row({ withdrawal: 3680, profit: 3680, concept: 'Profit Mayo 4%' }), // mixta
  ];
  const t = computeInvestmentTotals(rows);

  it('separa capital colocado de ganancias', () => {
    expect(t.contributions).toBe(150000);
    expect(t.redemptions).toBe(85000);
    expect(t.capitalPlaced).toBe(65000);
  });

  it('separa lo devengado de lo cobrado', () => {
    // 6363.21 de la fila normal + 3680 de la mixta.
    expect(t.profitAccrued).toBeCloseTo(10043.21, 2);
    // 5290 del retiro + 3680 de la mixta.
    expect(t.profitPaid).toBe(8970);
    expect(t.profitPending).toBeCloseTo(1073.21, 2);
  });

  it('cuenta las filas mixtas para poder avisarlas', () => {
    expect(t.mixedCount).toBe(1);
  });

  // Blindaje: el saldo NO puede separarse del que muestran Balances y los
  // reportes, que usan la fórmula de siempre.
  it('el saldo sigue siendo aporte − retiro + ganancia', () => {
    const esperado = rows.reduce((s, r) => s + r.deposit - r.withdrawal + r.profit, 0);
    expect(t.balance).toBeCloseTo(esperado, 2);
  });
});

describe('catálogo de tipos', () => {
  it('no ofrece `mixed` al cargar — es deuda histórica, no una opción', () => {
    expect(SELECTABLE_MOVEMENT_TYPES.map((m) => m.key)).not.toContain('mixed');
    expect(SELECTABLE_MOVEMENT_TYPES).toHaveLength(4);
  });

  it('cada tipo declara su columna de importe', () => {
    for (const m of MOVEMENT_TYPES) {
      expect(['deposit', 'withdrawal', 'profit']).toContain(m.field);
    }
  });

  it('etiqueta legible incluso sin tipo', () => {
    expect(movementTypeLabel('capital_out')).toBe('Devolución de capital');
    expect(movementTypeLabel(null)).toBe('Sin clasificar');
  });
});
