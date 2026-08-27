import { describe, it, expect } from 'vitest';
import {
  buildRollup,
  flattenRollup,
  resolveNetDepositGoal,
  isFirstCalendarMonth,
  suggestNetDepositWarnings,
  monthToFirstDay,
  isWarningMotive,
  type RollupProfile,
} from './net-deposit';

// Los números de esta batería NO son inventados: son la estructura de Hugo
// Ortiz en julio 2026 tal como quedó cargada en commercial_monthly_results. Si
// alguien cambia el armado del árbol, lo que se rompe es el número que Daniela
// citó en la reunión (525.791) y eso se ve acá antes que en producción.

const perfil = (p: Partial<RollupProfile> & { id: string }): RollupProfile => ({
  name: p.id,
  role: 'bdm',
  head_id: null,
  salary: null,
  hire_date: null,
  status: 'active',
  termination_date: null,
  ...p,
});

describe('buildRollup — la estructura de Hugo, julio 2026', () => {
  // Hugo (sales_manager) con sus cuatro heads. Los valores `own` son los que
  // Daniela cargó como net_deposit_current de cada head bajo Hugo.
  const profiles = [
    perfil({ id: 'hugo', role: 'sales_manager' }),
    perfil({ id: 'archi', role: 'head', head_id: 'hugo' }),
    perfil({ id: 'luka', role: 'head', head_id: 'hugo' }),
    perfil({ id: 'nico', role: 'head', head_id: 'hugo' }),
    perfil({ id: 'victor', role: 'head', head_id: 'hugo' }),
  ];
  const net = new Map<string, number>([
    ['hugo', -3489],
    ['archi', 17842],
    ['luka', 485340],
    ['nico', 41810],
    ['victor', -15712],
  ]);

  it('el total de la estructura da los 525.791 que salieron del CRM', () => {
    const [root] = buildRollup(profiles, net);
    expect(root.profileId).toBe('hugo');
    expect(root.team).toBe(529280); // la suma de sus cuatro heads
    expect(root.total).toBe(525791); // el número que citó Daniela
  });

  it('el ajuste del líder es su propia línea directa (−3.489)', () => {
    const [root] = buildRollup(profiles, net);
    expect(root.adjustment).toBe(-3489);
    expect(root.adjustment).toBe(root.total - root.team);
  });

  it('los miembros vienen ordenados de mayor a menor', () => {
    const [root] = buildRollup(profiles, net);
    expect(root.children.map((c) => c.profileId)).toEqual(['luka', 'nico', 'archi', 'victor']);
  });

  it('un perfil sin movimiento en el CRM vale cero, no rompe', () => {
    const [root] = buildRollup([...profiles, perfil({ id: 'nuevo', head_id: 'hugo' })], net);
    const nuevo = root.children.find((c) => c.profileId === 'nuevo');
    expect(nuevo?.own).toBe(0);
    expect(nuevo?.total).toBe(0);
  });
});

describe('buildRollup — casos que rompen árboles', () => {
  it('un head_id que apunta a alguien ausente deja la rama suelta, no la pierde', () => {
    const nodes = buildRollup(
      [perfil({ id: 'huerfano', head_id: 'jefe-que-no-esta' })],
      new Map([['huerfano', 100]]),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].total).toBe(100);
  });

  it('un ciclo A→B→A no cuelga la pantalla', () => {
    const nodes = buildRollup(
      [perfil({ id: 'a', head_id: 'b' }), perfil({ id: 'b', head_id: 'a' })],
      new Map([['a', 10], ['b', 20]]),
    );
    // Sea cual sea la raíz que salga primero, la otra queda como hija una sola
    // vez y el total suma los dos una vez.
    const totales = flattenRollup(nodes).map((f) => f.node.own);
    expect(totales.sort()).toEqual([10, 20]);
  });

  it('anida tres niveles y suma de abajo hacia arriba', () => {
    const nodes = buildRollup(
      [
        perfil({ id: 'sm', role: 'sales_manager' }),
        perfil({ id: 'head', head_id: 'sm' }),
        perfil({ id: 'bdm', head_id: 'head' }),
      ],
      new Map([['sm', 1], ['head', 10], ['bdm', 100]]),
    );
    expect(nodes[0].total).toBe(111);
    expect(nodes[0].children[0].total).toBe(110);
    expect(flattenRollup(nodes).map((f) => f.depth)).toEqual([0, 1, 2]);
  });
});

describe('buildRollup — el manual convive con el calculado', () => {
  it('expone lo cargado a mano sin pisarlo', () => {
    const [root] = buildRollup(
      [perfil({ id: 'x' })],
      new Map([['x', 259584]]),
      new Map([['x', 237667]]),
    );
    expect(root.own).toBe(259584);
    expect(root.manual).toBe(237667);
  });

  it('sin nada cargado el manual es null, no cero (cero es un valor cargado)', () => {
    const [root] = buildRollup([perfil({ id: 'x' })], new Map(), new Map());
    expect(root.manual).toBeNull();
  });
});

describe('resolveNetDepositGoal — los escalones que dictó Daniela', () => {
  const goals = [
    { salary: 1000, min_net_deposit: 30000 },
    { salary: 1500, min_net_deposit: 40000 },
    { salary: 2000, min_net_deposit: 50000 },
  ];

  it('los tres escalones exactos', () => {
    expect(resolveNetDepositGoal(1000, goals)).toBe(30000);
    expect(resolveNetDepositGoal(1500, goals)).toBe(40000);
    expect(resolveNetDepositGoal(2000, goals)).toBe(50000);
  });

  it('un salario intermedio usa el escalón de abajo', () => {
    expect(resolveNetDepositGoal(1200, goals)).toBe(30000);
    expect(resolveNetDepositGoal(1999, goals)).toBe(40000);
  });

  it('un salario por encima del último escalón usa el último', () => {
    expect(resolveNetDepositGoal(3500, goals)).toBe(50000);
  });

  it('por debajo del primer escalón, o sin salario, no hay meta', () => {
    expect(resolveNetDepositGoal(300, goals)).toBeNull();
    expect(resolveNetDepositGoal(null, goals)).toBeNull();
  });

  it('sin escalones cargados no inventa ninguno', () => {
    expect(resolveNetDepositGoal(2000, [])).toBeNull();
  });
});

describe('isFirstCalendarMonth — el mes que la empresa se banca', () => {
  it('el mes de ingreso está exento aunque haya entrado el día 28', () => {
    expect(isFirstCalendarMonth('2026-07-28', '2026-07')).toBe(true);
    expect(isFirstCalendarMonth('2026-07-01', '2026-07-01')).toBe(true);
  });
  it('el mes siguiente ya cuenta', () => {
    expect(isFirstCalendarMonth('2026-07-28', '2026-08')).toBe(false);
  });
  it('sin fecha de ingreso no hay exención', () => {
    expect(isFirstCalendarMonth(null, '2026-08')).toBe(false);
  });
});

describe('suggestNetDepositWarnings', () => {
  const goals = [{ salary: 1000, min_net_deposit: 30000 }, { salary: 2000, min_net_deposit: 50000 }];
  const base = {
    goals,
    month: '2026-08',
    alreadyWarned: new Set<string>(),
  };

  it('sugiere a quien quedó bajo su meta, con el faltante', () => {
    const out = suggestNetDepositWarnings({
      ...base,
      profiles: [perfil({ id: 'a', salary: 1000, hire_date: '2025-01-01' })],
      netByProfile: new Map([['a', 12000]]),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ goal: 30000, net: 12000, shortfall: 18000 });
  });

  it('no sugiere a quien llegó a la meta', () => {
    const out = suggestNetDepositWarnings({
      ...base,
      profiles: [perfil({ id: 'a', salary: 1000, hire_date: '2025-01-01' })],
      netByProfile: new Map([['a', 30000]]),
    });
    expect(out).toEqual([]);
  });

  it('no sugiere en el primer mes — «es el riesgo que corre la empresa»', () => {
    const out = suggestNetDepositWarnings({
      ...base,
      profiles: [perfil({ id: 'a', salary: 2000, hire_date: '2026-08-04' })],
      netByProfile: new Map(),
    });
    expect(out).toEqual([]);
  });

  it('no sugiere a un despedido ni a un inactivo', () => {
    const out = suggestNetDepositWarnings({
      ...base,
      profiles: [
        perfil({ id: 'a', salary: 2000, hire_date: '2025-01-01', status: 'inactive', termination_date: '2026-07-30' }),
        perfil({ id: 'b', salary: 2000, hire_date: '2025-01-01', status: 'inactive' }),
      ],
      netByProfile: new Map(),
    });
    expect(out).toEqual([]);
  });

  it('no repite lo que ya se confirmó ese mes', () => {
    const out = suggestNetDepositWarnings({
      ...base,
      alreadyWarned: new Set(['a']),
      profiles: [perfil({ id: 'a', salary: 1000, hire_date: '2025-01-01' })],
      netByProfile: new Map(),
    });
    expect(out).toEqual([]);
  });

  it('sin meta aplicable no molesta a nadie', () => {
    const out = suggestNetDepositWarnings({
      ...base,
      profiles: [perfil({ id: 'a', salary: 300, hire_date: '2025-01-01' }), perfil({ id: 'b', hire_date: '2025-01-01' })],
      netByProfile: new Map(),
    });
    expect(out).toEqual([]);
  });

  it('ordena por faltante, el más grave arriba', () => {
    const out = suggestNetDepositWarnings({
      ...base,
      profiles: [
        perfil({ id: 'chico', salary: 1000, hire_date: '2025-01-01' }),
        perfil({ id: 'grande', salary: 2000, hire_date: '2025-01-01' }),
      ],
      netByProfile: new Map([['chico', 29000], ['grande', 0]]),
    });
    expect(out.map((s) => s.profileId)).toEqual(['grande', 'chico']);
  });
});

describe('monthToFirstDay / isWarningMotive', () => {
  it('lleva cualquier fecha del mes al día 1 (el CHECK de la DB no acepta otra)', () => {
    expect(monthToFirstDay('2026-07')).toBe('2026-07-01');
    expect(monthToFirstDay('2026-07-23')).toBe('2026-07-01');
  });
  it('solo pasan los tres motivos de la reunión', () => {
    expect(isWarningMotive('net_deposit')).toBe(true);
    expect(isWarningMotive('new_lines')).toBe(true);
    expect(isWarningMotive('team_creation')).toBe(true);
    expect(isWarningMotive('llegadas_tarde')).toBe(false);
    expect(isWarningMotive(null)).toBe(false);
  });
});
