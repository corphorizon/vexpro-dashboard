import { describe, it, expect } from 'vitest';
import {
  brokerPnlForChain,
  daysInMonthUtc,
  indexBrokerPnlMonths,
  monthlyBrokerPnl,
  resolveBrokerPnl,
} from './broker-pnl';
import { brokerPnlFromClients } from './crm-sync/daily-pnl';
import { buildDistributionInputs } from './distribution-inputs';

// ─────────────────────────────────────────────────────────────────────────────
// Lo que estos tests fijan es la DECISIÓN de la que sale el dinero: qué
// período se recalcula y cuál no, y qué pasa cuando el dato falta. Los números
// salen de producción (medidos el 2026-08-31):
//
//   Vex Pro 2026-08 (ABIERTO)   manual $671.000,00  ·  CRM $386.665,54
//   Vex Pro 2026-07 (ABIERTO)   manual  $96.762,00  ·  CRM $129.083,80
//   Vex Pro 2026-06 (CERRADO)   manual $158.668,00  ·  CRM $252.933,85
//   Vex Pro 2025-10             27 de 31 días con dato (mes INCOMPLETO)
// ─────────────────────────────────────────────────────────────────────────────

const dia = (utc_day: string, pnl_usd: number | null, computed_at = '2026-08-31T02:00:00Z') => ({
  utc_day,
  pnl_usd,
  computed_at,
});

describe('daysInMonthUtc', () => {
  it('sabe de meses cortos y de bisiestos', () => {
    expect(daysInMonthUtc(2026, 8)).toBe(31);
    expect(daysInMonthUtc(2026, 6)).toBe(30);
    expect(daysInMonthUtc(2026, 2)).toBe(28);
    expect(daysInMonthUtc(2024, 2)).toBe(29);
  });
});

describe('monthlyBrokerPnl', () => {
  it('invierte el signo UNA vez: el cliente pierde, el bróker gana', () => {
    const [m] = monthlyBrokerPnl([dia('2026-08-01', -1000), dia('2026-08-02', -500)]);
    expect(m.brokerPnl).toBe(1500);
  });

  it('el signo coincide con `brokerPnlFromClients`, que es donde vive la decisión', () => {
    // La copia del `-x` en broker-pnl.ts existe porque el módulo original
    // arrastra `server-only` (ver la cabecera). Este test es el amarre que
    // impide que las dos se separen.
    const [m] = monthlyBrokerPnl([dia('2026-08-01', -387954.95)]);
    expect(m.brokerPnl).toBe(brokerPnlFromClients(-387954.95));
  });

  it('un día sin pnl es un día SIN DATO, no un día en cero', () => {
    const [m] = monthlyBrokerPnl([dia('2026-08-01', -100), dia('2026-08-02', null)]);
    expect(m.brokerPnl).toBe(100);
    expect(m.daysWithData).toBe(1);
    expect(m.daysInMonth).toBe(31);
  });

  it('un mes cuyas filas son TODAS nulas devuelve null, no 0', () => {
    // 0 diría "el bróker no ganó nada en agosto". No lo sabemos.
    const [m] = monthlyBrokerPnl([dia('2026-08-01', null), dia('2026-08-02', null)]);
    expect(m.brokerPnl).toBeNull();
    expect(m.daysWithData).toBe(0);
  });

  it('un día en CERO sí es un cero y cuenta como día con dato', () => {
    const [m] = monthlyBrokerPnl([dia('2026-08-01', 0)]);
    expect(m.brokerPnl).toBe(0);
    expect(m.daysWithData).toBe(1);
  });

  it('separa los meses por el borde UTC y los devuelve en orden', () => {
    const ms = monthlyBrokerPnl([
      dia('2026-08-01', -10),
      dia('2026-07-31', -20),
      dia('2026-06-30', -30),
    ]);
    expect(ms.map((m) => `${m.year}-${m.month}`)).toEqual(['2026-6', '2026-7', '2026-8']);
  });

  it('una fecha ilegible no cae en un mes cualquiera: se descarta', () => {
    const ms = monthlyBrokerPnl([
      { utc_day: 'basura', pnl_usd: -999 },
      { utc_day: '2026-13-01', pnl_usd: -999 },
      { utc_day: '', pnl_usd: -999 },
    ]);
    expect(ms).toEqual([]);
  });

  it('un mes incompleto se ve: 27 de 31 días (Vex Pro 2025-10)', () => {
    const rows = Array.from({ length: 27 }, (_, i) =>
      dia(`2025-10-${String(i + 1).padStart(2, '0')}`, -1000),
    );
    const [m] = monthlyBrokerPnl(rows);
    expect(m.daysWithData).toBe(27);
    expect(m.daysInMonth).toBe(31);
    expect(m.brokerPnl).toBe(27000);
  });

  it('se queda con el computed_at más reciente del mes', () => {
    const [m] = monthlyBrokerPnl([
      dia('2026-08-01', -1, '2026-08-02T00:00:00Z'),
      dia('2026-08-02', -1, '2026-08-31T09:00:00Z'),
    ]);
    expect(m.computedAt).toBe('2026-08-31T09:00:00Z');
  });
});

describe('resolveBrokerPnl', () => {
  const idx = indexBrokerPnlMonths(
    monthlyBrokerPnl([
      dia('2026-08-01', -386665.54),
      dia('2026-07-01', -129083.8),
      dia('2026-06-01', -252933.85),
    ]),
  );

  it('período CERRADO: manda el congelado y el CRM ni se mira', () => {
    // Vex Pro Jun 26 está cerrado con $158.668 y la plata ya se repartió.
    // Devolver los $252.933,85 del CRM reescribiría lo distribuido.
    const r = resolveBrokerPnl({ year: 2026, month: 6, is_closed: true }, idx, 158668);
    expect(r.value).toBe(158668);
    expect(r.source).toBe('frozen');
  });

  it('período ABIERTO: manda el CRM aunque haya un manual cargado', () => {
    // Ago 26: $671.000 tecleados contra $386.665,54 reales.
    const r = resolveBrokerPnl({ year: 2026, month: 8, is_closed: false }, idx, 671000);
    expect(r.value).toBe(386665.54);
    expect(r.source).toBe('crm');
  });

  it('período ABIERTO sin serie del CRM: SIN DATOS, no cero', () => {
    const r = resolveBrokerPnl({ year: 2026, month: 9, is_closed: false }, idx, 0);
    expect(r.value).toBeNull();
    expect(r.source).toBe('none');
  });

  it('período ABIERTO con serie pero sin ningún día utilizable: SIN DATOS', () => {
    const vacio = indexBrokerPnlMonths(monthlyBrokerPnl([dia('2026-09-01', null)]));
    const r = resolveBrokerPnl({ year: 2026, month: 9, is_closed: false }, vacio, 5);
    expect(r.value).toBeNull();
    expect(r.source).toBe('none');
  });

  it('período CERRADO sin manual cargado: SIN DATOS, no cero', () => {
    // AP Markets no tiene ni una fila de operating_income.
    const r = resolveBrokerPnl({ year: 2026, month: 6, is_closed: true }, idx, null);
    expect(r.value).toBeNull();
    expect(r.source).toBe('frozen');
  });

  it('un período abierto arrastra los días del mes para poder avisar el hueco', () => {
    const parcial = indexBrokerPnlMonths(
      monthlyBrokerPnl([dia('2026-09-01', -10), dia('2026-09-02', -10)]),
    );
    const r = resolveBrokerPnl({ year: 2026, month: 9, is_closed: false }, parcial, null);
    expect(r.daysWithData).toBe(2);
    expect(r.daysInMonth).toBe(30);
  });
});

describe('brokerPnlForChain', () => {
  it('sin dato cae al MANUAL heredado, nunca a 0', () => {
    // 0 achicaría la base distribuible y les pagaría de menos a los socios,
    // en silencio. Es el error que este repo persigue.
    const r = { value: null, source: 'none' as const, daysWithData: 0, daysInMonth: null, computedAt: null };
    expect(brokerPnlForChain(r, 96762)).toBe(96762);
  });

  it('sin dato y sin manual, 0 — pero es el ÚLTIMO recurso', () => {
    const r = { value: null, source: 'none' as const, daysWithData: 0, daysInMonth: null, computedAt: null };
    expect(brokerPnlForChain(r, null)).toBe(0);
    expect(brokerPnlForChain(r, undefined)).toBe(0);
  });

  it('con dato, el dato', () => {
    const r = { value: 386665.54, source: 'crm' as const, daysWithData: 31, daysInMonth: 31, computedAt: null };
    expect(brokerPnlForChain(r, 671000)).toBe(386665.54);
  });
});

describe('buildDistributionInputs · el corte manual → automático', () => {
  const periods = [
    { id: 'jun', year: 2026, month: 6, is_closed: true, reserve_pct: 0.1 },
    { id: 'jul', year: 2026, month: 7, is_closed: false, reserve_pct: 0.1 },
    { id: 'ago', year: 2026, month: 8, is_closed: false, reserve_pct: 0.1 },
  ];
  const sources = {
    operatingIncome: [
      { period_id: 'jun', broker_pnl: 158668, other: 0 },
      { period_id: 'jul', broker_pnl: 96762, other: 0 },
      { period_id: 'ago', broker_pnl: 671000, other: 23096.98 },
    ],
    propFirmSales: [],
    withdrawals: [],
    expenses: [],
    investments: [],
    businessModel: 'broker',
  };

  it('los períodos CERRADOS conservan su número: la serie automática no los toca', () => {
    const inputs = buildDistributionInputs(periods, {
      ...sources,
      // A propósito con el período cerrado adentro: tiene que ignorarse.
      brokerPnlByPeriod: new Map([['jun', 252933.85], ['ago', 386665.54]]),
    });
    expect(inputs.find((i) => i.periodId === 'jun')!.brokerPnl).toBe(158668);
    expect(inputs.find((i) => i.periodId === 'ago')!.brokerPnl).toBe(386665.54);
  });

  it('un período abierto SIN entrada en el mapa sigue con lo manual, no en cero', () => {
    const inputs = buildDistributionInputs(periods, {
      ...sources,
      brokerPnlByPeriod: new Map([['ago', 386665.54]]),
    });
    expect(inputs.find((i) => i.periodId === 'jul')!.brokerPnl).toBe(96762);
  });

  it('sin el mapa, todo se comporta exactamente como antes', () => {
    // El llamador viejo (o un test) no tiene por qué cambiar de resultado.
    const inputs = buildDistributionInputs(periods, sources);
    expect(inputs.map((i) => i.brokerPnl)).toEqual([158668, 96762, 671000]);
  });

  it('un cero del CRM SÍ pisa a lo manual: cero es un dato', () => {
    const inputs = buildDistributionInputs(periods, {
      ...sources,
      brokerPnlByPeriod: new Map([['ago', 0]]),
    });
    expect(inputs.find((i) => i.periodId === 'ago')!.brokerPnl).toBe(0);
  });

  it("en modelo 'company' el broker P&L sigue neutralizado, venga de donde venga", () => {
    const inputs = buildDistributionInputs(periods, {
      ...sources,
      businessModel: 'company',
      brokerPnlByPeriod: new Map([['ago', 386665.54]]),
    });
    expect(inputs.find((i) => i.periodId === 'ago')!.brokerPnl).toBe(0);
  });
});
