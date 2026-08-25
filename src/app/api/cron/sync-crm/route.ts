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
import { syncExposure, type ExposureResult } from '@/lib/mt5-sync/exposure';
import { syncAllOrionUsers, type AllUsersResult } from '@/lib/crm-sync/all-users';
import { syncCustomerAggregates, type AggregatesResult } from '@/lib/crm-sync/aggregates';
import type { CrmSyncResult } from '@/lib/crm-sync/types';
import { apiError } from '@/lib/api-error';

export const maxDuration = 300; // hasta 5 min: la primera corrida es completa

interface CompanyRow {
  id: string;
  name: string | null;
}

/**
 * Correos a espejar en ESTA corrida.
 *
 * ── EL UNIVERSO ES EL CRM, NO MT5 ──────────────────────────────────────────
 * Kevin lo amplió el 2026-08-25 al universo completo (8.709 clientes). El
 * criterio anterior —"tiene un retiro reciente"— se mordía la cola: elegía por
 * actividad reciente y por lo tanto excluía por construcción a quien dejó de
 * estar activo. Medido entonces: 1.395 de 1.678 espejados (83%) habían operado
 * en los últimos 30 días, y sólo 16 llevaban más de 90 sin operar. Para la
 * revisión de retiros daba igual; para llamar a quien dejó de operar, el
 * espejo tenía a todos menos a los que había que llamar.
 *
 * ── POR QUÉ POR TANDAS ─────────────────────────────────────────────────────
 * Los 8.709 son ~3,7 min a la tasa medida (1.787 correos → 4.797 cuentas en
 * 45 s) y la corrida tiene 5 min para todo, sync del CRM incluido. Así que:
 *
 *   · PENDIENTES: siempre, sin importar cuándo se miraron. Es el dato sobre el
 *     que alguien decide hoy.
 *   · EL RESTO: una tanda ordenada por antigüedad del último intento, los más
 *     viejos primero. Con 6 corridas diarias el universo converge en menos de
 *     un día y después se mantiene solo.
 *
 * La antigüedad sale de `mt5_email_sync_state` y NO de `mt5_account_activity`,
 * y la diferencia es la que hace que esto funcione: un cliente sin cuenta en
 * MT5 no deja fila en el espejo, así que ordenar por el espejo lo dejaría para
 * siempre como "nunca mirado", eternamente al frente de la cola, bloqueando la
 * rotación del resto del universo.
 */
const TRADING_BATCH = 2500;

async function emailsNeedingTradingActivity(
  admin: ReturnType<typeof createAdminClient>,
  companyId: string,
): Promise<string[]> {
  const norm = (e: string) => e.trim().toLowerCase();

  // ── 1. Pendientes: prioridad absoluta ───────────────────────────────────
  const { data: pend, error: pErr } = await admin
    .from('crm_withdrawals')
    .select('user_external_id')
    .eq('company_id', companyId)
    .eq('status_norm', 'pending')
    .limit(2000);
  if (pErr) throw new Error(`retiros pendientes para MT5: ${pErr.message}`);

  const pendIds = [
    ...new Set((pend ?? []).map((r) => r.user_external_id).filter((v): v is string => !!v)),
  ];

  let pendientes: string[] = [];
  if (pendIds.length > 0) {
    const { data, error } = await admin
      .from('crm_user_snapshots')
      .select('email')
      .eq('company_id', companyId)
      .in('user_external_id', pendIds);
    if (error) throw new Error(`perfiles pendientes para MT5: ${error.message}`);
    pendientes = [...new Set((data ?? []).map((u) => u.email).filter((e): e is string => !!e))];
  }

  // ── 2. El universo, y cuándo se miró cada uno ───────────────────────────
  // Paginado a mano: PostgREST corta en 1.000 filas en silencio, y con 8.709
  // clientes eso significaría espejar siempre el mismo primer millar.
  const todos = await fetchAll<{ email: string | null }>((from, to) =>
    admin
      .from('crm_user_snapshots')
      .select('email')
      .eq('company_id', companyId)
      // Orden obligatorio al paginar: sin él las páginas pueden repetir una
      // fila y saltarse otra, sin dar error.
      .order('user_external_id', { ascending: true })
      .range(from, to),
  );
  const estados = await fetchAll<{ email: string; last_attempt_at: string }>((from, to) =>
    admin
      .from('mt5_email_sync_state')
      .select('email, last_attempt_at')
      .eq('company_id', companyId)
      .order('email', { ascending: true })
      .range(from, to),
  );

  const visto = new Map(estados.map((e) => [norm(e.email), e.last_attempt_at]));
  const pendSet = new Set(pendientes.map(norm));

  const resto = [
    ...new Set(
      todos
        .map((u) => (u.email ? norm(u.email) : null))
        .filter((e): e is string => !!e && !pendSet.has(e)),
    ),
  ]
    // Nunca mirados primero (cadena vacía ordena antes que cualquier fecha),
    // después los más viejos.
    .sort((a, b) => (visto.get(a) ?? '').localeCompare(visto.get(b) ?? ''))
    .slice(0, TRADING_BATCH);

  return [...pendientes, ...resto];
}

/**
 * Trae TODAS las filas paginando. PostgREST devuelve como mucho 1.000 por
 * consulta y no avisa: sin esto, una tabla de 8.709 filas se leería como 1.000
 * y nadie lo notaría.
 */
async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const SIZE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await page(from, from + SIZE - 1);
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    out.push(...batch);
    if (batch.length < SIZE) return out;
  }
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

  // ── DOS MODOS ────────────────────────────────────────────────────────────
  // RÁPIDO (cada 15 min, el default): espeja los movimientos del CRM y
  // recalcula los agregados SÓLO de quien movió dinero. Es lo que necesita el
  // traspaso a Retención, que se dispara con `depositCount` y tiene 15 minutos
  // como requisito de negocio — medido por la sesión de Atlas.
  //
  // COMPLETO (`?mode=full`, cada 4 h): además espeja los 20.900 usuarios, la
  // tanda de MT5 y recalcula TODOS los agregados. Lo pesado va acá porque
  // barrer tres colecciones de Mongo cada 15 minutos multiplicaría por 16 la
  // carga sobre la base de PRODUCCIÓN del broker para refrescar datos que casi
  // nunca cambian.
  const modoCompleto = url.searchParams.get('mode') === 'full' || full;

  // Ventana del modo rápido: qué se considera "movido". Se toma con holgura
  // sobre los 15 minutos para que una corrida que se retrase no deje un hueco
  // — releer de más es barato, perderse un depósito no.
  const desde = new Date(Date.now() - 45 * 60 * 1000).toISOString();

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
      exposure?: ExposureResult | null;
      allUsers?: AllUsersResult | null;
      aggregates?: AggregatesResult | null;
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
          // La actividad de trading no la mira el traspaso a Retención, así
          // que no necesita 15 minutos: va con el modo completo.
          const emails = modoCompleto ? await emailsNeedingTradingActivity(admin, company.id) : [];
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

        // ── Universo completo de usuarios + agregados ──────────────────────
        // Esto es lo que le vamos a servir a Atlas para que deje su propia
        // conexión a Orion. Va DESPUÉS del sync de movimientos porque los
        // agregados de depósitos y retiros se calculan sobre nuestro espejo.
        //
        // Aislado como los demás: si falla, el módulo de retiros —que es lo
        // que ya está en producción— sigue funcionando igual.
        let allUsers: AllUsersResult | null = null;
        let aggregates: AggregatesResult | null = null;
        const orionErrors: string[] = [];
        try {
          // Sin cursor a propósito por ahora: son 20.918 documentos en 23 s y
          // `users` NO tiene índice por `updatedAt` en el broker (verificado
          // por Atlas el 21/08), así que un filtro por fecha no ahorraría el
          // barrido. Cuando Orion agregue ese índice, acá va el cursor con
          // `$gte` — nunca `$gt`: dos usuarios pueden compartir milisegundo y
          // el segundo se perdería para siempre.
          // El barrido de usuarios sólo en el modo completo: son 20.900
          // documentos y casi ninguno cambia entre una corrida y la siguiente.
          if (modoCompleto) {
            allUsers = await syncAllOrionUsers(admin, company.id, null);
          }
          aggregates = await syncCustomerAggregates(admin, company.id, {
            changedSince: modoCompleto ? null : desde,
          });
          for (const w of [...(allUsers?.warnings ?? []), ...aggregates.warnings]) {
            console.warn(`[cron/sync-crm] orion ${company.id}: ${w}`);
          }
        } catch (err) {
          orionErrors.push(`orion-agregados: ${err instanceof Error ? err.message : 'unknown'}`);
        }

        // ── Riesgo vivo: exposición abierta y margen ──────────────────────
        // Va en TODAS las corridas, incluida la rápida: es un dato que cambia
        // minuto a minuto y cuya utilidad depende de estar fresco. Cuesta ~8 s.
        let exposure: ExposureResult | null = null;
        const expErrors: string[] = [];
        try {
          exposure = await syncExposure(admin, company.id);
          for (const w of exposure.warnings) {
            console.warn(`[cron/sync-crm] exposicion ${company.id}: ${w}`);
          }
        } catch (err) {
          // Sin credenciales de MT5 el tenant no tiene esta vista: no es fallo.
          const msg = err instanceof Error ? err.message : 'unknown';
          if (!/no configurad|not configured|sin credencial/i.test(msg)) {
            expErrors.push(`exposicion: ${msg}`);
          }
        }

        results.push({
          ...res,
          companyName: company.name,
          paypros,
          mt5,
          exposure,
          allUsers,
          aggregates,
          errors: [...res.errors, ...payprosErrors, ...mt5Errors, ...orionErrors, ...expErrors],
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
      modo: modoCompleto ? 'completo' : 'rapido',
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
