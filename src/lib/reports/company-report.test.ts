import { describe, it, expect } from 'vitest';
import {
  UNCATEGORIZED,
  buildExpenses,
  buildResult,
  companyReportCsvRows,
  periodsInRange,
  type CompanyReport,
} from './company-report';

const periods = [
  { id: 'jun', year: 2026, month: 6, label: 'Jun 26' },
  { id: 'jul', year: 2026, month: 7, label: 'Jul 26' },
  { id: 'ago', year: 2026, month: 8, label: 'Ago 26' },
];

describe('periodsInRange', () => {
  it('toma solo el mes de un rango de un día', () => {
    expect(periodsInRange(periods, '2026-07-15', '2026-07-15').map((p) => p.id)).toEqual(['jul']);
  });

  it('toma los dos meses de un rango a caballo', () => {
    expect(periodsInRange(periods, '2026-06-28', '2026-07-04').map((p) => p.id)).toEqual(['jun', 'jul']);
  });

  it('devuelve vacío si el rango cae fuera de la contabilidad cargada', () => {
    expect(periodsInRange(periods, '2025-01-01', '2025-02-01')).toEqual([]);
  });
});

describe('buildExpenses', () => {
  it('agrupa por categoría y manda las sin categoría al sentinel', () => {
    const r = buildExpenses([
      { category: 'Sueldos', amount: 100, paid: 100, pending: 0 },
      { category: 'Sueldos', amount: 50, paid: 20, pending: 30 },
      { category: null, amount: 10, paid: 0, pending: 10 },
    ]);
    expect(r.total).toBe(160);
    expect(r.paid).toBe(120);
    expect(r.pending).toBe(40);
    // Ordenado de mayor a menor: Sueldos primero.
    expect(r.categories.map((c) => c.category)).toEqual(['Sueldos', UNCATEGORIZED]);
    expect(r.categories[0]).toMatchObject({ amount: 150, paid: 120, pending: 30, count: 2 });
  });
});

describe('buildResult', () => {
  it('suma la cadena de los meses del rango y calcula el resultado de caja', () => {
    const r = buildResult(1000, 400, [
      { ingresosNetos: 600, egresosNetos: 200, saldoAFavor: 400, reserveThisPeriod: 40, montoDistribuir: 360 },
      { ingresosNetos: 500, egresosNetos: 300, saldoAFavor: 200, reserveThisPeriod: 20, montoDistribuir: 180 },
    ]);
    expect(r.cashResult).toBe(600);
    expect(r.ingresosNetos).toBe(1100);
    expect(r.saldoAFavor).toBe(600);
    expect(r.montoDistribuir).toBe(540);
  });
});

describe('companyReportCsvRows', () => {
  it('exporta las cuatro secciones', () => {
    const report: CompanyReport = {
      range: { from: '2026-08-01', to: '2026-08-09' },
      periods: [{ id: 'ago', label: 'Ago 26' }],
      billing: {
        billed: 100,
        collected: 60,
        pending: 40,
        clientCount: 1,
        withDebt: 1,
        clients: [{ key: 'acme', name: 'Acme', billed: 100, collected: 60, pending: 40 }],
      },
      expenses: buildExpenses([{ category: 'Sueldos', amount: 30, paid: 30, pending: 0 }]),
      result: buildResult(60, 30, []),
      cash: {
        summary: { liquid: 500, lent: 100, total: 600, fund: 600, outsideFund: 0 },
        byType: [],
        byUnit: [
          {
            unit: null,
            total: 500,
            locations: [
              {
                channel_key: 'bank',
                label: 'Banco',
                location_type: 'bank',
                business_unit_id: null,
                holder: null,
                is_visible: true,
                sort_order: 0,
                balance: 500,
              },
            ],
          },
        ],
      },
    };

    const rows = companyReportCsvRows(report);
    const sections = new Set(rows.map((r) => String(r[0])));
    expect(sections).toContain('Facturación');
    expect(sections).toContain('Egresos');
    expect(sections).toContain('Resultado');
    expect(sections).toContain('Dinero');
    expect(rows).toContainEqual(['Facturación · Clientes', 'Acme', 100]);
    expect(rows).toContainEqual(['Dinero · Ubicaciones', 'Banco', 500]);
  });
});
