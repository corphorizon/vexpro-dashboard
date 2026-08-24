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
import { syncTradingActivity, type Mt5SyncResult } from '@/lib/mt5-sync/trading-activity';
import type { CrmSyncResult } from '@/lib/crm-sync/types';
import { apiError } from '@/lib/api-error';

export const maxDuration = 300; // hasta 5 min: la primera corrida es completa

interface CompanyRow {
  id: string;
  name: string | null;
}

/**
 * Correos cuya actividad de trading vale la pena refrescar en ESTA corrida.
 *
 * Dos grupos con urgencia distinta, y la diferencia importa: espejar los 1.787
 * clientes con retiro en los últimos 45 días tarda 45 s y son casi todos datos
 * que no cambiaron. Repetirlo seis veces al día es carga regalada sobre la
 * base de producción del broker.
 *
 *  · PENDIENTES: siempre. Es el dato sobre el que alguien va a decidir hoy y
 *    tiene que estar fresco.
 *  · RECIENTES (45 días): sólo si su espejo tiene más de 20 h. Sirven de
 *    contexto en una ficha ya decidida; que tengan un día de atraso no cambia
 *    ninguna decisión.
 *
 * ── LÍMITE CONOCIDO, MEDIDO EL 2026-08-24 ──────────────────────────────────
 * Este criterio SE MUERDE LA COLA para cualquier uso que necesite gente
 * INACTIVA. Seleccionar por "tiene un retiro reciente" selecciona, casi por
 * definición, a gente activa: quien dejó de operar hace seis meses tampoco
 * pide retiros, así que nunca entra. Sobre los 1.678 espejados:
 *
 *     operó hace <30 d  1.395 (83%)      90-180 d   12
 *     30-90 d             252            >180 d      4  ·  nunca operó  7
 *
 * Dieciséis clientes con más de 90 días sin operar, en TODO el espejo.
 *
 * Para la revisión de retiros está BIEN: sólo importa quien pide plata ahora.
 * Pero si el call center quiere llamar a quien dejó de operar, el espejo
 * tendría a todos menos a los que hay que llamar.
 *
 * Cuando llegue ese momento el criterio tiene que salir del CRM ("existe como
 * cliente") y no de MT5 ("hizo algo hace poco"). Espejar los 8.709 del CRM son
 * ~3,7 min a la tasa medida: no entra en una corrida, se hace por tandas
 * rotando por antigüedad del espejo y converge en menos de un día.
 */
const TRADING_RECENT_DAYS = 45;
const TRADING_STALE_HOURS = 20;

async function emailsNeedingTradingActivity(
  admin: ReturnType<typeof createAdminClient>,
  companyId: string,
): Promise<string[]> {
  const since = new Date(Date.now() - TRADING_RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: pend, error: pErr } = await admin
    .from('crm_withdrawals')
    .select('user_external_id')
    .eq('company_id', companyId)
    .eq('status_norm', 'pending')
    .limit(2000);
  if (pErr) throw new Error(`retiros pendientes para MT5: ${pErr.message}`);

  const { data: rec, error: rErr } = await admin
    .from('crm_withdrawals')
    .select('user_external_id')
    .eq('company_id', companyId)
    .gte('requested_at', since)
    .limit(5000);
  if (rErr) throw new Error(`retiros recientes para MT5: ${rErr.message}`);

  const idsOf = (rows: { user_external_id: string | null }[] | null) =>
    [...new Set((rows ?? []).map((r) => r.user_external_id).filter((v): v is string => !!v))];

  const emailsOf = async (ids: string[]): Promise<string[]> => {
    if (ids.length === 0) return [];
    const { data, error } = await admin
      .from('crm_user_snapshots')
      .select('email')
      .eq('company_id', companyId)
      .in('user_external_id', ids);
    if (error) throw new Error(`perfiles para MT5: ${error.message}`);
    return [...new Set((data ?? []).map((u) => u.email).filter((e): e is string => !!e))];
  };

  const pendientes = await emailsOf(idsOf(pend));
  const recientes = await emailsOf(idsOf(rec));

  // De los recientes, descartar los que ya se espejaron hace poco.
  const fresco = new Date(Date.now() - TRADING_STALE_HOURS * 60 * 60 * 1000).toISOString();
  const { data: yaFrescos, error: fErr } = await admin
    .from('mt5_account_activity')
    .select('email')
    .eq('company_id', companyId)
    .gte('synced_at', fresco)
    .limit(20000);
  if (fErr) throw new Error(`frescura MT5: ${fErr.message}`);

  const frescos = new Set(
    (yaFrescos ?? []).map((r) => (r.email ? String(r.email).trim().toLowerCase() : '')),
  );
  const norm = (e: string) => e.trim().toLowerCase();
  const pendSet = new Set(pendientes.map(norm));

  return [
    ...pendientes,
    ...recientes.filter((e) => !pendSet.has(norm(e)) && !frescos.has(norm(e))),
  ];
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
      mt5?: Mt5SyncResult | null;
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

        // ── Actividad de trading (MT5) ────────────────────────────────────
        // Sólo para los clientes con retiro pendiente o reciente: ahí es donde
        // la señal se usa, y mantiene el costo sobre la base del broker en
        // decenas de cuentas en vez de 26.422.
        //
        // Va al final y aislado por la misma razón que Pay-Pros: si la base
        // del broker no responde, el espejo del CRM ya quedó bien y la
        // revisión de retiros sigue funcionando sin esta señal.
        let mt5: Mt5SyncResult | null = null;
        const mt5Errors: string[] = [];
        try {
          const emails = await emailsNeedingTradingActivity(admin, company.id);
          if (emails.length > 0) {
            mt5 = await syncTradingActivity(admin, company.id, emails);
            if (mt5.warnings.length > 0) {
              console.warn(`[cron/sync-crm] mt5 ${company.id}:`, mt5.warnings.join(' | '));
            }
          }
        } catch (err) {
          // Sin credenciales de MT5 el tenant simplemente no tiene esta señal:
          // no es un fallo del sync y no debe contarse como empresa fallida.
          const msg = err instanceof Error ? err.message : 'unknown';
          if (!/no configurad|not configured|sin credencial/i.test(msg)) {
            mt5Errors.push(`mt5: ${msg}`);
          }
        }

        results.push({
          ...res,
          companyName: company.name,
          paypros,
          mt5,
          errors: [...res.errors, ...payprosErrors, ...mt5Errors],
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
