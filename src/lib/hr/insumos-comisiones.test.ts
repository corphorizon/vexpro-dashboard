// ─────────────────────────────────────────────────────────────────────────────
// La cache de insumos CRM de /comisiones (migración 132).
//
// Lo que fija este test, en orden de lo que más cuesta si se rompe:
//   1. MERGE POR COLUMNA: una RPC caída NO degrada a NULLs lo que la cache ya
//      tenía de esa métrica. Septiembre se cerró con grupos a medias; un
//      timeout del PnL a las 03:35 no puede borrar el PnL bueno de las 23:35.
//   2. El signo del PnL viaja CRUDO: el único punto de inversión es el GET.
//   3. null ≠ 0: lo que la RPC no trajo queda null, y un perfil que no es
//      del grupo PnL no aparece como «PnL sin dato CRM».
//
// La base va FALSA: un almacén en memoria con un modelo de la función
// `hr_insumos_comisiones_aplicar` tal como la documenta su contrato («p_nd /
// p_pnl en null = esas columnas NO se tocan; la que llega se reemplaza entera
// para el mes»). El SQL real se verifica con la consulta C de la migración;
// lo que se prueba acá es que TypeScript le mande a esa función lo correcto
// y lea de vuelta lo correcto.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ERROR_ESCRITURA,
  ERROR_ND,
  ERROR_PNL,
  armarPayloadNd,
  armarPayloadPnl,
  computedAtMasViejo,
  leerInsumosDeCache,
  mesesDeLiquidacion,
  parseMesInsumos,
  recomputarInsumosComisiones,
  type PayloadNd,
  type PayloadPnl,
} from './insumos-comisiones';

const EMPRESA = 'empresa-1';
const MES = '2026-09-01';

// ── La base falsa ───────────────────────────────────────────────────────────

type Fila = {
  company_id: string;
  mes: string;
  profile_id: string;
  nd: number | string | null;
  nd_clients: number | string | null;
  pnl_crm: number | string | null;
  lotes: number | string | null;
  usuarios_red: number | string | null;
  en_rpc_nd: boolean;
  en_rpc_pnl: boolean;
};
type Cabecera = {
  company_id: string;
  mes: string;
  nd_huerfano: number | null;
  nd_computed_at: string | null;
  pnl_computed_at: string | null;
};

type Rpc = { data: unknown; error: unknown } | 'throw';

function crearBase() {
  const db = {
    filas: [] as Fila[],
    cabeceras: [] as Cabecera[],
    /** Lo que devuelven las RPC del CRM en la próxima llamada. */
    nd: { data: [], error: null } as Rpc,
    pnl: { data: [], error: null } as Rpc,
    aplicarFalla: false,
    reloj: '2026-10-20T03:35:00.000Z',
    rpc: vi.fn(),
  };

  // Modelo del contrato de hr_insumos_comisiones_aplicar.
  const aplicar = (p: { p_company_id: string; p_mes: string; p_nd: PayloadNd | null; p_pnl: PayloadPnl | null }) => {
    const now = db.reloj;
    const delMes = (f: Fila) => f.company_id === p.p_company_id && f.mes === p.p_mes;
    let cab = db.cabeceras.find((c) => c.company_id === p.p_company_id && c.mes === p.p_mes);
    if (!cab) {
      cab = { company_id: p.p_company_id, mes: p.p_mes, nd_huerfano: null, nd_computed_at: null, pnl_computed_at: null };
      db.cabeceras.push(cab);
    }
    const fila = (id: string): Fila => {
      let f = db.filas.find((x) => delMes(x) && x.profile_id === id);
      if (!f) {
        f = {
          company_id: p.p_company_id, mes: p.p_mes, profile_id: id,
          nd: null, nd_clients: null, pnl_crm: null, lotes: null, usuarios_red: null,
          en_rpc_nd: false, en_rpc_pnl: false,
        };
        db.filas.push(f);
      }
      return f;
    };
    if (p.p_nd) {
      const ids = new Set(p.p_nd.filas.map((x) => x.profile_id));
      for (const f of db.filas.filter(delMes)) {
        if (f.en_rpc_nd && !ids.has(f.profile_id)) Object.assign(f, { nd: null, nd_clients: null, en_rpc_nd: false });
      }
      for (const x of p.p_nd.filas) Object.assign(fila(x.profile_id), { nd: x.nd, nd_clients: x.nd_clients, en_rpc_nd: true });
      cab.nd_huerfano = p.p_nd.huerfano;
      cab.nd_computed_at = now;
    }
    if (p.p_pnl) {
      const ids = new Set(p.p_pnl.filas.map((x) => x.profile_id));
      for (const f of db.filas.filter(delMes)) {
        if (f.en_rpc_pnl && !ids.has(f.profile_id)) {
          Object.assign(f, { pnl_crm: null, lotes: null, usuarios_red: null, en_rpc_pnl: false });
        }
      }
      for (const x of p.p_pnl.filas) {
        Object.assign(fila(x.profile_id), { pnl_crm: x.pnl_crm, lotes: x.lotes, usuarios_red: x.usuarios_red, en_rpc_pnl: true });
      }
      cab.pnl_computed_at = now;
    }
    db.filas = db.filas.filter((f) => !delMes(f) || f.en_rpc_nd || f.en_rpc_pnl);
    return {
      filas: db.filas.filter(delMes).length,
      descartadas: 0,
      computed_at: now,
      nd_computed_at: cab.nd_computed_at,
      pnl_computed_at: cab.pnl_computed_at,
    };
  };

  db.rpc.mockImplementation(async (nombre: string, args: Record<string, unknown>) => {
    const responder = (r: Rpc) => {
      if (r === 'throw') throw new Error('statement timeout');
      return r;
    };
    if (nombre === 'hr_net_deposit_by_profile') return responder(db.nd);
    if (nombre === 'hr_pnl_input_by_profile') return responder(db.pnl);
    if (nombre === 'hr_insumos_comisiones_aplicar') {
      if (db.aplicarFalla) return { data: null, error: { message: 'relation does not exist' } };
      return { data: aplicar(args as Parameters<typeof aplicar>[0]), error: null };
    }
    throw new Error(`rpc inesperada ${nombre}`);
  });

  // Query builder mínimo: select / eq / order / range / maybeSingle.
  const from = (tabla: string) => {
    const filtros: [string, unknown][] = [];
    let rango: [number, number] | null = null;
    const filas = () => {
      const src = (tabla === 'hr_insumos_comisiones' ? db.filas : db.cabeceras) as Record<string, unknown>[];
      const out = src.filter((r) => filtros.every(([k, v]) => r[k] === v));
      return rango ? out.slice(rango[0], rango[1] + 1) : out;
    };
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (k: string, v: unknown) => { filtros.push([k, v]); return q; };
    q.order = () => q;
    q.range = (a: number, b: number) => { rango = [a, b]; return q; };
    q.maybeSingle = async () => ({ data: filas()[0] ?? null, error: null });
    q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
      Promise.resolve({ data: filas(), error: null }).then(ok, ko);
    return q;
  };

  const admin = { rpc: db.rpc, from } as unknown as SupabaseClient;
  return { db, admin };
}

let db: ReturnType<typeof crearBase>['db'];
let admin: SupabaseClient;

beforeEach(() => {
  ({ db, admin } = crearBase());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const ND_BUENO = [
  { profile_id: 'hugo', net: '687322.96', clients: 812 },
  { profile_id: 'ana', net: '-5124.00', clients: 40 },
  { profile_id: null, net: '1200.50', clients: 3 },
];
const PNL_BUENO = [
  // CRUDO: negativo = los clientes perdieron = el bróker ganó.
  { profile_id: 'diego', pnl_crm: '-6336.14', com_lotes: '3399.39', usuarios_red: 120 },
  // Perfil PnL sin usuario en el CRM: las tres en null. NO es cero.
  { profile_id: 'sinusuario', pnl_crm: null, com_lotes: null, usuarios_red: null },
];

// ── 1. Merge por columna ────────────────────────────────────────────────────

describe('recomputarInsumosComisiones — merge por columna', () => {
  it('las dos RPC bien → escribe las dos métricas y no reporta errores', async () => {
    db.nd = { data: ND_BUENO, error: null };
    db.pnl = { data: PNL_BUENO, error: null };
    const r = await recomputarInsumosComisiones(admin, EMPRESA, MES);
    expect(r.escrito).toBe(true);
    expect(r.errores).toEqual([]);
    expect(r.filas).toBe(4); // hugo, ana, diego, sinusuario
    expect(r.computedAt).toBe(db.reloj);
    const args = db.rpc.mock.calls.find((c) => c[0] === 'hr_insumos_comisiones_aplicar')![1];
    expect(args).toMatchObject({ p_company_id: EMPRESA, p_mes: MES });
    expect(args.p_nd).not.toBeNull();
    expect(args.p_pnl).not.toBeNull();
  });

  it('timeout del PnL → el PnL anterior QUEDA, el ND se actualiza, y el error se anota', async () => {
    db.nd = { data: ND_BUENO, error: null };
    db.pnl = { data: PNL_BUENO, error: null };
    await recomputarInsumosComisiones(admin, EMPRESA, MES);

    // Corrida siguiente: el ND cambió y el PnL hace timeout.
    db.reloj = '2026-10-20T07:35:00.000Z';
    db.nd = { data: [{ profile_id: 'hugo', net: '700000.00', clients: 820 }], error: null };
    db.pnl = { data: null, error: { message: 'canceling statement due to statement timeout' } };
    const r = await recomputarInsumosComisiones(admin, EMPRESA, MES);

    expect(r.escrito).toBe(true);
    expect(r.errores).toEqual([ERROR_PNL]);
    const args = db.rpc.mock.calls.filter((c) => c[0] === 'hr_insumos_comisiones_aplicar').at(-1)![1];
    expect(args.p_pnl).toBeNull(); // ← lo que hace que la función no toque el PnL

    const diego = db.filas.find((f) => f.profile_id === 'diego')!;
    expect(diego.pnl_crm).toBe('-6336.14');
    expect(diego.en_rpc_pnl).toBe(true);
    // La frescura por métrica dice la verdad: el PnL es de la corrida vieja.
    expect(r.ndComputedAt).toBe('2026-10-20T07:35:00.000Z');
    expect(r.pnlComputedAt).toBe('2026-10-20T03:35:00.000Z');
    // El ND sí se reemplazó ENTERO: ana ya no viene y pierde su número.
    expect(db.filas.find((f) => f.profile_id === 'hugo')!.nd).toBe('700000.00');
    expect(db.filas.find((f) => f.profile_id === 'ana')).toBeUndefined();
  });

  it('el ND lanza → el ND anterior QUEDA y el PnL se actualiza', async () => {
    db.nd = { data: ND_BUENO, error: null };
    db.pnl = { data: PNL_BUENO, error: null };
    await recomputarInsumosComisiones(admin, EMPRESA, MES);

    db.nd = 'throw';
    db.pnl = { data: [{ profile_id: 'diego', pnl_crm: '-7000', com_lotes: '10', usuarios_red: 121 }], error: null };
    const r = await recomputarInsumosComisiones(admin, EMPRESA, MES);

    expect(r.errores).toEqual([ERROR_ND]);
    expect(db.filas.find((f) => f.profile_id === 'hugo')!.nd).toBe('687322.96');
    expect(db.cabeceras[0].nd_huerfano).toBe(1200.5);
    expect(db.filas.find((f) => f.profile_id === 'diego')!.pnl_crm).toBe('-7000');
    // `sinusuario` ya no vino en el PnL: deja de ser fila PnL.
    expect(db.filas.find((f) => f.profile_id === 'sinusuario')).toBeUndefined();
  });

  it('fallan las DOS → no se llama a la escritura y la cache queda intacta', async () => {
    db.nd = { data: ND_BUENO, error: null };
    db.pnl = { data: PNL_BUENO, error: null };
    await recomputarInsumosComisiones(admin, EMPRESA, MES);
    const antes = structuredClone({ filas: db.filas, cabeceras: db.cabeceras });
    db.rpc.mockClear();

    db.nd = { data: null, error: { message: 'timeout' } };
    db.pnl = 'throw';
    const r = await recomputarInsumosComisiones(admin, EMPRESA, MES);

    expect(r.escrito).toBe(false);
    expect(r.filas).toBe(0);
    expect(r.computedAt).toBeNull();
    expect(r.errores).toEqual([ERROR_ND, ERROR_PNL]);
    expect(db.rpc.mock.calls.map((c) => c[0])).not.toContain('hr_insumos_comisiones_aplicar');
    expect({ filas: db.filas, cabeceras: db.cabeceras }).toEqual(antes);
  });

  it('la escritura falla (p. ej. la 132 sin aplicar) → no escrito, pero devuelve los crudos', async () => {
    db.nd = { data: ND_BUENO, error: null };
    db.pnl = { data: PNL_BUENO, error: null };
    db.aplicarFalla = true;
    const r = await recomputarInsumosComisiones(admin, EMPRESA, MES);
    expect(r.escrito).toBe(false);
    expect(r.errores).toEqual([ERROR_ESCRITURA]);
    expect(r.crudos.netRows).toEqual(ND_BUENO);
    expect(r.crudos.pnlRows).toEqual(PNL_BUENO);
  });

  it('cuenta y dice las filas descartadas por la función (perfil de otra empresa)', async () => {
    db.nd = { data: ND_BUENO, error: null };
    db.pnl = { data: PNL_BUENO, error: null };
    db.rpc.mockImplementationOnce(async () => ({ data: ND_BUENO, error: null }))
      .mockImplementationOnce(async () => ({ data: PNL_BUENO, error: null }))
      .mockImplementationOnce(async () => ({
        data: { filas: 3, descartadas: 1, computed_at: db.reloj, nd_computed_at: db.reloj, pnl_computed_at: db.reloj },
        error: null,
      }));
    const r = await recomputarInsumosComisiones(admin, EMPRESA, MES);
    expect(r.errores).toHaveLength(1);
    expect(r.errores[0]).toMatch(/1 fila\(s\).*no es de esta empresa/);
  });

  it('un mes que no es día 1 LANZA antes de tocar ninguna RPC', async () => {
    for (const malo of ['2026-09', '2026-09-15', '2026-13-01', '', 'septiembre']) {
      await expect(recomputarInsumosComisiones(admin, EMPRESA, malo)).rejects.toThrow(/mes inválido/);
    }
    expect(db.rpc).not.toHaveBeenCalled();
  });
});

// ── 2. Lo que se lee de vuelta tiene la forma de las RPC ────────────────────

describe('leerInsumosDeCache', () => {
  it('sin cabecera → sin-cache (el GET calcula en vivo)', async () => {
    expect(await leerInsumosDeCache(admin, EMPRESA, MES)).toEqual({ estado: 'sin-cache' });
  });

  it('cabecera con el ND que nunca salió bien → sin-cache, aunque haya PnL', async () => {
    db.nd = { data: null, error: { message: 'timeout' } };
    db.pnl = { data: PNL_BUENO, error: null };
    await recomputarInsumosComisiones(admin, EMPRESA, MES);
    expect(await leerInsumosDeCache(admin, EMPRESA, MES)).toEqual({ estado: 'sin-cache' });
  });

  it('devuelve exactamente lo que trajo cada RPC: ni un perfil de más en el PnL, signo crudo', async () => {
    db.nd = { data: ND_BUENO, error: null };
    db.pnl = { data: PNL_BUENO, error: null };
    await recomputarInsumosComisiones(admin, EMPRESA, MES);
    const r = await leerInsumosDeCache(admin, EMPRESA, MES);
    if (r.estado !== 'ok') throw new Error('se esperaba cache');

    // ND: los dos perfiles + el huérfano, con los mismos valores.
    expect(r.insumos.netRows).toEqual(expect.arrayContaining([
      { profile_id: 'hugo', net: '687322.96', clients: 812 },
      { profile_id: 'ana', net: '-5124.00', clients: 40 },
      { profile_id: null, net: 1200.5 },
    ]));
    expect(r.insumos.netRows).toHaveLength(3);

    // PnL: sólo los que vinieron en la RPC del PnL — hugo y ana NO están,
    // aunque tengan fila (si estuvieran, contarían como «sin dato CRM»).
    const pnl = r.insumos.pnlRows!;
    expect(pnl.map((x) => x.profile_id).sort()).toEqual(['diego', 'sinusuario']);
    const diego = pnl.find((x) => x.profile_id === 'diego')!;
    expect(diego.pnl_crm).toBe('-6336.14'); // CRUDO, sin invertir
    expect(diego.com_lotes).toBe('3399.39');
    // null ≠ 0: las tres siguen en null.
    expect(pnl.find((x) => x.profile_id === 'sinusuario')).toEqual({
      profile_id: 'sinusuario', pnl_crm: null, com_lotes: null, usuarios_red: null,
    });
  });

  it('PnL que nunca salió bien → pnlRows null (el «falló»), nunca [] («no hay perfiles PnL»)', async () => {
    db.nd = { data: ND_BUENO, error: null };
    db.pnl = { data: null, error: { message: 'timeout' } };
    await recomputarInsumosComisiones(admin, EMPRESA, MES);
    const r = await leerInsumosDeCache(admin, EMPRESA, MES);
    if (r.estado !== 'ok') throw new Error('se esperaba cache');
    expect(r.insumos.pnlRows).toBeNull();
    expect(r.insumos.pnlComputedAt).toBeNull();
  });

  it('un mes con cero filas pero calculado es un mes VACÍO, no un cache miss', async () => {
    db.nd = { data: [], error: null };
    db.pnl = { data: [], error: null };
    await recomputarInsumosComisiones(admin, EMPRESA, MES);
    const r = await leerInsumosDeCache(admin, EMPRESA, MES);
    expect(r).toMatchObject({ estado: 'ok', insumos: { netRows: [], pnlRows: [] } });
  });

  it('la lectura falla → estado error (el GET cae al cálculo en vivo)', async () => {
    const roto = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'relation "hr_insumos_comisiones_mes" does not exist' } }) }) }) }),
      }),
    } as unknown as SupabaseClient;
    expect(await leerInsumosDeCache(roto, EMPRESA, MES)).toEqual({ estado: 'error' });
  });
});

// ── 3. Las piezas puras ─────────────────────────────────────────────────────

describe('armarPayloadNd / armarPayloadPnl', () => {
  it('ND: separa el huérfano con la MISMA conversión que separarNetDelCrm', () => {
    const p = armarPayloadNd([
      { profile_id: null, net: '100.25' },
      { profile_id: null, net: 'basura' }, // Number(...) || 0, igual que al leer
      { profile_id: 'a', net: '1.10', clients: 2 },
    ]);
    expect(p.huerfano).toBe(100.25);
    expect(p.filas).toEqual([{ profile_id: 'a', nd: '1.10', nd_clients: 2 }]);
  });

  it('ND: sin fila huérfana el huérfano es null, no 0', () => {
    expect(armarPayloadNd([{ profile_id: 'a', net: 5 }]).huerfano).toBeNull();
  });

  it('ND: un perfil repetido gana el último (como el Map de separarNetDelCrm)', () => {
    const p = armarPayloadNd([
      { profile_id: 'a', net: 1 },
      { profile_id: 'a', net: 2 },
    ]);
    expect(p.filas).toEqual([{ profile_id: 'a', nd: 2, nd_clients: null }]);
  });

  it('PnL: el signo viaja CRUDO y los null siguen null', () => {
    const p = armarPayloadPnl([
      { profile_id: 'x', pnl_crm: '-10.5', com_lotes: '0', usuarios_red: 0 },
      { profile_id: 'y', pnl_crm: null, com_lotes: '3', usuarios_red: 4 },
    ]);
    expect(p.filas).toEqual([
      { profile_id: 'x', pnl_crm: '-10.5', lotes: '0', usuarios_red: 0 },
      { profile_id: 'y', pnl_crm: null, lotes: '3', usuarios_red: 4 },
    ]);
  });
});

describe('parseMesInsumos', () => {
  it('normaliza al día 1', () => {
    expect(parseMesInsumos('2026-09')).toBe('2026-09-01');
    expect(parseMesInsumos('2026-09-01')).toBe('2026-09-01');
    expect(parseMesInsumos('2026-09-17')).toBe('2026-09-01');
  });
  it('rechaza todo lo demás', () => {
    for (const malo of [null, undefined, 202609, '', '2026-9', '2026-00', '2026-13', '26-09', '2026-09-1', '2026-09-01T00:00:00Z']) {
      expect(parseMesInsumos(malo)).toBeNull();
    }
  });
});

describe('mesesDeLiquidacion', () => {
  it('anterior primero, después el en curso', () => {
    expect(mesesDeLiquidacion(new Date('2026-10-20T03:35:00Z'))).toEqual(['2026-09-01', '2026-10-01']);
  });
  it('cruza el año en enero', () => {
    expect(mesesDeLiquidacion(new Date('2027-01-01T00:20:00Z'))).toEqual(['2026-12-01', '2027-01-01']);
  });
  it('va en UTC: el 1 a las 00:20 UTC ya es el mes nuevo', () => {
    expect(mesesDeLiquidacion(new Date('2026-11-01T00:20:00Z'))).toEqual(['2026-10-01', '2026-11-01']);
    expect(mesesDeLiquidacion(new Date('2026-10-31T23:59:59Z'))).toEqual(['2026-09-01', '2026-10-01']);
  });
});

describe('computedAtMasViejo', () => {
  it('la hora del dato más viejo en pantalla', () => {
    expect(computedAtMasViejo('2026-10-20T07:35:00Z', '2026-10-20T03:35:00Z')).toBe('2026-10-20T03:35:00Z');
  });
  it('las métricas ausentes no cuentan', () => {
    expect(computedAtMasViejo('2026-10-20T07:35:00Z', null)).toBe('2026-10-20T07:35:00Z');
    expect(computedAtMasViejo(null, undefined, 'no-es-fecha')).toBeNull();
  });
});
