// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cron/sync-crm
//
// Espejo diario del CRM (Orion Mongo) → Supabase: retiros, depósitos y perfiles
// de los clientes que aparecen en ellos. Fase A del módulo de Revisión de
// Retiros: las pantallas leen SIEMPRE nuestro espejo, nunca el CRM en vivo.
//
// Auth: mismo patrón CRON_SECRET fail-closed que sync-external-apis.
//   - Requiere `Authorization: Bearer <CRON_SECRET>`.
//   - Vercel Cron lo manda solo.
//   - Sin CRON_SECRET en el entorno la ruta devuelve 500: fail-closed. Una
//     ruta de sync abierta es una puerta al Mongo del broker.
//
// Disparo manual (siempre con el secreto):
//   ?company_id=<uuid>  → una sola empresa
//   ?full=1             → ignora el cursor y recorre el histórico entero
//
// Horario: 00:20 UTC (vercel.json). Elegido para no pisar a nadie —
// 23:55/05:55/11:55/17:55 sync-external-apis, 00:00 balances, 00:05 reportes,
// 07:30 notification-sweep. A las 00:20 los reportes ya salieron, así que una
// carga completa de 13.500 retiros no le compite CPU a nada.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { runCrmSync } from '@/lib/crm-sync/sync';
import {
  syncPayprosDepositsFromCrm,
  type PayprosFromCrmResult,
} from '@/lib/api-integrations/paypros/deposits-from-crm';
import type { CrmSyncResult } from '@/lib/crm-sync/types';
import { apiError } from '@/lib/api-error';

export const maxDuration = 300; // hasta 5 min: la primera corrida es completa

interface CompanyRow {
  id: string;
  name: string | null;
}

/**
 * Empresas que tienen la credencial `orion_mongo` cargada y activa. Sin
 * credencial no hay nada que sincronizar, y recorrer todos los tenants sólo
 * sirve para llenar los logs de "no configurado".
 */
async function eligibleCompanies(onlyCompanyId?: string | null): Promise<CompanyRow[]> {
  const admin = createAdminClient();

  const { data: creds, error: credsError } = await admin
    .from('api_credentials')
    .select('company_id')
    .eq('provider', 'orion_mongo')
    .eq('is_configured', true);
  if (credsError) throw new Error(`no se pudo listar api_credentials: ${credsError.message}`);

  const ids = [
    ...new Set(
      (creds ?? [])
        .map((r) => (typeof r.company_id === 'string' ? r.company_id : null))
        .filter((v): v is string => Boolean(v)),
    ),
  ].filter((id) => !onlyCompanyId || id === onlyCompanyId);

  if (ids.length === 0) return [];

  const { data: companies, error } = await admin
    .from('companies')
    .select('id, name, status')
    .in('id', ids)
    .neq('status', 'inactive');
  if (error) throw new Error(`no se pudo listar companies: ${error.message}`);

  return (companies ?? []).map((c) => ({ id: String(c.id), name: c.name ?? null }));
}

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[cron/sync-crm] CRON_SECRET not set');
    return NextResponse.json(
      { success: false, error: 'CRON_SECRET not configured' },
      { status: 500 },
    );
  }
  if (request.headers.get('authorization') !== `Bearer ${expected}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const onlyCompanyId = url.searchParams.get('company_id');
  const full = url.searchParams.get('full') === '1';

  const ranAt = new Date().toISOString();

  try {
    const companies = await eligibleCompanies(onlyCompanyId);
    const admin = createAdminClient();

    // Secuencial a propósito: cada empresa abre su propia conexión al Mongo del
    // broker (maxPoolSize 1) y la primera corrida mueve decenas de miles de
    // filas. Paralelizar tenants sólo multiplicaría la carga sobre el CRM.
    const results: (CrmSyncResult & {
      companyName: string | null;
      paypros?: PayprosFromCrmResult | null;
    })[] = [];
    for (const company of companies) {
      try {
        const res = await runCrmSync({ companyId: company.id, full });

        // Los depósitos de Pay-Pros salen de acá y no del webhook: la URL que
        // se registró con Pay-Pros es la del CRM, no la nuestra, así que el
        // receptor nunca recibió un evento. Va DESPUÉS del sync porque lee del
        // espejo que el sync acaba de refrescar.
        //
        // Que falle no puede tumbar la sincronización: el espejo ya quedó bien
        // y es lo que alimenta la revisión de retiros. Se anota y se sigue.
        let paypros: PayprosFromCrmResult | null = null;
        const payprosErrors: string[] = [];
        try {
          paypros = await syncPayprosDepositsFromCrm(admin, company.id);
          if (paypros.warnings.length > 0) {
            console.warn(`[cron/sync-crm] paypros ${company.id}:`, paypros.warnings.join(' | '));
          }
        } catch (err) {
          payprosErrors.push(`paypros: ${err instanceof Error ? err.message : 'unknown'}`);
        }

        results.push({
          ...res,
          companyName: company.name,
          paypros,
          errors: [...res.errors, ...payprosErrors],
        });
      } catch (err) {
        // Una empresa que revienta no puede cortar a las demás.
        const msg = err instanceof Error ? err.message : 'unknown';
        console.error(`[cron/sync-crm] ${company.id} falló:`, msg);
        results.push({
          companyId: company.id,
          companyName: company.name,
          ranAt,
          full,
          since: { withdrawals: null, deposits: null },
          withdrawals: { fetched: 0, upserted: 0 },
          deposits: { fetched: 0, upserted: 0 },
          users: { fetched: 0, upserted: 0 },
          unknownStatuses: [],
          corruptDepositValues: 0,
          cursors: { withdrawals: null, deposits: null },
          elapsedMs: 0,
          errors: [msg],
        });
      }
    }

    return NextResponse.json({
      success: true,
      ranAt,
      full,
      companies_processed: results.length,
      companies_failed: results.filter((r) => r.errors.length > 0).length,
      results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[cron/sync-crm]', msg);
    return apiError('cron/sync-crm', err, { status: 500 });
  }
}
