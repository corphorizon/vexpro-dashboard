// RRHH «Libro mayor»: los registros de color por estado (uno por dominio,
// iterados para que un estado nuevo rompa el test), los KPIs que NO inventan
// $0 y el aplanado del árbol de la estructura.
import { describe, it, expect } from 'vitest';
import { translations } from '@/lib/i18n';
import { STATUS_KINDS } from '@/components/ui/status-kind';
import type { HrOverviewResponse } from '@/lib/hr/overview';
import {
  EMPLOYEE_STATUS_VIEW,
  IB_ALERT_KIND,
  NEG_STATUSES,
  NEG_STATUS_VIEW,
  NET_SOURCE_VIEW,
  PROFILE_STATUS_FILTERS,
  STATUS_LABEL_KEYS,
  WARNING_SERIOUS_AT,
  WARNING_WATCH_AT,
  alertsKpi,
  flattenTree,
  headcount,
  matchesStatusFilter,
  negStatusView,
  payrollOfPeriod,
  pctText,
  profileStatusView,
  sumKnown,
  supervisorChain,
  teamNetKpi,
  warningSeverity,
} from './hr-view';

const LOCALES = ['en', 'es'] as const;

/** Las vistas con etiqueta, para iterar sobre TODAS en los chequeos comunes. */
const VIEW_REGISTRIES = {
  NEG_STATUS_VIEW,
  EMPLOYEE_STATUS_VIEW,
  NET_SOURCE_VIEW,
} as const;

describe('registros de estado → color', () => {
  for (const [name, registry] of Object.entries(VIEW_REGISTRIES)) {
    it(`${name}: cada kind es uno de los seis de la spec`, () => {
      for (const v of Object.values(registry)) expect(STATUS_KINDS).toContain(v.kind);
    });
    it(`${name}: cada etiqueta existe en en y es`, () => {
      for (const v of Object.values(registry)) {
        for (const l of LOCALES) expect(translations[l][v.labelKey], `${v.labelKey} ${l}`).toBeTruthy();
      }
    });
    it(`${name}: ningún estado es «ok» por defecto — al menos uno no lo es`, () => {
      expect(Object.values(registry).some((v) => v.kind !== 'ok')).toBe(true);
    });
  }

  it('una negociación cerrada NO es roja (spec §5.5: «Cerrado» = neutro)', () => {
    expect(NEG_STATUS_VIEW.closed.kind).toBe('neutral');
    expect(NEG_STATUS_VIEW.closed.kind).not.toBe('bad');
  });

  it('NEG_STATUSES sale del mapa (no es una segunda lista)', () => {
    expect(NEG_STATUSES).toEqual(Object.keys(NEG_STATUS_VIEW));
  });

  it('estado de negociación desconocido / null → gris, nunca ok', () => {
    expect(negStatusView('archivada').kind).toBe('neutral');
    expect(negStatusView(null).kind).toBe('neutral');
    expect(negStatusView(undefined).kind).toBe('neutral');
    expect(negStatusView('').kind).toBe('neutral');
  });

  it('un empleado inactivo (licencia) NO es rojo; en prueba es info', () => {
    expect(EMPLOYEE_STATUS_VIEW.inactive.kind).toBe('neutral');
    expect(EMPLOYEE_STATUS_VIEW.probation.kind).toBe('info');
    expect(EMPLOYEE_STATUS_VIEW.fired.kind).not.toBe('bad');
  });

  it('STATUS_LABEL_KEYS (el del CSV) es el mismo mapa que pinta el badge', () => {
    for (const [k, v] of Object.entries(EMPLOYEE_STATUS_VIEW)) {
      expect(STATUS_LABEL_KEYS[k as keyof typeof STATUS_LABEL_KEYS]).toBe(v.labelKey);
    }
  });

  it('procedencia: CRM es info (fuente automática), «sin datos» es stale, nunca verde', () => {
    expect(NET_SOURCE_VIEW.crm.kind).toBe('info');
    expect(NET_SOURCE_VIEW.none.kind).toBe('stale');
    for (const v of Object.values(NET_SOURCE_VIEW)) expect(v.kind).not.toBe('ok');
  });

  it('alertas de rebates: verde ok, rojo bad, amarillo/naranja pend', () => {
    expect(IB_ALERT_KIND).toEqual({ green: 'ok', yellow: 'pend', orange: 'pend', red: 'bad' });
  });
});

describe('profileStatusView', () => {
  it('despedido = inactive + fecha de baja (mismo criterio que hr/domain.ts)', () => {
    expect(profileStatusView({ status: 'inactive', termination_date: '2026-09-01' }).labelKey).toBe('hr.statusFired');
  });
  it('inactive SIN fecha es licencia, no despido', () => {
    expect(profileStatusView({ status: 'inactive', termination_date: null }).labelKey).toBe('hr.statusInactive');
    expect(profileStatusView({ status: 'inactive' }).labelKey).toBe('hr.statusInactive');
  });
  it('active con fecha cargada sigue activo (la fecha sola no despide)', () => {
    expect(profileStatusView({ status: 'active', termination_date: '2026-09-01' }).kind).toBe('ok');
  });
  it('estado libre desconocido → gris', () => {
    expect(profileStatusView({ status: 'pausa' }).kind).toBe('neutral');
  });
});

describe('warningSeverity — el umbral de Daniela', () => {
  it('2 = mirar de cerca (pend), 3+ = serio (bad)', () => {
    expect(warningSeverity(WARNING_WATCH_AT)).toBe('pend');
    expect(warningSeverity(WARNING_SERIOUS_AT)).toBe('bad');
    expect(warningSeverity(7)).toBe('bad');
  });
  it('0 y 1 no se pintan', () => {
    expect(warningSeverity(0)).toBe('neutral');
    expect(warningSeverity(1)).toBe('neutral');
  });
  it('NaN / Infinity no se pintan (un dato roto no es una alerta)', () => {
    expect(warningSeverity(Number.NaN)).toBe('neutral');
    expect(warningSeverity(Number.POSITIVE_INFINITY)).toBe('neutral');
  });
});

describe('flattenTree', () => {
  type N = { profileId: string; children: N[] };
  const n = (id: string, ...children: N[]): N => ({ profileId: id, children });
  const tree = [n('sm', n('h1', n('b1'), n('b2')), n('h2')), n('solo')];

  it('orden de lectura: padre y después sus hijos, con su nivel', () => {
    const rows = flattenTree(tree, new Set());
    expect(rows.map((r) => `${r.node.profileId}@${r.depth}`)).toEqual([
      'sm@0', 'h1@1', 'b1@2', 'b2@2', 'h2@1', 'solo@0',
    ]);
  });
  it('un nodo colapsado esconde TODO lo que cuelga, no sólo el primer nivel', () => {
    const rows = flattenTree(tree, new Set(['sm']));
    expect(rows.map((r) => r.node.profileId)).toEqual(['sm', 'solo']);
    expect(rows[0].collapsed).toBe(true);
    expect(rows[0].hasKids).toBe(true);
  });
  it('colapsar una hoja no cambia nada; un id inexistente tampoco', () => {
    expect(flattenTree(tree, new Set(['b1', 'nadie']))).toHaveLength(6);
  });
  it('árbol vacío → sin filas', () => {
    expect(flattenTree([], new Set())).toEqual([]);
  });
});

describe('supervisorChain', () => {
  const p = (id: string, head_id: string | null) => ({ id, name: id.toUpperCase(), head_id });
  const all = [p('sm', null), p('h', 'sm'), p('b', 'h'), p('m', 'b')];
  const byId = new Map(all.map((x) => [x.id, x]));

  it('de arriba hacia abajo', () => {
    expect(supervisorChain(byId.get('m')!, byId).map((x) => x.id)).toEqual(['sm', 'h', 'b']);
  });
  it('sin supervisor → cadena vacía', () => {
    expect(supervisorChain(byId.get('sm')!, byId)).toEqual([]);
  });
  it('supervisor que no está en la lista → corta ahí, no inventa', () => {
    expect(supervisorChain(p('x', 'fantasma'), byId)).toEqual([]);
  });
  it('un ciclo en head_id no cuelga la pantalla', () => {
    const a = p('a', 'b2');
    const b2 = p('b2', 'a');
    const cyc = new Map([[a.id, a], [b2.id, b2]]);
    expect(supervisorChain(a, cyc).map((x) => x.id)).toEqual(['b2']);
  });
  it('respeta maxDepth', () => {
    expect(supervisorChain(byId.get('m')!, byId, 2).map((x) => x.id)).toEqual(['h', 'b']);
  });
});

describe('matchesStatusFilter', () => {
  it('all deja pasar todo', () => {
    for (const s of ['active', 'inactive', 'raro']) expect(matchesStatusFilter({ status: s }, 'all')).toBe(true);
  });
  it('active sólo active; inactive incluye despedidos y estados libres', () => {
    expect(matchesStatusFilter({ status: 'active' }, 'active')).toBe(true);
    expect(matchesStatusFilter({ status: 'inactive' }, 'active')).toBe(false);
    expect(matchesStatusFilter({ status: 'inactive' }, 'inactive')).toBe(true);
    expect(matchesStatusFilter({ status: 'active' }, 'inactive')).toBe(false);
    expect(matchesStatusFilter({ status: 'raro' }, 'inactive')).toBe(true);
  });
  it('active + inactive = all, para cualquier lista (los conteos del Segmented cuadran)', () => {
    const list = ['active', 'inactive', 'active', 'raro'].map((status) => ({ status }));
    const count = (f: (typeof PROFILE_STATUS_FILTERS)[number]) => list.filter((x) => matchesStatusFilter(x, f)).length;
    expect(count('active') + count('inactive')).toBe(count('all'));
  });
});

describe('headcount', () => {
  it('administrativos activos + en prueba + comerciales activos', () => {
    const hc = headcount(
      [{ status: 'active' }, { status: 'probation' }, { status: 'inactive' }],
      [{ status: 'active' }, { status: 'inactive' }],
    );
    expect(hc).toEqual({ total: 3, admin: 2, commercial: 1, probation: 1 });
  });
  it('nadie → 0 (acá el cero ES el dato: no hay nadie)', () => {
    expect(headcount([], [])).toEqual({ total: 0, admin: 0, commercial: 0, probation: 0 });
  });
});

describe('payrollOfPeriod — sin filas guardadas no es $0', () => {
  it('cero filas → null (sin calcular), no 0', () => {
    expect(payrollOfPeriod([])).toEqual({ total: null, commissions: null, salaries: null, rows: 0 });
  });
  it('suma comisión real + salario, como antes', () => {
    const r = payrollOfPeriod([
      { real_payment: 100, salary_paid: 50 },
      { real_payment: -20, salary_paid: 0 },
    ]);
    expect(r).toEqual({ total: 130, commissions: 80, salaries: 50, rows: 2 });
  });
  it('filas guardadas que suman 0 SÍ son 0 (es un dato medido)', () => {
    expect(payrollOfPeriod([{ real_payment: 0, salary_paid: 0 }]).total).toBe(0);
  });
  it('un campo null dentro de una fila suma 0 (el criterio de siempre)', () => {
    expect(payrollOfPeriod([{ real_payment: null, salary_paid: 10 }]).total).toBe(10);
  });
});

function overview(
  over: Partial<Omit<HrOverviewResponse, 'data'>> & { data?: Partial<HrOverviewResponse['data']> } = {},
): HrOverviewResponse {
  const { data: _data, ...rest } = over;
  return {
    month: '2026-09-01',
    hasPeriod: true,
    period: null,
    partial: [],
    goalRows: [],
    ...rest,
    data: {
      profiles: [],
      net: { tree: [], unassigned: 500, totalAssigned: 10_000, totalCrm: 10_500 },
      monthlyResults: [],
      goals: [],
      warnings: { ofMonth: [], totals: {}, suggestions: [], metrics: [] },
      ..._data,
    },
  };
}

describe('teamNetKpi — «Net CRM sin dato» nunca es $0', () => {
  it('con el slice → atribuido + sin asignar', () => {
    expect(teamNetKpi(overview(), false)).toEqual({ state: 'ok', assigned: 10_000, unassigned: 500, totalCrm: 10_500 });
  });
  it('slice `net` en partial → missing y null, aunque venga un objeto', () => {
    const r = teamNetKpi(overview({ partial: ['net'] }), false);
    expect(r.state).toBe('missing');
    expect(r.assigned).toBeNull();
  });
  it('net null → missing', () => {
    expect(teamNetKpi(overview({ data: { net: null } }), false).assigned).toBeNull();
  });
  it('sin overview y cargando → loading; sin overview y sin carga (error) → missing', () => {
    expect(teamNetKpi(null, true).state).toBe('loading');
    expect(teamNetKpi(null, false).state).toBe('missing');
  });
  it('un net medido en 0 SÍ es 0', () => {
    const r = teamNetKpi(overview({ data: { net: { tree: [], unassigned: 0, totalAssigned: 0, totalCrm: 0 } } }), false);
    expect(r).toMatchObject({ state: 'ok', assigned: 0 });
  });
});

describe('alertsKpi', () => {
  it('cuenta los del mes, los sugeridos y los que acumulan 2+', () => {
    const r = alertsKpi(
      overview({
        data: {
          warnings: {
            ofMonth: [{ id: 'w', profile_id: 'a', month: '2026-09-01', motive: 'net_deposit', detail: null, created_by_name: null, created_at: '' }],
            totals: { a: 1, b: 2, c: 3 },
            suggestions: [{ profileId: 'z' } as never],
            metrics: [],
          },
        },
      }),
      false,
    );
    expect(r).toEqual({ state: 'ok', ofMonth: 1, suggested: 1, repeat: 2 });
  });
  it('slice warnings caído → null, no 0 («nadie tiene alertas» sería falso)', () => {
    expect(alertsKpi(overview({ partial: ['warnings'] }), false).ofMonth).toBeNull();
    expect(alertsKpi(overview({ data: { warnings: null } }), false).ofMonth).toBeNull();
  });
});

describe('sumKnown', () => {
  it('suma lo conocido y cuenta lo que falta', () => {
    expect(sumKnown([1, null, 2, undefined, Number.NaN], (x) => x)).toEqual({ sum: 3, missing: 3 });
  });
  it('todo desconocido → null, no 0', () => {
    expect(sumKnown([null, undefined], (x) => x)).toEqual({ sum: null, missing: 2 });
  });
  it('lista vacía → null (no hay nada que sumar ni que contar)', () => {
    expect(sumKnown([], (x: number) => x)).toEqual({ sum: null, missing: 0 });
  });
  it('ceros medidos suman 0', () => {
    expect(sumKnown([0, 0], (x) => x)).toEqual({ sum: 0, missing: 0 });
  });
});

describe('pctText', () => {
  it('número → «n%»; null/undefined/NaN → null', () => {
    expect(pctText(7.5)).toBe('7.5%');
    expect(pctText(0)).toBe('0%');
    expect(pctText(null)).toBeNull();
    expect(pctText(undefined)).toBeNull();
    expect(pctText(Number.NaN)).toBeNull();
  });
});

describe('i18n del bloque «Libro mayor» RRHH', () => {
  const hrvKeys = (l: (typeof LOCALES)[number]) => Object.keys(translations[l]).filter((k) => k.startsWith('hrv.'));
  const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

  it('en y es tienen las mismas claves hrv.*', () => {
    expect(hrvKeys('es').sort()).toEqual(hrvKeys('en').sort());
    expect(hrvKeys('en').length).toBeGreaterThan(0);
  });
  it('y los mismos {parámetros} en cada una', () => {
    for (const k of hrvKeys('en')) expect(params(translations.es[k]), k).toBe(params(translations.en[k]));
  });
});
