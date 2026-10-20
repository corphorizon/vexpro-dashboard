// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/commission-net-input — la cache de la migración 132.
//
// Lo que fija este test:
//   · CACHE HIT: responde de la cache SIN correr las RPC (era el problema: ~95 s
//     por visita mala) y con `computed_at`.
//   · CACHE MISS / CACHE ILEGIBLE: el fallback documentado — calcula en vivo,
//     escribe la cache, y responde lo que quedó.
//   · LA INVERSIÓN DEL SIGNO SIGUE ACÁ: la cache trae el `pnl_crm` crudo y la
//     respuesta lo da vuelta, venga de donde venga.
//   · Sin ND no hay árbol en cero: 502, igual que antes.
// La base, la auth y las RPC van mockeadas: lo que se prueba es el orden de
// las decisiones de la ruta.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { InsumosDelMes, LecturaCache, ResultadoRecomputo } from '@/lib/hr/insumos-comisiones';

const m = vi.hoisted(() => ({
  lecturas: [] as LecturaCache[],
  recomputo: null as unknown as ResultadoRecomputo,
  leerCache: null as unknown as ReturnType<typeof vi.fn>,
  recomputar: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
vi.mock('@/lib/api-auth', () => ({
  HR_ROLES: ['admin', 'hr'],
  verifyAdminAuth: async () => ({ companyId: 'empresa-del-token' }),
}));
vi.mock('@/lib/hr/crm-net-server', () => ({
  leerPerfilesComerciales: async () => [
    { id: 'head', name: 'Hugo', role: 'head', head_id: null, salary: null, hire_date: null, status: 'active' },
    { id: 'bdm', name: 'Ana', role: 'bdm', head_id: 'head', salary: null, hire_date: null, status: 'active' },
    { id: 'pnl', name: 'Diego', role: 'bdm', head_id: null, salary: null, hire_date: null, status: 'active' },
  ],
}));
vi.mock('@/lib/hr/insumos-comisiones', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/hr/insumos-comisiones')>();
  m.leerCache = vi.fn(async () => m.lecturas.shift() ?? { estado: 'sin-cache' });
  m.recomputar = vi.fn(async () => m.recomputo);
  return { ...real, leerInsumosDeCache: m.leerCache, recomputarInsumosComisiones: m.recomputar };
});

import { GET } from './route';

const ND_AT = '2026-10-20T03:35:00.000Z';
const PNL_AT = '2026-10-19T23:35:00.000Z';

const INSUMOS: InsumosDelMes = {
  netRows: [
    { profile_id: 'head', net: '100' },
    { profile_id: 'bdm', net: '50.5' },
    { profile_id: null, net: 7 },
  ],
  // CRUDO: negativo = los clientes perdieron = la empresa ganó.
  pnlRows: [{ profile_id: 'pnl', pnl_crm: '-6336.14', com_lotes: '3399.39', usuarios_red: 120 }],
  ndComputedAt: ND_AT,
  pnlComputedAt: PNL_AT,
};

const pedido = (month = '2026-09') =>
  new NextRequest(`http://localhost/api/admin/commission-net-input?month=${month}`);

const recomputo = (over: Partial<ResultadoRecomputo> = {}): ResultadoRecomputo => ({
  filas: 3,
  errores: [],
  escrito: true,
  computedAt: ND_AT,
  ndComputedAt: ND_AT,
  pnlComputedAt: ND_AT,
  crudos: { netRows: INSUMOS.netRows, pnlRows: INSUMOS.pnlRows },
  ms: 1234,
  ...over,
});

beforeEach(() => {
  m.lecturas = [];
  m.recomputo = recomputo();
  m.leerCache.mockClear();
  m.recomputar.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('GET commission-net-input — cache hit', () => {
  it('responde de la cache sin recalcular, con computed_at = el dato más viejo', async () => {
    m.lecturas = [{ estado: 'ok', insumos: INSUMOS }];
    const res = await GET(pedido());
    expect(res.status).toBe(200);
    expect(m.recomputar).not.toHaveBeenCalled();
    expect(m.leerCache).toHaveBeenCalledWith(expect.anything(), 'empresa-del-token', '2026-09-01');

    const json = await res.json();
    expect(json.fuente).toBe('cache');
    expect(json.computed_at).toBe(PNL_AT); // el PnL es más viejo que el ND
    expect(json.nd_computed_at).toBe(ND_AT);
    expect(json.pnl_computed_at).toBe(PNL_AT);

    // El árbol sale como siempre: el head suma lo del bdm; el huérfano aparte.
    const head = json.entries.find((e: { profileId: string }) => e.profileId === 'head');
    expect(head).toEqual({ profileId: 'head', own: 100, total: 150.5 });
    expect(json.unassigned).toBe(7);
    expect(json.totalCrm).toBe(157.5);
  });

  it('LA INVERSIÓN DEL SIGNO sigue acá: la cache trae crudo, la respuesta da vuelta', async () => {
    m.lecturas = [{ estado: 'ok', insumos: INSUMOS }];
    const json = await (await GET(pedido())).json();
    expect(json.pnlEntries).toEqual([
      { profileId: 'pnl', pnl: 6336.14, comLotes: 3399.39, usuariosRed: 120, sinDatoCrm: false },
    ]);
  });

  it('PnL nunca calculado en la cache → pnlEntries null + pnlError, y computed_at es el del ND', async () => {
    m.lecturas = [{ estado: 'ok', insumos: { ...INSUMOS, pnlRows: null, pnlComputedAt: null } }];
    const json = await (await GET(pedido())).json();
    expect(json.pnlEntries).toBeNull();
    expect(json.pnlError).toBeTruthy();
    expect(json.computed_at).toBe(ND_AT);
  });
});

describe('GET commission-net-input — cache miss → fallback en vivo', () => {
  it('sin cache: recalcula, escribe, relee y responde lo que quedó guardado', async () => {
    m.lecturas = [{ estado: 'sin-cache' }, { estado: 'ok', insumos: INSUMOS }];
    const res = await GET(pedido());
    expect(res.status).toBe(200);
    expect(m.recomputar).toHaveBeenCalledWith(expect.anything(), 'empresa-del-token', '2026-09-01');
    expect(m.leerCache).toHaveBeenCalledTimes(2);
    const json = await res.json();
    expect(json.fuente).toBe('en_vivo');
    expect(json.pnlEntries[0].pnl).toBe(6336.14);
  });

  it('cache ilegible (la 132 sin aplicar) y escritura caída: responde con lo que dieron las RPC', async () => {
    m.lecturas = [{ estado: 'error' }];
    m.recomputo = recomputo({ escrito: false, computedAt: null, errores: ['cache: no se pudo escribir'] });
    const res = await GET(pedido());
    expect(res.status).toBe(200);
    expect(m.leerCache).toHaveBeenCalledTimes(1); // no relee lo que no escribió
    const json = await res.json();
    expect(json.fuente).toBe('en_vivo');
    expect(json.totalCrm).toBe(157.5);
    expect(json.pnlEntries[0].pnl).toBe(6336.14); // invertido una vez, acá
    expect(typeof json.computed_at).toBe('string');
  });

  it('sin cache y la RPC del ND falla: 502, nunca un árbol en cero', async () => {
    m.lecturas = [{ estado: 'sin-cache' }];
    m.recomputo = recomputo({
      escrito: false,
      computedAt: null,
      crudos: { netRows: null, pnlRows: null },
    });
    const res = await GET(pedido());
    expect(res.status).toBe(502);
  });

  it('month inválido: 400 sin tocar la cache', async () => {
    const res = await GET(pedido('2026-13'));
    expect(res.status).toBe(400);
    expect(m.leerCache).not.toHaveBeenCalled();
    expect(m.recomputar).not.toHaveBeenCalled();
  });
});
