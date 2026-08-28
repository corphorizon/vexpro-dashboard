// ─────────────────────────────────────────────────────────────────────────────
// GET /api/superadmin/liquidity/diagnostico-mt5?company_id=...
//
// Cuánto tarda CADA paso de una lectura a MT5, medido desde donde corre la
// función y no desde la máquina de quien programa.
//
// ── PARA QUÉ EXISTE ────────────────────────────────────────────────────────
// El 2026-08-28 agregar una cuenta fallaba en producción con «Task timed out
// after 120 seconds» mientras en local la misma cuenta tardaba 7 s. Sin ver los
// tiempos DESDE Vercel no había forma de saber si el problema era abrir el
// túnel, una consulta puntual o el enlace entero — y los logs de una función
// que Vercel mata no dicen en qué paso se quedó.
//
// Este endpoint responde SIEMPRE, incluso si MT5 no contesta: cada paso está
// acotado por el timeout del cliente, así que devuelve el tiempo de lo que
// alcanzó a hacer y el error de lo que no.
//
// Es solo lectura y no escribe nada: sirve para diagnosticar, no para arreglar.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { withMt5Connection, MT5_QUERY_TIMEOUT_MS, MT5_CONNECT_TIMEOUT_MS } from '@/lib/api-integrations/mt5-sql/client';

export const dynamic = 'force-dynamic';
// Corto a propósito: si esto no termina en 60 s, el diagnóstico ES que no
// termina. Un límite largo sólo alargaría la espera para saber lo mismo.
export const maxDuration = 60;

interface Paso {
  paso: string;
  ms: number | null;
  ok: boolean;
  detalle?: string;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;

    const companyId = request.nextUrl.searchParams.get('company_id');
    if (!companyId) {
      return NextResponse.json({ success: false, error: 'Falta company_id.' }, { status: 400 });
    }
    const login = Number(request.nextUrl.searchParams.get('login') ?? 0);

    const pasos: Paso[] = [];
    const inicio = Date.now();

    async function medir(paso: string, fn: () => Promise<unknown>) {
      const t = Date.now();
      try {
        await fn();
        pasos.push({ paso, ms: Date.now() - t, ok: true });
      } catch (err) {
        pasos.push({
          paso,
          ms: Date.now() - t,
          ok: false,
          detalle: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    let errorGeneral: string | null = null;
    try {
      const tTunel = Date.now();
      await withMt5Connection(companyId, async (s) => {
        pasos.push({ paso: 'abrir tunel + conectar', ms: Date.now() - tTunel, ok: true });

        // Consulta trivial: mide el viaje de ida y vuelta puro, sin trabajo
        // del motor. Si ESTO ya tarda segundos, el problema es la red.
        await medir('SELECT 1 (ida y vuelta)', () => s.query('SELECT 1 AS x'));

        await medir('contar mt5_users', () => s.query('SELECT COUNT(*) n FROM mt5_users'));

        if (login > 0) {
          await medir(`leer login ${login}`, () =>
            s.query('SELECT Login, Balance FROM mt5_users WHERE Login = ?', [login]));
          await medir(`contar deals de ${login}`, () =>
            s.query('SELECT COUNT(*) n FROM mt5_deals WHERE Login = ?', [login]));
        }
      });
    } catch (err) {
      errorGeneral = err instanceof Error ? err.message : String(err);
    }

    return NextResponse.json({
      success: true,
      region: process.env.VERCEL_REGION ?? 'desconocida',
      limites: { conectarMs: MT5_CONNECT_TIMEOUT_MS, consultaMs: MT5_QUERY_TIMEOUT_MS },
      totalMs: Date.now() - inicio,
      pasos,
      error: errorGeneral,
    });
  } catch (err) {
    return apiError('superadmin/liquidity/diagnostico-mt5', err, { status: 500 });
  }
}
