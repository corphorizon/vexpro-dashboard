import { describe, it, expect } from 'vitest';
import {
  HR_OVERVIEW_SLICES,
  armarOverview,
  contarWarningsPorPerfil,
  separarNetDelCrm,
  sumarManualPorPerfil,
  warningsDelMes,
  type HrOverviewInput,
  type HrWarningRow,
} from './overview';
import type { RollupProfile } from './net-deposit';

const perfiles: RollupProfile[] = [
  { id: 'head', name: 'Hugo', role: 'head', head_id: null, salary: 2000, hire_date: '2025-01-01', status: 'active' },
  { id: 'bdm1', name: 'Ana', role: 'bdm', head_id: 'head', salary: 1000, hire_date: '2025-01-01', status: 'active' },
  { id: 'bdm2', name: 'Beto', role: 'bdm', head_id: 'head', salary: 1000, hire_date: '2025-01-01', status: 'active' },
];

const warning = (over: Partial<HrWarningRow> = {}): HrWarningRow => ({
  id: 'w1',
  profile_id: 'bdm1',
  month: '2026-07-01',
  motive: 'net_deposit',
  detail: null,
  created_by_name: 'Daniela',
  created_at: '2026-07-05T00:00:00Z',
  ...over,
});

const base: HrOverviewInput = {
  month: '2026-07-01',
  period: { id: 'per1', year: 2026, month: 7 },
  profiles: perfiles,
  netRows: [
    { profile_id: 'bdm1', net: 40000 },
    { profile_id: 'bdm2', net: '10000' },
    { profile_id: null, net: 500 },
  ],
  monthlyResults: [
    { profile_id: 'bdm1', net_deposit_current: 39000 },
    { profile_id: 'bdm1', net_deposit_current: 1000 }, // dos filas: se suman
  ],
  goals: [{ salary: 1000, min_net_deposit: 30000 }, { salary: 2000, min_net_deposit: 50000 }],
  goalRows: [
    { id: 'g1', salary: 1000, min_net_deposit: 30000 },
    { id: 'g2', salary: 2000, min_net_deposit: 50000 },
  ],
  allWarnings: [warning(), warning({ id: 'w0', month: '2026-05-01' })],
};

describe('helpers puros', () => {
  it('suma las filas repetidas de un mismo perfil en el mes', () => {
    const m = sumarManualPorPerfil(base.monthlyResults!);
    expect(m.get('bdm1')).toBe(40000);
    expect(m.has('bdm2')).toBe(false); // sin fila = no está, no es 0
  });

  it('separa lo atribuido de lo huérfano sin repartirlo', () => {
    const { netByProfile, unassigned } = separarNetDelCrm(base.netRows!);
    expect(netByProfile.get('bdm1')).toBe(40000);
    expect(netByProfile.get('bdm2')).toBe(10000); // string numérico
    expect(unassigned).toBe(500);
  });

  it('el acumulado de warnings es histórico y el del mes filtra por YYYY-MM', () => {
    expect(contarWarningsPorPerfil(base.allWarnings!)).toEqual({ bdm1: 2 });
    expect(warningsDelMes(base.allWarnings!, '2026-07-01').map((w) => w.id)).toEqual(['w1']);
  });
});

describe('armarOverview', () => {
  it('arma el árbol con el manual al lado y sin partial cuando todo llegó', () => {
    const out = armarOverview(base);
    expect(out.partial).toEqual([]);
    expect(out.hasPeriod).toBe(true);
    const raiz = out.data.net!.tree[0];
    expect(raiz.profileId).toBe('head');
    expect(raiz.team).toBe(50000);
    expect(raiz.total).toBe(50000);
    expect(out.data.net!.totalAssigned).toBe(50000);
    expect(out.data.net!.totalCrm).toBe(50500);
    const ana = raiz.children.find((c) => c.profileId === 'bdm1')!;
    expect(ana.manual).toBe(40000);
  });

  it('sin monthlyResults, `manual` es null (no lo sabemos) y NO 0', () => {
    const out = armarOverview({ ...base, monthlyResults: null });
    expect(out.partial).toContain('monthlyResults');
    const ana = out.data.net!.tree[0].children.find((c) => c.profileId === 'bdm1')!;
    expect(ana.manual).toBeNull();
  });

  it('un perfil sin fila manual queda en null, no en cero', () => {
    const out = armarOverview(base);
    const beto = out.data.net!.tree[0].children.find((c) => c.profileId === 'bdm2')!;
    expect(beto.manual).toBeNull();
  });

  it('si falla el net, el árbol es null — nunca un árbol en cero', () => {
    const out = armarOverview({ ...base, netRows: null });
    expect(out.partial).toContain('net');
    expect(out.data.net).toBeNull();
    // Y sin net no se sugieren warnings: sugerir de menos es invisible.
    expect(out.data.warnings!.suggestions).toEqual([]);
    expect(out.data.warnings!.metrics).toEqual([]);
  });

  it('si fallan los perfiles, lo declara y no inventa estructura', () => {
    const out = armarOverview({ ...base, profiles: null });
    expect(out.partial).toContain('profiles');
    expect(out.data.profiles).toBeNull();
    expect(out.data.net).toBeNull();
  });

  it('sugiere sólo a quien quedó bajo su meta y no está ya advertido', () => {
    // Ana (1.000 → meta 30.000) hizo 40.000: no se sugiere. Beto hizo 10.000.
    const out = armarOverview({ ...base, allWarnings: [] });
    expect(out.data.warnings!.suggestions.map((s) => s.profileId)).toEqual(['head', 'bdm2']);
    // Con el warning de net_deposit ya cargado, Beto seguiría; el ya advertido sale.
    const conWarning = armarOverview({
      ...base,
      allWarnings: [warning({ profile_id: 'bdm2' })],
    });
    expect(conWarning.data.warnings!.suggestions.map((s) => s.profileId)).not.toContain('bdm2');
  });

  it('sin período, hasPeriod es false y el mes sigue siendo el pedido', () => {
    const out = armarOverview({ ...base, period: null, monthlyResults: [] });
    expect(out.hasPeriod).toBe(false);
    expect(out.month).toBe('2026-07-01');
    expect(out.partial).toEqual([]);
  });

  it('todos los slices que fallan aparecen en partial, y sólo ésos', () => {
    const todoRoto = armarOverview({
      ...base,
      profiles: null,
      netRows: null,
      monthlyResults: null,
      goals: null,
      goalRows: null,
      allWarnings: null,
    });
    expect([...todoRoto.partial].sort()).toEqual([...HR_OVERVIEW_SLICES].sort());
  });
});
