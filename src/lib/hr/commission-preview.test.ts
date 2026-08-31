import { describe, it, expect } from 'vitest';
import { comisionIndividualDeBdm } from './commission-preview';
import {
  indexarNetDelCrm,
  resolveNetDepositInput,
  type ResolvedNetDeposit,
} from './net-deposit-input';
import { buildRollup, type RollupProfile } from './net-deposit';
import { calculateCommission } from '@/lib/commission-calculator';

const AGOSTO = { year: 2026, month: 8, is_closed: false };
const JULIO = { year: 2026, month: 7, is_closed: true };

const resuelto = (value: number | null, source: ResolvedNetDeposit['source'] = 'crm'): ResolvedNetDeposit => ({
  value, source, crm: value, manual: null,
});

describe('comisionIndividualDeBdm', () => {
  const bdm = { id: 'b', net_deposit_pct: 4, fixed_salary: false, salary: null, hire_date: null };

  it('es exactamente la fórmula del motor, sin tocarla', () => {
    const c = comisionIndividualDeBdm({
      profile: bdm, resolved: resuelto(212_025.95), accumulatedIn: 1_000,
      periodYear: 2026, periodMonth: 8,
    })!;
    // El tier de 200K sube el % a 6: el tier es PISO, nunca techo (§2.1 regla 3).
    expect(c.commissionPct).toBe(6);
    const esperado = calculateCommission(212_025.95, 1_000, 6);
    expect(c.division).toBe(esperado.division);
    expect(c.commission).toBe(esperado.commission);
    expect(c.realPayment).toBe(esperado.realPayment);
    expect(c.accumulatedOut).toBe(esperado.accumulatedOut);
  });

  it('con salario fijo el % es el pactado, sin tiers', () => {
    const c = comisionIndividualDeBdm({
      profile: { ...bdm, fixed_salary: true, salary: 2_000 }, resolved: resuelto(212_025.95),
      accumulatedIn: 0, periodYear: 2026, periodMonth: 8,
    })!;
    expect(c.commissionPct).toBe(4);
    expect(c.salary).toBe(2_000);
  });

  it('un mes negativo NO se clampea: la comisión negativa es deuda', () => {
    const c = comisionIndividualDeBdm({
      profile: bdm, resolved: resuelto(-35_728.14), accumulatedIn: 0,
      periodYear: 2026, periodMonth: 8,
    })!;
    expect(c.realPayment).toBeLessThan(0);
    expect(c.accumulatedOut).toBeLessThan(0);
  });

  it('SIN DATOS entra como 0: no paga y CONSERVA el acumulado', () => {
    const c = comisionIndividualDeBdm({
      profile: bdm, resolved: { value: null, source: 'none', crm: null, manual: null },
      accumulatedIn: 50_000, periodYear: 2026, periodMonth: 8,
    })!;
    expect(c.nd).toBeNull();
    expect(c.source).toBe('none');
    expect(c.realPayment).toBe(0);
    expect(c.accumulatedOut).toBe(50_000);
  });

  it('un perfil de PnL no pasa por acá: devuelve null, no 0', () => {
    const c = comisionIndividualDeBdm({
      profile: { id: 'p', pnl_pct: 30 }, resolved: resuelto(9_999),
      accumulatedIn: 0, periodYear: 2026, periodMonth: 8,
    });
    expect(c).toBeNull();
  });

  it('prorratea el salario fijo en el mes de alta', () => {
    const c = comisionIndividualDeBdm({
      profile: { id: 'b', net_deposit_pct: 4, fixed_salary: true, salary: 2_000, hire_date: '2026-08-12' },
      resolved: resuelto(1_000), accumulatedIn: 0, periodYear: 2026, periodMonth: 8,
    })!;
    // 31 − 12 + 1 = 20 días de 31.
    expect(c.salary).toBe(1290.32);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EL ORÁCULO — julio 2026, el último mes con el manual cargado completo.
//
// Los números son de producción (Vex Pro, período 2026-07, cerrado): a la
// izquierda lo que el rollup del CRM devuelve hoy, a la derecha lo que Daniela
// tecleó a mano en `commercial_monthly_results`. Fijan LA SEMÁNTICA, que es lo
// que esta tanda tenía que descubrir: el miembro de un grupo lleva el TOTAL de
// su estructura y el head en su propio grupo lleva su producción PROPIA.
//
// (Noviembre 2025 no sirve de oráculo: el CRM sólo tiene 746 depósitos ese mes,
// la estructura comercial cambió de manos desde entonces y de 27 perfiles con
// manual cargado sólo dos coinciden. Se probó y se descartó — ver el reporte.)
// ─────────────────────────────────────────────────────────────────────────────
describe('oráculo julio 2026 — manual vs automático', () => {
  /** [nombre, own del CRM, total del CRM, manual tecleado, alcance] */
  const CASOS: [string, number, number, number, 'own' | 'structure'][] = [
    ['Sebastián Eduardo González (head, miembro de Gerald)', -700.63, 27_062.79, 27_062, 'structure'],
    ['Víctor Joel Del Ángel (head, miembro de Hugo)', -508.34, -15_712.80, -15_712, 'structure'],
    ['Diego Cordero (head, miembro de Luis Díaz)', -4_119.95, -10_366.93, -10_366, 'structure'],
    ['José David Rivera (head, miembro de Gerald)', 4_517.23, 8_194.04, 8_194, 'structure'],
    ['Javier Vergara (head, miembro de Andrés)', 4_692.63, 5_441.26, 5_441, 'structure'],
    ['Roberto Aruani (head, miembro de Nicolás)', 0, -2_661.42, -2_661, 'structure'],
    ['Eric Villanueva (BDM)', 112_056.59, 112_056.59, 112_056, 'structure'],
    ['Zeidy Riaño (BDM)', -11_592.33, -11_592.33, -11_592, 'structure'],
    ['Jackson Araujo (BDM GLOBAL)', 22_129.90, 22_129.90, 22_129, 'structure'],
    ['Nicolás Santamaría (head, en SU grupo)', -2_701.51, 41_612.35, -2_702, 'own'],
    ['Martín Noval (head, en SU grupo)', 15_843.92, 17_457.04, 15_844, 'own'],
    ['Ricardo Osuna (head, en SU grupo)', -535, -9_785.41, -535, 'own'],
    ['Luka Angeles (head, en SU grupo)', -11_228.65, 496_374.53, -11_228, 'own'],
  ];

  it.each(CASOS)('%s: el automático cae sobre el manual (±1 unidad)', (_n, own, total, manual, scope) => {
    const crm = new Map([['p', { own, total }]]);
    const r = resolveNetDepositInput({ profileId: 'p', period: AGOSTO, scope, crm, manual: null });
    expect(r.source).toBe('crm');
    // Daniela teclea el número truncado; la coincidencia es hasta la unidad.
    expect(Math.abs((r.value as number) - manual)).toBeLessThan(1);
  });

  it('elegir el campo equivocado se ve a simple vista (Luka: 496.374 vs −11.228)', () => {
    const crm = new Map([['luka', { own: -11_228.65, total: 496_374.53 }]]);
    const comoMiembro = resolveNetDepositInput({ profileId: 'luka', period: AGOSTO, scope: 'structure', crm, manual: null });
    const enSuGrupo = resolveNetDepositInput({ profileId: 'luka', period: AGOSTO, scope: 'own', crm, manual: null });
    expect(comoMiembro.value).toBe(496_374.53);
    expect(enSuGrupo.value).toBe(-11_228.65);
  });

  it('julio 2026 está CERRADO y antes del corte: el automático no lo toca', () => {
    const crm = new Map([['p', { own: 0, total: 496_374.53 }]]);
    const r = resolveNetDepositInput({ profileId: 'p', period: JULIO, scope: 'structure', crm, manual: 485_340 });
    expect(r.value).toBe(485_340);
    expect(r.source).toBe('frozen');
  });

  it('con el manual como override y con el automático puro, el motor da lo MISMO cuando el número es el mismo', () => {
    const crm = new Map([['eric', { own: 112_056.59, total: 112_056.59 }]]);
    const perfil = { id: 'eric', net_deposit_pct: 4, fixed_salary: false, salary: null, hire_date: null };
    const auto = comisionIndividualDeBdm({
      profile: perfil,
      resolved: resolveNetDepositInput({ profileId: 'eric', period: AGOSTO, scope: 'structure', crm, manual: null }),
      accumulatedIn: 0, periodYear: 2026, periodMonth: 8,
    })!;
    const override = comisionIndividualDeBdm({
      profile: perfil,
      resolved: resolveNetDepositInput({ profileId: 'eric', period: AGOSTO, scope: 'structure', crm, manual: 112_056.59 }),
      accumulatedIn: 0, periodYear: 2026, periodMonth: 8,
    })!;
    expect(auto.source).toBe('crm');
    expect(override.source).toBe('manual');
    expect(auto.commission).toBe(override.commission);
    expect(auto.realPayment).toBe(override.realPayment);
    expect(auto.accumulatedOut).toBe(override.accumulatedOut);
  });
});

describe('el árbol que alimenta el resolver es el mismo de RRHH', () => {
  it('own/total de una estructura de tres niveles', () => {
    const perfiles: RollupProfile[] = [
      { id: 'hugo', name: 'Hugo', role: 'sales_manager', head_id: null, salary: null, hire_date: null, status: 'active' },
      { id: 'luka', name: 'Luka', role: 'head', head_id: 'hugo', salary: null, hire_date: null, status: 'active' },
      { id: 'ana', name: 'Ana', role: 'bdm', head_id: 'luka', salary: null, hire_date: null, status: 'active' },
    ];
    const idx = indexarNetDelCrm(
      buildRollup(perfiles, new Map([['hugo', -4_691.07], ['luka', -11_228.65], ['ana', 258_810.44]])),
    );
    expect(idx.get('ana')).toEqual({ own: 258_810.44, total: 258_810.44 });
    expect(idx.get('luka')!.own).toBe(-11_228.65);
    expect(idx.get('luka')!.total).toBeCloseTo(247_581.79, 2);
    expect(idx.get('hugo')!.total).toBeCloseTo(242_890.72, 2);
  });
});
