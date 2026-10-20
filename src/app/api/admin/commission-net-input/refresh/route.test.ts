// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/commission-net-input/refresh — el botón «Actualizar».
//
// Fija: el mes se valida antes de recalcular, la empresa sale del TOKEN y no
// del body (§4.2), un recálculo a medias se DICE (`errores`, 200) y uno que no
// escribió nada es 502.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { ResultadoRecomputo } from '@/lib/hr/insumos-comisiones';

const m = vi.hoisted(() => ({
  r: null as unknown as ResultadoRecomputo,
  recomputar: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
vi.mock('@/lib/api-auth', () => ({
  HR_ROLES: ['admin', 'hr'],
  verifyAdminAuth: async () => ({ companyId: 'empresa-del-token' }),
}));
vi.mock('@/lib/hr/insumos-comisiones', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/hr/insumos-comisiones')>();
  m.recomputar = vi.fn(async () => m.r);
  return { ...real, recomputarInsumosComisiones: m.recomputar };
});

import { POST } from './route';

const AT = '2026-10-20T12:00:00.000Z';
const base: ResultadoRecomputo = {
  filas: 126,
  errores: [],
  escrito: true,
  computedAt: AT,
  ndComputedAt: AT,
  pnlComputedAt: AT,
  crudos: { netRows: [], pnlRows: [] },
  ms: 2100,
};

const pedido = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/commission-net-input/refresh', {
    method: 'POST',
    body: JSON.stringify(body),
  });

beforeEach(() => {
  m.r = { ...base };
  m.recomputar.mockClear();
});

describe('POST commission-net-input/refresh', () => {
  it('recalcula el mes pedido para la empresa del TOKEN, aunque el body traiga otra', async () => {
    const res = await POST(pedido({ month: '2026-09-01', company_id: 'empresa-ajena' }));
    expect(res.status).toBe(200);
    expect(m.recomputar).toHaveBeenCalledWith(expect.anything(), 'empresa-del-token', '2026-09-01');
    expect(await res.json()).toEqual({
      success: true, month: '2026-09-01', computed_at: AT, filas: 126, errores: [],
    });
  });

  it('una métrica caída: 200 pero con los errores a la vista', async () => {
    m.r = { ...base, errores: ['pnl: la RPC falló'] };
    const json = await (await POST(pedido({ month: '2026-09-01' }))).json();
    expect(json.success).toBe(true);
    expect(json.errores).toEqual(['pnl: la RPC falló']);
  });

  it('no se escribió nada: 502 y success false', async () => {
    m.r = { ...base, escrito: false, computedAt: null, filas: 0, errores: ['nd', 'pnl'] };
    const res = await POST(pedido({ month: '2026-09-01' }));
    expect(res.status).toBe(502);
    expect((await res.json()).success).toBe(false);
  });

  it('month inválido o ausente: 400 sin recalcular', async () => {
    for (const body of [{}, { month: '2026-13-01' }, { month: 202609 }, null]) {
      const res = await POST(pedido(body));
      expect(res.status).toBe(400);
    }
    expect(m.recomputar).not.toHaveBeenCalled();
  });
});
