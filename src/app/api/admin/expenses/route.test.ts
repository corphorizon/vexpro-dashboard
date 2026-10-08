// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/expenses — guard de huella (2026-10-08).
//
// Lo que fija este test: con una huella distinta a la del período, la RPC
// replace_period_expenses NO corre. Es la única línea entre una pestaña vieja
// y el pisón silencioso que borró $6,000 de egresos de Horizon ese día; si
// alguien reordena el handler y la RPC queda antes del chequeo, esto rompe.
// La base y la auth van mockeadas: lo que se prueba es el orden de las
// decisiones de la ruta, no PostgREST.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type Fila = { id: string; payment_order_id: string | null; updated_at: string | null };

const db = vi.hoisted(() => ({
  filas: [] as Fila[],
  filasTrasRpc: [] as Fila[],
  /** count que reporta PostgREST; undefined = el real (filas.length). */
  countForzado: undefined as number | undefined,
  rpc: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('@/lib/supabase/admin', () => {
  db.rpc = vi.fn(async () => {
    db.filas = db.filasTrasRpc;
    return { error: null };
  });
  const from = () => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
      Promise.resolve({
        data: db.filas,
        error: null,
        count: db.countForzado ?? db.filas.length,
      }).then(ok, ko);
    return q;
  };
  return { createAdminClient: () => ({ from, rpc: db.rpc }) };
});

vi.mock('@/lib/api-auth', () => ({
  FINANCE_ROLES: ['admin'],
  verifyAdminAuth: async () => ({ companyId: 'empresa-del-token' }),
}));

import { POST } from './route';

const T1 = '2026-10-08T10:00:00+00:00';
const T2 = '2026-10-08T10:20:00+00:00';
const OP = '11111111-1111-1111-1111-111111111111';

function pedido(body: unknown) {
  return new NextRequest('http://localhost/api/admin/expenses', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

const fila = { concept: 'Hosting', amount: 100, paid: 0, pending: 100 };

beforeEach(() => {
  db.filas = [
    { id: 'a', payment_order_id: null, updated_at: T1 },
    { id: 'b', payment_order_id: null, updated_at: T1 },
    { id: 'op', payment_order_id: OP, updated_at: T2 },
  ];
  db.filasTrasRpc = [
    { id: 'c', payment_order_id: null, updated_at: T2 },
    { id: 'op', payment_order_id: OP, updated_at: T2 },
  ];
  db.countForzado = undefined;
  db.rpc.mockClear();
});

describe('POST /api/admin/expenses — guard de huella', () => {
  it('baseline igual a la huella actual → corre la RPC y devuelve la huella nueva', async () => {
    const res = await POST(
      pedido({ periodId: 'p1', rows: [fila], baseline: { count: 2, maxUpdatedAt: T1 } }),
    );
    expect(res.status).toBe(200);
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc.mock.calls[0][1]).toMatchObject({ p_company_id: 'empresa-del-token', p_period_id: 'p1' });
    const json = await res.json();
    expect(json).toEqual({ success: true, huella: { count: 1, maxUpdatedAt: T2 } });
  });

  it('las filas de OP no entran a la huella: una OP pagada no bloquea el guardado', async () => {
    // La fila de OP tiene T2, más nueva que el baseline: igual pasa.
    const res = await POST(
      pedido({ periodId: 'p1', rows: [fila], baseline: { count: 2, maxUpdatedAt: T1 } }),
    );
    expect(res.status).toBe(200);
  });

  it('otra pestaña agregó un egreso (count distinto) → 409 y la RPC NO corre', async () => {
    const res = await POST(
      pedido({ periodId: 'p1', rows: [fila], baseline: { count: 1, maxUpdatedAt: T1 } }),
    );
    expect(res.status).toBe(409);
    expect(db.rpc).not.toHaveBeenCalled();
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe('conflict');
    expect(json.actual).toEqual({ count: 2, maxUpdatedAt: T1 });
    expect(json.mensaje).toContain('ahora tiene 2 egresos manuales');
    expect(json.mensaje).toContain('esta pantalla partió de 1');
  });

  it('otra pestaña guardó sin cambiar el count (updated_at distinto) → 409 y la RPC NO corre', async () => {
    const res = await POST(
      pedido({ periodId: 'p1', rows: [fila], baseline: { count: 2, maxUpdatedAt: '2026-10-08T09:00:00+00:00' } }),
    );
    expect(res.status).toBe(409);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('baseline mal formado → 400 y la RPC NO corre (nunca degrada a guardar sin guard)', async () => {
    const res = await POST(pedido({ periodId: 'p1', rows: [fila], baseline: { count: '2' } }));
    expect(res.status).toBe(400);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('lectura de la huella recortada → error y la RPC NO corre', async () => {
    db.countForzado = 5000; // PostgREST dice 5000, llegaron 3
    const res = await POST(
      pedido({ periodId: 'p1', rows: [fila], baseline: { count: 2, maxUpdatedAt: T1 } }),
    );
    expect(res.status).toBe(500);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('sin baseline (cliente viejo en caché) → comportamiento anterior: corre la RPC', async () => {
    const res = await POST(pedido({ periodId: 'p1', rows: [fila] }));
    expect(res.status).toBe(200);
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });
});
