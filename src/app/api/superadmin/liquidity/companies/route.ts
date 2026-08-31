// ─────────────────────────────────────────────────────────────────────────────
// GET /api/superadmin/liquidity/companies
//
// Las empresas que puede mirar el módulo de Liquidez, con la marca de si tienen
// MT5 configurado.
//
// ── POR QUÉ DEVUELVE TAMBIÉN LAS QUE NO LO TIENEN ──────────────────────────
// Filtrarlas dejaría un selector más corto sin decir por qué: la empresa
// simplemente no estaría, y eso se lee como «no existe» en vez de «le falta la
// credencial». El repo trata el recorte silencioso como indistinguible de «no
// hay más», así que salen todas y la pantalla muestra el motivo.
//
// El pool NO se lee acá: esto es sólo el selector. Cuánto aporta cada cuenta lo
// decide `duplicate-account-detector.ts` y se lee por `/accounts`.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';

export interface LiquidityCompany {
  id: string;
  name: string;
  slug: string;
  /** Sin esto el módulo no puede leer MT5 y la pantalla lo dice en vez de
   *  devolver una lista vacía que parece «no hay cuentas». */
  has_mt5: boolean;
  /** Cuentas ya conectadas al pool. Permite ordenar por uso real. */
  account_count: number;
}

export async function GET() {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();

    const { data: empresas, error: e1 } = await admin
      .from('companies')
      .select('id, name, slug, status')
      .eq('status', 'active')
      .order('name');
    if (e1) return apiError('superadmin/liquidity/companies', e1, { status: 500 });

    const ids = (empresas ?? []).map((c) => String(c.id));
    if (ids.length === 0) {
      return NextResponse.json({ success: true, companies: [] });
    }

    // `is_configured` es la misma condición que usa `resolveCredential` para
    // decidir si la credencial sirve. Repetir el criterio con otra regla haría
    // que el selector dijera «configurada» y la lectura fallara igual.
    const { data: creds, error: e2 } = await admin
      .from('api_credentials')
      .select('company_id, is_configured')
      .eq('provider', 'mt5_sql')
      .in('company_id', ids);
    if (e2) return apiError('superadmin/liquidity/companies', e2, { status: 500 });

    const conMt5 = new Set(
      (creds ?? []).filter((c) => c.is_configured).map((c) => String(c.company_id)),
    );

    const { data: cuentas, error: e3 } = await admin
      .from('platform_liquidity_accounts')
      .select('company_id')
      .in('company_id', ids);
    if (e3) return apiError('superadmin/liquidity/companies', e3, { status: 500 });

    const conteo = new Map<string, number>();
    for (const c of cuentas ?? []) {
      const k = String(c.company_id);
      conteo.set(k, (conteo.get(k) ?? 0) + 1);
    }

    const companies: LiquidityCompany[] = (empresas ?? []).map((c) => ({
      id: String(c.id),
      name: String(c.name),
      slug: String(c.slug),
      has_mt5: conMt5.has(String(c.id)),
      account_count: conteo.get(String(c.id)) ?? 0,
    }));

    return NextResponse.json({ success: true, companies });
  } catch (err) {
    return apiError('superadmin/liquidity/companies', err, { status: 500 });
  }
}
