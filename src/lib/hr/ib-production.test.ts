import { describe, it, expect } from 'vitest';
import {
  buildIbProductionRollup,
  addProduction,
  emptyProduction,
  hasProduction,
  type IbProduction,
} from './ib-production';
import type { RollupProfile } from './net-deposit';

const perfil = (p: Partial<RollupProfile> & { id: string }): RollupProfile => ({
  name: p.id, role: 'bdm', head_id: null, salary: null, hire_date: null, status: 'active', ...p,
});

const prod = (p: Partial<IbProduction>): IbProduction => ({ ...emptyProduction(), ...p });

describe('addProduction — sin dato no es cero', () => {
  it('null + null sigue siendo null: nadie sabe nada del desglose', () => {
    const r = addProduction(prod({ lots: 5 }), prod({ lots: 3 }));
    expect(r.lots).toBe(8);
    expect(r.forexLots).toBeNull();
    expect(r.syntheticLots).toBeNull();
  });

  it('null + número devuelve el número: no se pierde lo que sí se sabe', () => {
    const r = addProduction(prod({ forexLots: null }), prod({ forexLots: 7, syntheticLots: 2 }));
    expect(r.forexLots).toBe(7);
    expect(r.syntheticLots).toBe(2);
  });

  it('cero es cero y no se confunde con null', () => {
    const r = addProduction(prod({ forexLots: 0 }), prod({ forexLots: 0 }));
    expect(r.forexLots).toBe(0);
    expect(r.forexLots).not.toBeNull();
  });

  it('suma las cuatro métricas apilables', () => {
    const r = addProduction(
      prod({ lots: 1.5, commission: 10, pnl: -100, rewards: 3, ibs: 1 }),
      prod({ lots: 2.5, commission: 5, pnl: 40, rewards: 7, ibs: 2 }),
    );
    expect(r).toMatchObject({ lots: 4, commission: 15, pnl: -60, rewards: 10, ibs: 3 });
  });
});

describe('buildIbProductionRollup — la producción sube por la misma estructura', () => {
  // La estructura de Hugo, con la forma real: un sales manager, dos heads y un
  // BDM colgando de uno de ellos.
  const profiles = [
    perfil({ id: 'hugo', role: 'sales_manager' }),
    perfil({ id: 'luka', role: 'head', head_id: 'hugo' }),
    perfil({ id: 'ana', role: 'head', head_id: 'hugo' }),
    perfil({ id: 'antony', role: 'bdm', head_id: 'luka' }),
  ];

  const byProfile = new Map<string, IbProduction>([
    ['hugo', prod({ lots: 10, commission: 100, pnl: 1000, rewards: 5, ibs: 1, forexLots: 4, syntheticLots: 6 })],
    ['luka', prod({ lots: 20, commission: 200, pnl: 2000, rewards: 9, ibs: 2, forexLots: 8, syntheticLots: 12 })],
    ['ana', prod({ lots: 30, commission: 300, pnl: -500, rewards: 4, ibs: 3, forexLots: 30, syntheticLots: 0 })],
    ['antony', prod({ lots: 5, commission: 50, pnl: 250, rewards: 2, ibs: 1, forexLots: 1, syntheticLots: 4 })],
  ]);

  it('el total de una estructura es lo propio más lo del equipo', () => {
    const [root] = buildIbProductionRollup(profiles, byProfile);
    expect(root.profileId).toBe('hugo');
    expect(root.own.commission).toBe(100);
    // luka (200 + antony 50) + ana (300) = 550
    expect(root.team.commission).toBe(550);
    expect(root.total.commission).toBe(650);
    expect(root.total.lots).toBe(65);
    expect(root.total.rewards).toBe(20);
  });

  it('el desglose también sube y cierra contra el total de lotes', () => {
    const [root] = buildIbProductionRollup(profiles, byProfile);
    expect(root.total.forexLots).toBe(43);      // 4 + 8 + 30 + 1
    expect(root.total.syntheticLots).toBe(22);  // 6 + 12 + 0 + 4
    expect((root.total.forexLots ?? 0) + (root.total.syntheticLots ?? 0)).toBe(root.total.lots);
  });

  it('un perfil sin producción vale CERO, no rompe el árbol', () => {
    const [root] = buildIbProductionRollup([...profiles, perfil({ id: 'nuevo', head_id: 'hugo' })], byProfile);
    const nuevo = root.children.find((c) => c.profileId === 'nuevo');
    expect(nuevo).toBeDefined();
    expect(nuevo!.total.lots).toBe(0);
    // Pero de su desglose no se sabe nada: nunca tuvo filas.
    expect(nuevo!.total.forexLots).toBeNull();
  });

  it('si NADIE de la rama tiene desglose, el total queda en sin dato', () => {
    const sinDesglose = new Map<string, IbProduction>([
      ['hugo', prod({ lots: 10, commission: 100 })],
      ['luka', prod({ lots: 20, commission: 200 })],
    ]);
    const [root] = buildIbProductionRollup(profiles, sinDesglose);
    expect(root.total.lots).toBe(30);
    expect(root.total.forexLots).toBeNull();
    expect(root.total.syntheticLots).toBeNull();
  });

  it('si sólo una rama tiene desglose, el padre muestra lo que se sabe', () => {
    const parcial = new Map<string, IbProduction>([
      ['luka', prod({ lots: 20, commission: 200, forexLots: 8, syntheticLots: 12 })],
      ['ana', prod({ lots: 30, commission: 300 })],
    ]);
    const [root] = buildIbProductionRollup(profiles, parcial);
    expect(root.total.lots).toBe(50);
    expect(root.total.forexLots).toBe(8);
    expect(root.total.syntheticLots).toBe(12);
  });

  it('los hermanos se ordenan por comisión, no por lotes', () => {
    // ana mueve más lotes (30) pero luka cobra más comisión (200 + 50).
    const [root] = buildIbProductionRollup(profiles, byProfile);
    expect(root.children.map((c) => c.profileId)).toEqual(['ana', 'luka']);
    expect(root.children[0].total.commission).toBe(300);
    expect(root.children[1].total.commission).toBe(250);
  });

  it('un ciclo en head_id no borra la estructura ni cuelga la pantalla', () => {
    const nodes = buildIbProductionRollup(
      [perfil({ id: 'a', head_id: 'b' }), perfil({ id: 'b', head_id: 'a' })],
      new Map([['a', prod({ commission: 1 })], ['b', prod({ commission: 2 })]]),
    );
    expect(nodes.length).toBeGreaterThan(0);
  });

  it('un head_id que apunta a alguien ausente deja la rama suelta, no la pierde', () => {
    const nodes = buildIbProductionRollup(
      [perfil({ id: 'huerfano', head_id: 'no-existe' })],
      new Map([['huerfano', prod({ commission: 9 })]]),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].total.commission).toBe(9);
  });
});

describe('hasProduction', () => {
  it('detecta movimiento por premios, lotes o comisión', () => {
    const base = { profileId: 'x', name: 'x', role: 'bdm', headId: null, children: [], own: emptyProduction(), team: emptyProduction() };
    expect(hasProduction({ ...base, total: emptyProduction() })).toBe(false);
    expect(hasProduction({ ...base, total: prod({ rewards: 1 }) })).toBe(true);
    expect(hasProduction({ ...base, total: prod({ lots: 0.01 }) })).toBe(true);
    expect(hasProduction({ ...base, total: prod({ commission: -1 }) })).toBe(true);
  });

  // Un mes con desglose espejado pero sin un solo premio no es "movimiento":
  // el desglose de cero filas no puede inventar actividad.
  it('no cuenta como movimiento tener el desglose en cero', () => {
    const base = { profileId: 'x', name: 'x', role: 'bdm', headId: null, children: [], own: emptyProduction(), team: emptyProduction() };
    expect(hasProduction({ ...base, total: prod({ forexLots: 0, syntheticLots: 0 }) })).toBe(false);
  });
});
