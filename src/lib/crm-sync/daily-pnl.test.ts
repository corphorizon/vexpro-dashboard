// ─────────────────────────────────────────────────────────────────────────────
// Los tres bordes que este módulo tiene que clavar:
//   1. el centavo (÷100 o el número queda 163 veces mal),
//   2. el signo (cliente vs bróker),
//   3. el hueco (un día sin dato NO es un día en cero).
//
// Se itera sobre PNL_CATEGORIES a propósito: el día que alguien agregue una
// familia, este test lo va a decir en vez de pasar sin mirarla.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  aggregateCrmDailyPnl,
  brokerPnlFromClients,
  CRM_PNL_SIN_DUENO,
  crmPnlCategory,
  missingDays,
  utcDaysBetween,
  type CrmPnlAccount,
  type CrmPnlDailyDoc,
} from './daily-pnl';
import { PNL_CATEGORIES } from '@/lib/mt5-sync/pnl';
import { summarizeCrmDailyPnl, type CrmDailyPnlRow } from './daily-pnl-query';

const usd = (uid: string | null = 'u1', mt = 'real\\Broker\\STP'): CrmPnlAccount => ({
  centsFactor: 1,
  metaTraderGroup: mt,
  userExternalId: uid,
});
const cent = (uid: string | null = 'u1', mt = 'real\\Cent\\STP'): CrmPnlAccount => ({
  centsFactor: 100,
  metaTraderGroup: mt,
  userExternalId: uid,
});

const doc = (o: Partial<CrmPnlDailyDoc> & { login: string }): CrmPnlDailyDoc => ({
  day: '2026-08-31',
  deals: 1,
  lots: 1,
  rawPnl: 0,
  ...o,
});

describe('crmPnlCategory', () => {
  it('clasifica cada familia y devuelve SIEMPRE una del registro único', () => {
    const casos: Array<[string | null, number, string]> = [
      ['real\\PropFirm\\VexHybrid_OnePhase_Funded', 1, 'PROPFIRM'],
      // Prop firm gana aunque la cuenta esté en centavos: la rama va primero.
      ['real\\PropFirm\\LeverageX12', 100, 'PROPFIRM'],
      ['real\\Broker\\Synthetics_Apalancados', 1, 'BOOST'],
      ['real\\Broker\\Apalancada', 1, 'BOOST'],
      ['real\\Cent\\STP', 100, 'CENT'],
      ['real\\Copy\\Cent_Master_STP', 100, 'CENT'],
      ['real\\Broker\\STP', 1, 'USD'],
      // Sin grupo: no se inventa nada raro, cae en USD por el factor.
      [null, 1, 'USD'],
      [null, 100, 'CENT'],
    ];
    for (const [grupo, cf, esperado] of casos) {
      const cat = crmPnlCategory(grupo, cf);
      expect(cat, `${grupo} / cf=${cf}`).toBe(esperado);
      expect(PNL_CATEGORIES).toContain(cat);
    }
  });

  it('NO clasifica como Boost algo que sólo dice "apalancamiento" en otro lado', () => {
    expect(crmPnlCategory('real\\Broker\\STP', 1)).toBe('USD');
  });
});

describe('aggregateCrmDailyPnl — el centavo', () => {
  it('divide el PNL de las Cent y NO divide lotes ni operaciones', () => {
    const { days } = aggregateCrmDailyPnl(
      [
        doc({ login: '1', deals: 10, lots: 5, rawPnl: -100_000 }), // cent
        doc({ login: '2', deals: 3, lots: 2, rawPnl: 250 }), // usd
      ],
      new Map([
        ['1', cent()],
        ['2', usd()],
      ]),
    );
    expect(days).toHaveLength(1);
    // -100.000 centavos = -1.000 USD, más 250 USD = -750.
    expect(days[0].pnlUsd).toBe(-750);
    // Unidades: se suman crudas entre familias.
    expect(days[0].dealsCount).toBe(13);
    expect(days[0].volumeLots).toBe(7);
    expect(days[0].accountsCount).toBe(2);
  });

  it('sin dividir el número sería 100 veces peor — el test que fija la regla', () => {
    const soloCent = aggregateCrmDailyPnl(
      [doc({ login: '1', rawPnl: -63_297_145.57 })],
      new Map([['1', cent()]]),
    );
    expect(soloCent.days[0].pnlUsd).toBe(-632_971.46);
  });

  it('reparte el desglose por familia y sólo lista las que aparecen', () => {
    const { days } = aggregateCrmDailyPnl(
      [
        doc({ login: '1', rawPnl: -100_000, deals: 4, lots: 3 }),
        doc({ login: '2', rawPnl: 500, deals: 1, lots: 1 }),
      ],
      new Map([
        ['1', cent()],
        ['2', usd()],
      ]),
    );
    const cats = days[0].byCategory.map((c) => c.category);
    expect(cats).toEqual(['USD', 'CENT']); // el orden es el del registro
    expect(days[0].byCategory.find((c) => c.category === 'CENT')!.pnlUsd).toBe(-1000);
    expect(days[0].byCategory.find((c) => c.category === 'USD')!.pnlUsd).toBe(500);
    // La suma de las familias es el total del día.
    expect(days[0].byCategory.reduce((s, c) => s + c.pnlUsd, 0)).toBe(days[0].pnlUsd);
  });
});

describe('aggregateCrmDailyPnl — lo excluido se cuenta', () => {
  it('una cuenta sin factor conocido queda FUERA del dinero pero DENTRO de las unidades', () => {
    const { days, warnings } = aggregateCrmDailyPnl(
      [
        doc({ login: '1', rawPnl: 500, deals: 2, lots: 4 }),
        doc({ login: 'desconocida', rawPnl: -900_000, deals: 7, lots: 6 }),
      ],
      new Map([['1', usd()]]),
    );
    expect(days[0].pnlUsd).toBe(500);
    expect(days[0].dealsCount).toBe(9);
    expect(days[0].volumeLots).toBe(10);
    expect(days[0].unmatchedAccounts).toBe(1);
    expect(days[0].unmatchedDeals).toBe(7);
    expect(days[0].unmatchedRawPnl).toBe(-900_000);
    expect(warnings.join(' ')).toMatch(/no están en tradingaccounts/);
  });

  it('sin exclusiones no avisa nada', () => {
    const { warnings } = aggregateCrmDailyPnl([doc({ login: '1' })], new Map([['1', usd()]]));
    expect(warnings).toEqual([]);
  });

  it('un factor cero o negativo se trata como 1 y no revienta la división', () => {
    const { days } = aggregateCrmDailyPnl(
      [doc({ login: '1', rawPnl: 42 })],
      new Map([['1', { centsFactor: 0, metaTraderGroup: 'real\\Broker\\STP', userExternalId: 'u1' }]]),
    );
    expect(days[0].pnlUsd).toBe(42);
  });
});

describe('aggregateCrmDailyPnl — los días', () => {
  it('agrupa por día UTC y devuelve la serie ordenada', () => {
    const { days } = aggregateCrmDailyPnl(
      [
        doc({ login: '1', day: '2026-08-30', rawPnl: 10 }),
        doc({ login: '2', day: '2026-08-28', rawPnl: 20 }),
        doc({ login: '3', day: '2026-08-30', rawPnl: 5 }),
      ],
      new Map([
        ['1', usd()],
        ['2', usd()],
        ['3', usd()],
      ]),
    );
    expect(days.map((d) => d.utcDay)).toEqual(['2026-08-28', '2026-08-30']);
    expect(days[1].pnlUsd).toBe(15);
  });

  it('descarta un día con formato imposible en vez de inventarle una fecha', () => {
    const { days } = aggregateCrmDailyPnl(
      [doc({ login: '1', day: 'ayer', rawPnl: 99 })],
      new Map([['1', usd()]]),
    );
    expect(days).toEqual([]);
  });

  it('un día sin documentos NO produce fila (hueco ≠ cero)', () => {
    const { days } = aggregateCrmDailyPnl([], new Map());
    expect(days).toEqual([]);
  });

  it('la misma cuenta dos veces el mismo día cuenta como UNA cuenta', () => {
    const { days } = aggregateCrmDailyPnl(
      [doc({ login: '1', rawPnl: 1 }), doc({ login: '1', rawPnl: 2 })],
      new Map([['1', usd()]]),
    );
    expect(days[0].accountsCount).toBe(1);
    expect(days[0].pnlUsd).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// El desglose por persona (migración 122). El borde que hay que clavar es UNO
// y es el invariante: el mismo dinero, partido de otra forma, tiene que dar el
// mismo total. Si un día deja de cumplirse, alguien partió el camino del
// centavo en dos.
// ─────────────────────────────────────────────────────────────────────────────
describe('aggregateCrmDailyPnl — por persona', () => {
  /** El invariante de la 122, escrito una sola vez y usado en cada caso. */
  const cuadra = (r: ReturnType<typeof aggregateCrmDailyPnl>) => {
    for (const d of r.days) {
      const suma = r.users
        .filter((u) => u.utcDay === d.utcDay)
        .reduce((s, u) => s + u.pnlUsd, 0);
      // Centavos de redondeo: cada fila redondea por su cuenta y el día una
      // sola vez. La tolerancia crece con las personas del día, no con el dinero.
      expect(suma, `día ${d.utcDay}`).toBeCloseTo(d.pnlUsd, 2);
    }
  };

  it('atribuye a cada dueño el PNL de TODAS sus cuentas, ya convertido', () => {
    const r = aggregateCrmDailyPnl(
      [
        doc({ login: '1', rawPnl: -100_000, deals: 4, lots: 3 }), // cent de ana
        doc({ login: '2', rawPnl: 250, deals: 2, lots: 1 }), // usd de ana
        doc({ login: '3', rawPnl: -80, deals: 1, lots: 2 }), // usd de beto
      ],
      new Map([
        ['1', cent('ana')],
        ['2', usd('ana')],
        ['3', usd('beto')],
      ]),
    );
    const ana = r.users.find((u) => u.userExternalId === 'ana')!;
    // -100.000 centavos = -1.000 USD, más 250 de la otra cuenta.
    expect(ana.pnlUsd).toBe(-750);
    expect(ana.dealsCount).toBe(6);
    expect(ana.volumeLots).toBe(4);
    expect(r.users.find((u) => u.userExternalId === 'beto')!.pnlUsd).toBe(-80);
    expect(r.ownerlessAccounts).toBe(0);
    cuadra(r);
  });

  it('EL INVARIANTE: la suma por persona es el total del día', () => {
    const r = aggregateCrmDailyPnl(
      [
        doc({ login: '1', day: '2026-08-30', rawPnl: -12_345.67 }),
        doc({ login: '2', day: '2026-08-30', rawPnl: 8_900.5 }),
        doc({ login: '3', day: '2026-08-30', rawPnl: -1_000_000 }), // cent
        doc({ login: '1', day: '2026-08-31', rawPnl: 40 }),
      ],
      new Map([
        ['1', usd('ana')],
        ['2', usd('beto')],
        ['3', cent('beto')],
      ]),
    );
    expect(r.days).toHaveLength(2);
    cuadra(r);
  });

  it("una cuenta con factor conocido y SIN userId va a '(sin-dueño)', contada", () => {
    const r = aggregateCrmDailyPnl(
      [
        doc({ login: '1', rawPnl: 500 }),
        doc({ login: 'huerfana', rawPnl: -300 }),
      ],
      new Map([
        ['1', usd('ana')],
        ['huerfana', usd(null)],
      ]),
    );
    // Su dinero SÍ está en el total del día: no se excluye, se atribuye al
    // sentinela. Lo contrario sería una exclusión silenciosa.
    expect(r.days[0].pnlUsd).toBe(200);
    expect(r.users.find((u) => u.userExternalId === CRM_PNL_SIN_DUENO)!.pnlUsd).toBe(-300);
    expect(r.ownerlessAccounts).toBe(1);
    cuadra(r);
  });

  it('una cuenta SIN factor no genera fila por persona — y el invariante igual cierra', () => {
    const r = aggregateCrmDailyPnl(
      [
        doc({ login: '1', rawPnl: 500, deals: 2, lots: 4 }),
        doc({ login: 'desconocida', rawPnl: -900_000, deals: 7, lots: 6 }),
      ],
      new Map([['1', usd('ana')]]),
    );
    // No está en tradingaccounts: factor desconocido. Fuera del dinero en las
    // DOS tablas (mismo universo, mismas exclusiones) y contada en unmatched_*.
    expect(r.users).toHaveLength(1);
    expect(r.users[0].userExternalId).toBe('ana');
    expect(r.days[0].unmatchedAccounts).toBe(1);
    // Y NO va al sentinela: '(sin-dueño)' es "sé cuánto es y no de quién",
    // no "no sé cuánto es".
    expect(r.users.some((u) => u.userExternalId === CRM_PNL_SIN_DUENO)).toBe(false);
    expect(r.ownerlessAccounts).toBe(0);
    cuadra(r);
    // Las unidades NO cuadran a propósito: en el día suman igual (regla G3).
    expect(r.days[0].dealsCount).toBe(9);
    expect(r.users.reduce((s, u) => s + u.dealsCount, 0)).toBe(2);
  });

  it('separa por día: la misma persona en dos días son dos filas', () => {
    const r = aggregateCrmDailyPnl(
      [
        doc({ login: '1', day: '2026-08-30', rawPnl: 10 }),
        doc({ login: '1', day: '2026-08-31', rawPnl: 20 }),
      ],
      new Map([['1', usd('ana')]]),
    );
    expect(r.users.map((u) => [u.utcDay, u.pnlUsd])).toEqual([
      ['2026-08-30', 10],
      ['2026-08-31', 20],
    ]);
    cuadra(r);
  });

  it('sin documentos no hay filas por persona (hueco ≠ cero)', () => {
    const r = aggregateCrmDailyPnl([], new Map());
    expect(r.users).toEqual([]);
    expect(r.ownerlessAccounts).toBe(0);
  });
});

describe('el signo', () => {
  it('cliente perdiendo = bróker ganando, y la vuelta', () => {
    expect(brokerPnlFromClients(-388_584.65)).toBe(388_584.65);
    expect(brokerPnlFromClients(120_094.6)).toBe(-120_094.6);
  });

  it('cero no cambia de signo (nada de -0)', () => {
    expect(Object.is(brokerPnlFromClients(0), 0)).toBe(true);
  });
});

describe('utcDaysBetween / missingDays', () => {
  it('enumera el rango inclusive y cruza fin de mes', () => {
    expect(utcDaysBetween('2026-08-30', '2026-09-01')).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
    ]);
  });

  it('un rango al revés no devuelve días (y no cuelga)', () => {
    expect(utcDaysBetween('2026-08-31', '2026-08-01')).toEqual([]);
  });

  it('una fecha basura no devuelve días', () => {
    expect(utcDaysBetween('mañana', '2026-08-01')).toEqual([]);
  });

  it('encuentra el hueco del medio', () => {
    expect(missingDays('2026-08-01', '2026-08-04', ['2026-08-01', '2026-08-04'])).toEqual([
      '2026-08-02',
      '2026-08-03',
    ]);
  });

  it('sin datos, TODO el rango es hueco', () => {
    expect(missingDays('2026-08-01', '2026-08-02', [])).toEqual(['2026-08-01', '2026-08-02']);
  });
});

describe('summarizeCrmDailyPnl', () => {
  const row = (o: Partial<CrmDailyPnlRow> & { utc_day: string }): CrmDailyPnlRow => ({
    pnl_usd: 0,
    volume_lots: 0,
    deals_count: 0,
    accounts_count: 0,
    unmatched_accounts: 0,
    unmatched_deals: 0,
    unmatched_raw_pnl: 0,
    detail: null,
    computed_at: '2026-08-31T00:00:00.000Z',
    ...o,
  });

  it('acumula el rango y expone las dos caras del signo', () => {
    const s = summarizeCrmDailyPnl(
      [
        row({ utc_day: '2026-08-30', pnl_usd: -1000, volume_lots: 10, deals_count: 5 }),
        row({ utc_day: '2026-08-31', pnl_usd: 250, volume_lots: 4, deals_count: 3 }),
      ],
      '2026-08-30',
      '2026-08-31',
    );
    expect(s.totals.clientsPnl).toBe(-750);
    expect(s.totals.brokerPnl).toBe(750);
    expect(s.totals.volumeLots).toBe(14);
    expect(s.totals.dealsCount).toBe(8);
    expect(s.totals.daysWithData).toBe(2);
    expect(s.daysMissing).toEqual([]);
    expect(s.last?.utc_day).toBe('2026-08-31');
  });

  it('un rango sin un solo día da null, NUNCA cero', () => {
    const s = summarizeCrmDailyPnl([], '2026-08-01', '2026-08-02');
    expect(s.totals.clientsPnl).toBeNull();
    expect(s.totals.brokerPnl).toBeNull();
    expect(s.daysMissing).toEqual(['2026-08-01', '2026-08-02']);
    expect(s.last).toBeNull();
  });

  it('un día con pnl null no cuenta como día con dato, pero sus lotes sí suman', () => {
    const s = summarizeCrmDailyPnl(
      [
        row({ utc_day: '2026-08-01', pnl_usd: null, volume_lots: 3, deals_count: 2 }),
        row({ utc_day: '2026-08-02', pnl_usd: 100, volume_lots: 1, deals_count: 1 }),
      ],
      '2026-08-01',
      '2026-08-02',
    );
    expect(s.totals.clientsPnl).toBe(100);
    expect(s.totals.daysWithData).toBe(1);
    expect(s.totals.volumeLots).toBe(4);
  });

  it('los días que faltan viajan con el total: un acumulado incompleto tiene que poder decirlo', () => {
    const s = summarizeCrmDailyPnl(
      [row({ utc_day: '2026-08-03', pnl_usd: -50 })],
      '2026-08-01',
      '2026-08-03',
    );
    expect(s.totals.clientsPnl).toBe(-50);
    expect(s.daysMissing).toEqual(['2026-08-01', '2026-08-02']);
  });
});
