import { describe, it, expect } from 'vitest';
import {
  HR_NET_AUTO_DESDE,
  antesDelCorteHrNet,
  descontarSubredesDeMasters,
  esOverrideManual,
  indexarNetDelCrm,
  netParaElMotor,
  resolveNetDepositInput,
  type CrmNetIndex,
} from './net-deposit-input';
import { buildRollup, type RollupProfile } from './net-deposit';
import { calculateCommission } from '@/lib/commission-calculator';

const ABIERTO = { year: 2026, month: 8, is_closed: false };
const CERRADO = { year: 2026, month: 8, is_closed: true };
const ANTES = { year: 2026, month: 7, is_closed: false };

const idx = (entries: [string, { own: number; total: number }][]): CrmNetIndex => new Map(entries);

describe('el corte de agosto 2026', () => {
  it('está en agosto de 2026 (mismo criterio que BROKER_PNL_AUTO_DESDE)', () => {
    expect(HR_NET_AUTO_DESDE).toEqual({ year: 2026, month: 8 });
  });

  it('deja afuera todo mes anterior y deja pasar agosto y lo que sigue', () => {
    expect(antesDelCorteHrNet({ year: 2026, month: 7 })).toBe(true);
    expect(antesDelCorteHrNet({ year: 2025, month: 12 })).toBe(true);
    expect(antesDelCorteHrNet({ year: 2026, month: 8 })).toBe(false);
    expect(antesDelCorteHrNet({ year: 2026, month: 9 })).toBe(false);
    expect(antesDelCorteHrNet({ year: 2027, month: 1 })).toBe(false);
  });

  it('un mes anterior al corte usa el manual aunque el CRM tenga número', () => {
    const r = resolveNetDepositInput({
      profileId: 'a',
      period: ANTES,
      scope: 'structure',
      crm: idx([['a', { own: 10, total: 999 }]]),
      manual: 485_340,
    });
    expect(r.value).toBe(485_340);
    expect(r.source).toBe('frozen');
    // El automático viaja igual, para poder mostrarlo al lado como referencia.
    expect(r.crm).toBe(999);
  });

  it('un mes anterior al corte SIN manual es «sin datos», no 0', () => {
    const r = resolveNetDepositInput({
      profileId: 'a', period: ANTES, scope: 'structure',
      crm: idx([['a', { own: 1, total: 2 }]]), manual: null,
    });
    expect(r.value).toBeNull();
    expect(r.source).toBe('none');
  });

  it('un período CERRADO manda el manual aunque sea posterior al corte', () => {
    const r = resolveNetDepositInput({
      profileId: 'a', period: CERRADO, scope: 'structure',
      crm: idx([['a', { own: 1, total: 2 }]]), manual: 7,
    });
    expect(r.value).toBe(7);
    expect(r.source).toBe('frozen');
  });
});

describe('automático manda, manual es override', () => {
  it('sin manual usa el CRM', () => {
    const r = resolveNetDepositInput({
      profileId: 'a', period: ABIERTO, scope: 'structure',
      crm: idx([['a', { own: 100, total: 500 }]]), manual: null,
    });
    expect(r).toEqual({ value: 500, source: 'crm', crm: 500, manual: null });
  });

  it('con manual cargado, el manual manda y queda rotulado', () => {
    const r = resolveNetDepositInput({
      profileId: 'a', period: ABIERTO, scope: 'structure',
      crm: idx([['a', { own: 100, total: 500 }]]), manual: 480,
    });
    expect(r.value).toBe(480);
    expect(r.source).toBe('manual');
    expect(r.crm).toBe(500);
  });

  it('un manual NEGATIVO también es override (los ND negativos son reales)', () => {
    const r = resolveNetDepositInput({
      profileId: 'a', period: ABIERTO, scope: 'structure',
      crm: idx([['a', { own: 0, total: 500 }]]), manual: -11_228.65,
    });
    expect(r.value).toBe(-11_228.65);
    expect(r.source).toBe('manual');
  });

  it('un manual en 0 NO es override: es el default del input, y gana el CRM', () => {
    expect(esOverrideManual(0)).toBe(false);
    expect(esOverrideManual(null)).toBe(false);
    expect(esOverrideManual(undefined)).toBe(false);
    expect(esOverrideManual(-1)).toBe(true);
    const r = resolveNetDepositInput({
      profileId: 'a', period: ABIERTO, scope: 'structure',
      crm: idx([['a', { own: 0, total: 500 }]]), manual: 0,
    });
    expect(r.value).toBe(500);
    expect(r.source).toBe('crm');
  });

  it('sin CRM y sin manual es «sin datos», NO $0', () => {
    const r = resolveNetDepositInput({
      profileId: 'a', period: ABIERTO, scope: 'structure', crm: null, manual: null,
    });
    expect(r.value).toBeNull();
    expect(r.source).toBe('none');
    expect(r.crm).toBeNull();
  });

  it('sin CRM pero con manual cargado, el manual manda', () => {
    const r = resolveNetDepositInput({
      profileId: 'a', period: ABIERTO, scope: 'structure', crm: null, manual: 123,
    });
    expect(r.value).toBe(123);
    expect(r.source).toBe('manual');
  });

  it('un perfil que no está en el índice del CRM es «sin datos», no cero', () => {
    const r = resolveNetDepositInput({
      profileId: 'fantasma', period: ABIERTO, scope: 'structure',
      crm: idx([['a', { own: 1, total: 2 }]]), manual: null,
    });
    expect(r.value).toBeNull();
    expect(r.source).toBe('none');
  });

  it('un CRM en cero SÍ es un dato: source crm, value 0', () => {
    const r = resolveNetDepositInput({
      profileId: 'a', period: ABIERTO, scope: 'structure',
      crm: idx([['a', { own: 0, total: 0 }]]), manual: null,
    });
    expect(r.value).toBe(0);
    expect(r.source).toBe('crm');
  });
});

describe('la semántica own vs total (el bug caro)', () => {
  const crm = idx([['luka', { own: -11_228.65, total: 496_374.53 }]]);

  it('MIEMBRO de un grupo → el TOTAL de su estructura', () => {
    const r = resolveNetDepositInput({ profileId: 'luka', period: ABIERTO, scope: 'structure', crm, manual: null });
    expect(r.value).toBe(496_374.53);
  });

  it('EL HEAD en su propio grupo → su producción propia (la línea de ajuste)', () => {
    const r = resolveNetDepositInput({ profileId: 'luka', period: ABIERTO, scope: 'own', crm, manual: null });
    expect(r.value).toBe(-11_228.65);
  });

  it('para un BDM sin equipo las dos lecturas dan lo mismo', () => {
    const soloBdm = idx([['antony', { own: 212_025.95, total: 212_025.95 }]]);
    const a = resolveNetDepositInput({ profileId: 'antony', period: ABIERTO, scope: 'own', crm: soloBdm, manual: null });
    const b = resolveNetDepositInput({ profileId: 'antony', period: ABIERTO, scope: 'structure', crm: soloBdm, manual: null });
    expect(a.value).toBe(b.value);
  });
});

describe('el índice sale del mismo árbol que mira RRHH', () => {
  const perfiles: RollupProfile[] = [
    { id: 'head', name: 'Head', role: 'head', head_id: null, salary: null, hire_date: null, status: 'active' },
    { id: 'bdm1', name: 'BDM 1', role: 'bdm', head_id: 'head', salary: null, hire_date: null, status: 'active' },
    { id: 'bdm2', name: 'BDM 2', role: 'bdm', head_id: 'head', salary: null, hire_date: null, status: 'active' },
  ];

  it('own y total del árbol, por perfil', () => {
    const tree = buildRollup(perfiles, new Map([['head', -100], ['bdm1', 1_000], ['bdm2', 500]]));
    const i = indexarNetDelCrm(tree);
    expect(i.get('head')).toEqual({ own: -100, total: 1_400 });
    expect(i.get('bdm1')).toEqual({ own: 1_000, total: 1_000 });
    expect(i.size).toBe(3);
  });
});

describe('el puente al motor', () => {
  it('«sin datos» entra como 0 y el motor CONSERVA el acumulado', () => {
    const sinDatos = resolveNetDepositInput({
      profileId: 'a', period: ABIERTO, scope: 'structure', crm: null, manual: null,
    });
    expect(netParaElMotor(sinDatos)).toBe(0);
    const calc = calculateCommission(netParaElMotor(sinDatos), 50_000, 5);
    expect(calc.realPayment).toBe(0);
    // La regla 2 de §2.1: con ND=0 el acumulado NO se destruye.
    expect(calc.accumulatedOut).toBe(50_000);
  });

  it('el automático puro y el mismo número cargado a mano dan la MISMA comisión', () => {
    const crm = idx([['a', { own: 0, total: 212_025.95 }]]);
    const auto = resolveNetDepositInput({ profileId: 'a', period: ABIERTO, scope: 'structure', crm, manual: null });
    const override = resolveNetDepositInput({
      profileId: 'a', period: ABIERTO, scope: 'structure', crm, manual: 212_025.95,
    });
    expect(auto.source).toBe('crm');
    expect(override.source).toBe('manual');
    const cAuto = calculateCommission(netParaElMotor(auto), 1_000, 6);
    const cMan = calculateCommission(netParaElMotor(override), 1_000, 6);
    expect(cAuto).toEqual(cMan);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MASTER IB — la subred del master no es del BDM del que cuelga (migración 129)
//
// El caso real y sus números (agosto 2026, medidos el 2026-09-06): Ana García
// (BDM) con el master Jose Emanuel Hernandez Alvarez colgando de ella.
// ─────────────────────────────────────────────────────────────────────────────
describe('descontarSubredesDeMasters', () => {
  const perfilesReales: RollupProfile[] = [
    { id: 'hugo', name: 'Hugo Ortiz', role: 'head', head_id: null, salary: null, hire_date: null, status: 'active' },
    { id: 'ana', name: 'Ana García', role: 'bdm', head_id: 'hugo', salary: null, hire_date: null, status: 'active' },
    { id: 'master', name: 'Jose Emanuel', role: 'bdm', head_id: 'ana', salary: null, hire_date: null, status: 'active' },
  ];
  // Lo que devuelve la RPC DESPUÉS de que el master es root: a Ana ya sólo se
  // le atribuye su línea directa y al master su subred entera.
  const netDelCrm = new Map([['ana', -3_037.83], ['master', 281_168.49]]);
  const conMaster = [
    { id: 'hugo', head_id: null, is_master_ib: false },
    { id: 'ana', head_id: 'hugo', is_master_ib: false },
    { id: 'master', head_id: 'ana', is_master_ib: true },
  ];

  it('el BDM padre queda con su producción propia y el master con su subred', () => {
    const crudo = indexarNetDelCrm(buildRollup(perfilesReales, netDelCrm));
    // Sin descontar, el rollup le sube la subred del master a Ana.
    expect(crudo.get('ana')).toEqual({ own: -3_037.83, total: 278_130.66 });

    const neto = descontarSubredesDeMasters(crudo, conMaster)!;
    expect(neto.get('ana')!.total).toBeCloseTo(-3_037.83, 2);
    expect(neto.get('master')!.total).toBe(281_168.49);
    // Y la suma sigue dando el ND que Ana tenía sola: no se perdió ni se
    // inventó producción, cambió de dueño.
    expect(neto.get('ana')!.total + neto.get('master')!.total).toBeCloseTo(278_130.66, 2);
  });

  it('SIN ningún master marcado devuelve el MISMO índice (nada cambia hoy)', () => {
    const crudo = indexarNetDelCrm(buildRollup(perfilesReales, netDelCrm));
    const sinMasters = conMaster.map((p) => ({ ...p, is_master_ib: false }));
    expect(descontarSubredesDeMasters(crudo, sinMasters)).toBe(crudo);
  });

  it('`own` NO se toca: por definición nunca incluyó a los hijos', () => {
    const crudo = indexarNetDelCrm(buildRollup(perfilesReales, netDelCrm));
    const neto = descontarSubredesDeMasters(crudo, conMaster)!;
    expect(neto.get('ana')!.own).toBe(crudo.get('ana')!.own);
    expect(neto.get('hugo')!.own).toBe(crudo.get('hugo')!.own);
  });

  it('los ancestros no se tocan: el corte se aplica en la fila del padre', () => {
    const crudo = indexarNetDelCrm(buildRollup(perfilesReales, netDelCrm));
    const neto = descontarSubredesDeMasters(crudo, conMaster)!;
    expect(neto.get('hugo')).toEqual(crudo.get('hugo'));
  });

  it('un padre con un master Y un BDM propio conserva al BDM', () => {
    const perfiles: RollupProfile[] = [
      ...perfilesReales,
      { id: 'sub', name: 'BDM propio', role: 'bdm', head_id: 'ana', salary: null, hire_date: null, status: 'active' },
    ];
    const crudo = indexarNetDelCrm(
      buildRollup(perfiles, new Map([...netDelCrm, ['sub', 10_000]])),
    );
    const neto = descontarSubredesDeMasters(crudo, [...conMaster, { id: 'sub', head_id: 'ana', is_master_ib: false }])!;
    // −3.037,83 propios + 10.000 del BDM que sí es suyo. Usar `own` en vez de
    // restar los masters le habría borrado esos 10.000 en silencio.
    expect(neto.get('ana')!.total).toBeCloseTo(6_962.17, 2);
  });

  it('dos masters colgando del mismo BDM se restan los dos', () => {
    const perfiles: RollupProfile[] = [
      ...perfilesReales,
      { id: 'master2', name: 'Otro master', role: 'bdm', head_id: 'ana', salary: null, hire_date: null, status: 'active' },
    ];
    const crudo = indexarNetDelCrm(buildRollup(perfiles, new Map([...netDelCrm, ['master2', 5_000]])));
    const neto = descontarSubredesDeMasters(crudo, [...conMaster, { id: 'master2', head_id: 'ana', is_master_ib: true }])!;
    expect(neto.get('ana')!.total).toBeCloseTo(-3_037.83, 2);
  });

  it('un master que el CRM no conoce no resta un 0 inventado', () => {
    const crudo = idx([['ana', { own: -10, total: 100 }]]);
    const neto = descontarSubredesDeMasters(crudo, [
      { id: 'ana', head_id: 'hugo', is_master_ib: false },
      { id: 'fantasma', head_id: 'ana', is_master_ib: true },
    ])!;
    // El master no está en el índice: no hay resta, y el índice vuelve igual.
    expect(neto.get('ana')).toEqual({ own: -10, total: 100 });
  });

  it('un master SIN head_id no le resta a nadie', () => {
    const crudo = idx([['master', { own: 281_168.49, total: 281_168.49 }]]);
    const neto = descontarSubredesDeMasters(crudo, [{ id: 'master', head_id: null, is_master_ib: true }])!;
    expect(neto.get('master')!.total).toBe(281_168.49);
  });

  it('sin índice (el CRM no respondió) sigue siendo null, nunca un mapa vacío', () => {
    expect(descontarSubredesDeMasters(null, conMaster)).toBeNull();
  });
});
