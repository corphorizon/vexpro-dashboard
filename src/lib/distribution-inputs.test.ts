import { describe, it, expect } from 'vitest';
import {
  buildDistributionInputs,
  type DistributionSources,
  type PeriodForInputs,
} from './distribution-inputs';

// Blinda el CONSTRUCTOR único de insumos de la cadena (antes copiado tres
// veces en data-context.tsx). Lo que se prueba acá es QUÉ números entran; la
// fórmula en sí vive en distribution.test.ts.

const periods: PeriodForInputs[] = [
  { id: 'p1', year: 2026, month: 1, label: 'Ene 26', is_closed: true, reserve_pct: 0.1 },
  { id: 'p2', year: 2026, month: 2, label: 'Feb 26', is_closed: false, reserve_pct: 0.2 },
];

const sources = (over: Partial<DistributionSources> = {}): DistributionSources => ({
  operatingIncome: [
    { period_id: 'p1', broker_pnl: 1000, other: 500 },
    { period_id: 'p2', broker_pnl: 2000, other: 0 },
  ],
  propFirmSales: [{ period_id: 'p1', amount: 300 }],
  withdrawals: [
    { period_id: 'p1', category: 'prop_firm', amount: 100 },
    { period_id: 'p1', category: 'broker', amount: 9999 },
  ],
  expenses: [
    { period_id: 'p1', amount: 200 },
    { period_id: 'p1', amount: 50 },
  ],
  investments: [{ date: '2026-02-14', profit: 77 }],
  ...over,
});

describe('buildDistributionInputs — armado de insumos', () => {
  it('un input por período, EN ORDEN y con la metadata del forecast', () => {
    const inputs = buildDistributionInputs(periods, sources());
    expect(inputs.map(i => i.periodId)).toEqual(['p1', 'p2']);
    expect(inputs[0]).toMatchObject({ year: 2026, month: 1, label: 'Ene 26', isClosed: true });
    expect(inputs[1]).toMatchObject({ year: 2026, month: 2, label: 'Feb 26', isClosed: false });
  });

  it('label cae a mes/año cuando el período no tiene etiqueta', () => {
    const inputs = buildDistributionInputs(
      [{ id: 'p1', year: 2026, month: 3, label: null, reserve_pct: 0.1 }],
      sources(),
    );
    expect(inputs[0].label).toBe('3/2026');
  });

  it('propFirmNetIncome = ventas − retiros de prop firm (y SOLO esos retiros)', () => {
    const [p1] = buildDistributionInputs(periods, sources());
    // 300 de venta − 100 de retiro prop_firm. El retiro 'broker' de 9999 no
    // toca la cadena: los retiros de clientes no son egreso del negocio.
    expect(p1.propFirmNetIncome).toBe(200);
    expect(p1.totalExpenses).toBe(250);
  });

  it('suma los retiros de prop firm duplicados en vez de pisarlos', () => {
    // Antes de la migración 065 podía haber dos filas de la misma categoría.
    // "La última gana" hacía divergir esta cadena del consolidado.
    const [p1] = buildDistributionInputs(
      periods,
      sources({
        withdrawals: [
          { period_id: 'p1', category: 'prop_firm', amount: 100 },
          { period_id: 'p1', category: 'prop_firm', amount: 50 },
        ],
      }),
    );
    expect(p1.propFirmNetIncome).toBe(150); // 300 − (100 + 50)
  });

  it('las inversiones se fechan por año/mes, no por period_id', () => {
    const inputs = buildDistributionInputs(periods, sources());
    expect(inputs[0].investmentProfits).toBe(0);
    expect(inputs[1].investmentProfits).toBe(77);
  });

  it('una inversión fuera de todo período no entra en ningún lado', () => {
    const inputs = buildDistributionInputs(
      periods,
      sources({ investments: [{ date: '2025-12-01', profit: 999 }, { date: null, profit: 5 }] }),
    );
    expect(inputs.every(i => i.investmentProfits === 0)).toBe(true);
  });

  it('período sin ingresos operativos ni egresos entra en cero, no se saltea', () => {
    const inputs = buildDistributionInputs(periods, sources({ operatingIncome: [], expenses: [] }));
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toMatchObject({ brokerPnl: 0, other: 0, totalExpenses: 0 });
  });

  it('reservePct viaja tal cual (la fórmula decide el default)', () => {
    const inputs = buildDistributionInputs(periods, sources());
    expect(inputs[0].reservePct).toBe(0.1);
    expect(inputs[1].reservePct).toBe(0.2);
  });
});

describe('buildDistributionInputs — neutralización por modelo de negocio', () => {
  it("modelo 'company': brokerPnl y propFirmNetIncome entran en cero", () => {
    const asCompany = buildDistributionInputs(periods, sources({ businessModel: 'company' }));
    expect(asCompany[0].brokerPnl).toBe(0);
    expect(asCompany[0].propFirmNetIncome).toBe(0);
    // Lo que SÍ factura una empresa de servicios (other = líneas cobradas) y
    // sus egresos siguen intactos.
    expect(asCompany[0].other).toBe(500);
    expect(asCompany[0].totalExpenses).toBe(250);
  });

  it("modelo 'company': investmentProfits también entra en cero", () => {
    // features('company').investments === false ⇒ /inversiones está bloqueado
    // y la columna ni figura en el consolidado. Si la ganancia igual entrara a
    // la base, sería la misma plata fantasma que brokerPnl.
    const asCompany = buildDistributionInputs(periods, sources({ businessModel: 'company' }));
    expect(asCompany[1].investmentProfits).toBe(0);
    // Y en broker sigue entrando.
    const asBroker = buildDistributionInputs(periods, sources({ businessModel: 'broker' }));
    expect(asBroker[1].investmentProfits).toBe(77);
  });

  it("modelo 'broker' (y default/desconocido) mantiene los tres términos", () => {
    for (const model of ['broker', undefined, null, 'marciano']) {
      const inputs = buildDistributionInputs(periods, sources({ businessModel: model }));
      expect(inputs[0].brokerPnl).toBe(1000);
      expect(inputs[0].propFirmNetIncome).toBe(200);
      expect(inputs[1].investmentProfits).toBe(77);
    }
  });

  it('broker vs company difieren EXACTAMENTE en los términos neutralizados', () => {
    const asBroker = buildDistributionInputs(periods, sources({ businessModel: 'broker' }));
    const asCompany = buildDistributionInputs(periods, sources({ businessModel: 'company' }));
    asBroker.forEach((b, i) => {
      const c = asCompany[i];
      expect({
        ...c,
        brokerPnl: b.brokerPnl,
        propFirmNetIncome: b.propFirmNetIncome,
        investmentProfits: b.investmentProfits,
      }).toEqual(b);
    });
  });
});

describe('buildDistributionInputs — base CAJA de egresos (solo company)', () => {
  // Fixture con las dos caras del egreso: 1.000 devengados de los que solo
  // salieron 400 de la caja.
  const conPagado = (over: Partial<DistributionSources> = {}) =>
    sources({
      expenses: [
        { period_id: 'p1', amount: 600, paid: 400 },
        { period_id: 'p1', amount: 400, paid: 0 }, // factura recibida y NO pagada
      ],
      ...over,
    });

  it("modelo 'company' resta lo PAGADO, no lo devengado", () => {
    const [p1] = buildDistributionInputs(periods, conPagado({ businessModel: 'company' }));
    expect(p1.totalExpenses).toBe(400);
  });

  it("modelo 'broker' (y default) sigue restando lo DEVENGADO", () => {
    // NO se toca por diseño: en producción AP Markets tiene ~$24.900 de
    // egresos con paid = 0 (ese equipo no usa el campo). Aplicarle caja le
    // llevaría los egresos a cero e inflaría su base distribuible.
    for (const model of ['broker', undefined, null, 'marciano']) {
      const [p1] = buildDistributionInputs(periods, conPagado({ businessModel: model }));
      expect(p1.totalExpenses).toBe(1000);
    }
  });

  it("'paid: 0' es un dato real: en company esa factura no resta", () => {
    const [p1] = buildDistributionInputs(
      periods,
      sources({ businessModel: 'company', expenses: [{ period_id: 'p1', amount: 5000, paid: 0 }] }),
    );
    expect(p1.totalExpenses).toBe(0);
  });

  it('sin columna `paid` se cae al devengado en vez de inflar la base', () => {
    // Si el llamador no trajo `paid`, restar de más es el error seguro.
    const [p1] = buildDistributionInputs(
      periods,
      sources({ businessModel: 'company', expenses: [{ period_id: 'p1', amount: 5000 }] }),
    );
    expect(p1.totalExpenses).toBe(5000);
  });
});

// ── Prop firm automático como insumo de la cadena (Kevin, 2026-09-01) ───────
describe('pfAutoByPeriod', () => {
  const base = {
    operatingIncome: [], propFirmSales: [], withdrawals: [], expenses: [],
    investments: [], businessModel: 'broker' as const,
  };
  const abierto = { id: 'p8', year: 2026, month: 8, label: 'Ago', is_closed: false, reserve_pct: 0.1 };
  const cerrado = { id: 'p7', year: 2026, month: 7, label: 'Jul', is_closed: true, reserve_pct: 0.1 };

  it('abierto sin manual toma el automático (ventas − retiros)', () => {
    const [row] = buildDistributionInputs([abierto] as never, {
      ...base,
      pfAutoByPeriod: new Map([['p8', { sales: 11981.7, withdrawals: 2819.04 }]]),
    } as never);
    expect(row.propFirmNetIncome).toBeCloseTo(9162.66, 2);
  });

  it('manual > 0 es override: el automático no lo pisa', () => {
    const [row] = buildDistributionInputs([abierto] as never, {
      ...base,
      propFirmSales: [{ period_id: 'p8', amount: 5000 }],
      pfAutoByPeriod: new Map([['p8', { sales: 11981.7, withdrawals: 0 }]]),
    } as never);
    expect(row.propFirmNetIncome).toBe(5000);
  });

  it('cerrado NUNCA lee el automático', () => {
    const [row] = buildDistributionInputs([cerrado] as never, {
      ...base,
      propFirmSales: [{ period_id: 'p7', amount: 100 }],
      pfAutoByPeriod: new Map([['p7', { sales: 99999, withdrawals: 0 }]]),
    } as never);
    expect(row.propFirmNetIncome).toBe(100);
  });

  it('sin serie del CRM cae al manual aunque sea 0 — nunca inventa', () => {
    const [row] = buildDistributionInputs([abierto] as never, base as never);
    expect(row.propFirmNetIncome).toBe(0);
  });
});
