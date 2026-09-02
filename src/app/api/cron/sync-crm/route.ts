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
//   ?espejo=full        → SÓLO el espejo base (retiros, depósitos y perfiles)
//                         con los cursores desde cero, sin ningún extra
//   ?pnl_from=&pnl_to=  → backfill del cierre diario de PNL para ese rango
//                         (`YYYY-MM-DD`, UTC, inclusive)
//
// En la respuesta, `full` significa "los cursores se ignoraron" y por lo tanto
// es true con `?full=1` Y con `?espejo=full`; el que distingue cuál corrió es
// `modo` ('rapido' | 'completo' | 'espejo').
//
// ── POR QUÉ EXISTE ?espejo=full: el re-barrido diario ───────────────────────
// Medido entre el 2026-08-31 y el 2026-09-01: SEIS retiros de agosto —
// aprobados, USER_WITHDRAW, pedidos entre el 17 y el 21— nunca llegaron a
// `crm_withdrawals`, aunque el sync incremental corrió cada 15 minutos todos
// esos días y el espejo ya tenía retiros del 29 y del 30. Sus `createdAt` y
// `updatedAt` eran normales y del mismo día del retiro, así que el filtro
// incremental TENÍA que haberlos visto. Un disparo manual con `?full=1` los
// recuperó a los seis. Faltaban US$ 9.536,98, y eso desviaba el net deposit de
// RRHH contra el panel oficial del CRM: el fallo que no da error.
//
// La causa raíz no es determinable desde afuera. La sospecha principal es que
// un `find()` sin `sort` sobre la colección VIVA puede saltarse documentos bajo
// escrituras concurrentes: el cursor no garantiza aislamiento de snapshot entre
// batches. No es reproducible a voluntad, así que no hay arreglo que probar; lo
// que sí se puede acotar es cuánto vive un fantasma. Los seis vivieron 10+
// días. Con un re-barrido diario, 24 h.
//
// LO QUE SE DESCARTÓ: programar el `?full=1` completo como cron. Se midió
// FUNCTION_INVOCATION_TIMEOUT (excede los 300 s de `maxDuration`), porque
// `full=1` además prende `modoCompleto`: allUsers (20.9k documentos),
// walletSources (recorre `wallettransfers` entera), ibProduction, behavior, la
// tanda de MT5… `?espejo=full` es exactamente la parte que sí entra en el
// presupuesto: el espejo base es una fracción de la corrida completa.
//
// La diferencia, en dos líneas:
//   ?full=1      = TODO + cursores desde cero. Manual. Puede exceder los 300 s.
//   ?espejo=full = SÓLO el espejo base + cursores desde cero. Apto para cron.
//
// Horario: 00:20 UTC (vercel.json). Elegido para no pisar a nadie —
// 23:55/05:55/11:55/17:55 sync-external-apis, 00:00 balances, 00:05 reportes,
// 07:30 notification-sweep. A las 00:20 los reportes ya salieron, así que una
// carga completa de 13.500 retiros no le compite CPU a nada.
//
// El re-barrido `?espejo=full` va a las 03:35 UTC, y NO a las 03:40 como se
// pensó primero: `sync-health` ocupa el minuto :40 de TODAS las horas. Tampoco
// :00/:15/:30/:45, que son la grilla de los `*/15` (este mismo cron en modo
// rápido, mt5-pnl) más account-review y propfirm-review. A las 03:35 el minuto
// está vacío y quedan 10 minutos limpios hasta la corrida rápida de las 03:45.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { runCrmSync } from '@/lib/crm-sync/sync';
import {
  syncPayprosDepositsFromCrm,
  type PayprosFromCrmResult,
} from '@/lib/api-integrations/paypros/deposits-from-crm';
import {
  syncPayprosWithdrawalsFromCrm,
  type PayprosWithdrawalsFromCrmResult,
} from '@/lib/api-integrations/paypros/withdrawals-from-crm';
import { syncTradingActivity, type Mt5SyncResult } from '@/lib/mt5-sync/trading-activity';
import { syncExposure, type ExposureResult } from '@/lib/mt5-sync/exposure';
import { syncWalletSources, type WalletSourcesResult } from '@/lib/crm-sync/wallet-sources';
import { syncIbProduction, type IbProductionResult } from '@/lib/crm-sync/ib-production';
import { syncCrmMonthlyTotals, type CrmMonthlyTotalsResult } from '@/lib/crm-sync/monthly-totals';
import {
  syncCrmDailyPnl,
  defaultWindow,
  CRM_PNL_WINDOW_FAST_DAYS,
  CRM_PNL_WINDOW_FULL_DAYS,
  type CrmDailyPnlSyncResult,
} from '@/lib/crm-sync/daily-pnl-sync';
import { syncTradingAccounts, type TradingAccountsResult } from '@/lib/crm-sync/trading-accounts';
import { syncTradingBehavior, type BehaviorResult } from '@/lib/mt5-sync/behavior';
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
 * Cuentas cuyo comportamiento de trading vale la pena analizar: las de los
 * clientes con un retiro pendiente. Es deliberadamente estrecho — emparejar
 * entrada y salida por PositionID cuesta ~17 s cada 60 cuentas sobre las 68
 * millones de filas de mt5_deals, así que esto NO se hace para las 26.000.
 */
async function accountsNeedingBehavior(
  admin: ReturnType<typeof createAdminClient>,
  companyId: string,
): Promise<Array<{ login: number; email: string | null; group: string | null }>> {
  const { data: pend, error } = await admin
    .from('crm_withdrawals')
    .select('user_external_id')
    .eq('company_id', companyId)
    .eq('status_norm', 'pending')
    .limit(500);
  if (error) throw new Error(`pendientes para comportamiento: ${error.message}`);

  const ids = [...new Set((pend ?? []).map((r) => r.user_external_id).filter((v): v is string => !!v))];
  if (ids.length === 0) return [];

  const { data: users, error: uErr } = await admin
    .from('crm_user_snapshots')
    .select('email')
    .eq('company_id', companyId)
    .in('user_external_id', ids);
  if (uErr) throw new Error(`perfiles para comportamiento: ${uErr.message}`);

  const emails = [...new Set((users ?? []).map((u) => u.email).filter((e): e is string => !!e))]
    .map((e) => e.trim().toLowerCase());
  if (emails.length === 0) return [];

  // Sólo cuentas REALES y que hayan operado: analizar una cuenta sin
  // operaciones devuelve una fila vacía y gasta el presupuesto igual.
  const { data: accts, error: aErr } = await admin
    .from('mt5_account_activity')
    .select('login, email, group_name')
    .eq('company_id', companyId)
    .eq('is_demo', false)
    .gt('deals_count', 0)
    .in('email', emails)
    .order('deals_count', { ascending: false })
    .limit(500);
  if (aErr) throw new Error(`cuentas para comportamiento: ${aErr.message}`);

  return (accts ?? []).map((a) => ({
    login: Number(a.login),
    email: a.email ? String(a.email) : null,
    group: a.group_name ? String(a.group_name) : null,
  }));
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

  // Re-barrido del espejo base con los cursores desde cero y SIN extras (ver la
  // cabecera: los seis retiros fantasma de agosto). Es el único modo que puede
  // ir en un cron, porque `?full=1` se pasa de los 300 s.
  const soloEspejo = url.searchParams.get('espejo') === 'full';

  // Los dos caminos que ignoran el cursor. `runCrmSync` lo llama `full` y es lo
  // que se reporta en la respuesta: "los cursores se ignoraron", no "corrió
  // todo". Lo que corrió lo dice `modo`.
  const cursoresDesdeCero = full || soloEspejo;

  // Rango manual para el backfill del cierre diario de PNL. Sólo se acepta
  // `YYYY-MM-DD` exacto: una fecha a medias iría a Mongo como texto y ahí un
  // filtro que no matchea devuelve CERO documentos sin dar error, que es
  // indistinguible de "ese mes no operó nadie".
  const fecha = (k: string) => {
    const v = url.searchParams.get(k);
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  };
  const pnlFrom = fecha('pnl_from');
  const pnlTo = fecha('pnl_to');

  // ── TRES MODOS (decía DOS hasta que se agregó el espejo) ─────────────────
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
  //
  // ESPEJO (`?espejo=full`, diario) es un tercer modo y NO prende `modoCompleto`
  // a propósito: prenderlo lo volvería la corrida completa, que es justo la que
  // se midió pasándose de los 300 s. Salta TODOS los extras, incluidos los que
  // el modo rápido sí hace (paypros, exposición, pnl diario).
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
      payprosWithdrawals?: PayprosWithdrawalsFromCrmResult | null;
      mt5?: Mt5SyncResult | null;
      exposure?: ExposureResult | null;
      walletSources?: WalletSourcesResult | null;
      ibProduction?: IbProductionResult | null;
      tradingAccounts?: TradingAccountsResult | null;
      dailyPnl?: CrmDailyPnlSyncResult | null;
      behavior?: BehaviorResult | null;
      allUsers?: AllUsersResult | null;
      aggregates?: AggregatesResult | null;
      monthlyTotals?: CrmMonthlyTotalsResult | null;
    })[] = [];
    for (const company of companies) {
      try {
        // El espejo base: retiros, depósitos y los perfiles que aparecen en
        // ellos. Con `?espejo=full` va con los cursores desde cero, que es lo
        // que recuperó los seis retiros fantasma (ver la cabecera del archivo).
        const res = await runCrmSync({ companyId: company.id, full: cursoresDesdeCero });

        // ── DE ACÁ HASTA `results.push` SON EXTRAS, Y `?espejo=full` LOS SALTA ──
        // Un único punto de corte, explícito y a la vista, en vez de un `if`
        // por paso repartido por el cuerpo: un recorte silencioso es
        // indistinguible de "no había nada que hacer".
        //
        // Las variables se declaran acá arriba en null —null es "no se
        // calculó", que NO es lo mismo que 0— para que la respuesta conserve
        // exactamente la misma forma y para que `results.push` siga siendo la
        // ÚNICA lista de extras del archivo. Si mañana se agrega uno, se agrega
        // en un solo lugar y queda saltado acá sin que nadie tenga que
        // acordarse.
        let paypros: PayprosFromCrmResult | null = null;
        const payprosErrors: string[] = [];
        let payprosWithdrawals: PayprosWithdrawalsFromCrmResult | null = null;
        let mt5: Mt5SyncResult | null = null;
        const mt5Errors: string[] = [];
        let allUsers: AllUsersResult | null = null;
        let aggregates: AggregatesResult | null = null;
        const orionErrors: string[] = [];
        let exposure: ExposureResult | null = null;
        const expErrors: string[] = [];
        let dailyPnl: CrmDailyPnlSyncResult | null = null;
        const pnlErrors: string[] = [];
        let walletSources: WalletSourcesResult | null = null;
        let monthlyTotals: CrmMonthlyTotalsResult | null = null;
        let ibProduction: IbProductionResult | null = null;
        let behavior: BehaviorResult | null = null;
        let tradingAccounts: TradingAccountsResult | null = null;
        const extraErrors: string[] = [];

        if (!soloEspejo) {
          // Los depósitos de Pay-Pros salen de acá y no del webhook: la URL que
          // se registró con Pay-Pros es la del CRM, no la nuestra, así que el
          // receptor nunca recibió un evento. Va DESPUÉS del sync porque lee del
          // espejo que el sync acaba de refrescar.
          //
          // Que falle no puede tumbar la sincronización: el espejo ya quedó bien
          // y es lo que alimenta la revisión de retiros. Se anota y se sigue.
          try {
            paypros = await syncPayprosDepositsFromCrm(admin, company.id);
            if (paypros.warnings.length > 0) {
              console.warn(`[cron/sync-crm] paypros ${company.id}:`, paypros.warnings.join(' | '));
            }
          } catch (err) {
            payprosErrors.push(`paypros: ${err instanceof Error ? err.message : 'unknown'}`);
          }

          // Los RETIROS de Pay-Pros (Kevin, 2026-08-31). Misma fuente y mismo
          // motivo que los depósitos de arriba: el webhook nunca recibió un
          // evento, y el espejo del CRM sí los tiene (al 2026-08-31: 6 aprobados
          // por US$ 2.617,62, processor 'PAYPROS_SPEI').
          //
          // En su PROPIO try/catch, y no dentro del de arriba, a propósito: si
          // los depósitos fallan, los retiros igual se asientan. Juntarlos haría
          // que un error en una punta dejara la otra sin actualizar y el canal
          // quedaría con entradas y sin salidas — un Net Deposit inflado, que es
          // peor que no tener ninguno de los dos.
          try {
            payprosWithdrawals = await syncPayprosWithdrawalsFromCrm(admin, company.id);
            if (payprosWithdrawals.warnings.length > 0) {
              console.warn(
                `[cron/sync-crm] paypros-retiros ${company.id}:`,
                payprosWithdrawals.warnings.join(' | '),
              );
            }
          } catch (err) {
            payprosErrors.push(`paypros-retiros: ${err instanceof Error ? err.message : 'unknown'}`);
          }

          // ── Actividad de trading (MT5) ────────────────────────────────────
          // Sólo para los clientes con retiro pendiente o reciente: ahí es donde
          // la señal se usa, y mantiene el costo sobre la base del broker en
          // decenas de cuentas en vez de 26.422.
          //
          // Va al final y aislado por la misma razón que Pay-Pros: si la base
          // del broker no responde, el espejo del CRM ya quedó bien y la
          // revisión de retiros sigue funcionando sin esta señal.
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

          // ── El cierre diario de PNL, tal como lo da el CRM ────────────────
          // Va en TODAS las corridas, incluida la rápida, y con una VENTANA de
          // días en vez de un día. Las dos decisiones tienen la misma causa: el
          // job de Orion que llena `pnl_daily` va media hora detrás del reloj
          // (medido el 2026-08-31: lastRunAt 07:00:04, lastWindowTo 06:30:03),
          // así que el cierre de un día termina de asentarse DESPUÉS de la
          // medianoche. Reescribir hoy y ayer cada 15 minutos deja el día en
          // curso en vivo y cierra el anterior solo; la corrida completa mira
          // siete días y así tapa el hueco de una corrida que falló y recoge lo
          // que Orion cambió hacia atrás (purga documentos de cuentas
          // bloqueadas a `pnl_daily_purged`).
          //
          // Cuesta poco y por eso puede ir en la corrida rápida: medido contra
          // producción el 2026-08-31, la ventana de 2 días son 1.933 documentos
          // y 1.210 cuentas en 2.176 ms; la de 7 días queda por debajo de 2,7 s.
          // Al lado de los ~8 s que ya paga la exposición en la misma corrida,
          // no mueve la aguja.
          //
          // Se puede pedir un rango a mano para el backfill histórico:
          //   ?pnl_from=2025-10-01&pnl_to=2026-08-31
          // La serie empieza el 2025-10-02 y el histórico ENTERO (212.929
          // documentos, 331 días) tarda 6.897 ms: entra en una sola llamada
          // dentro de los 300 s de esta ruta, sin paginar.
          //
          // Aislado como los demás: si Orion no responde, el espejo del CRM ya
          // quedó bien y la revisión de retiros sigue funcionando.
          try {
            const ventana =
              pnlFrom && pnlTo
                ? { from: pnlFrom, to: pnlTo }
                : defaultWindow(modoCompleto ? CRM_PNL_WINDOW_FULL_DAYS : CRM_PNL_WINDOW_FAST_DAYS);
            dailyPnl = await syncCrmDailyPnl(admin, company.id, ventana);
            for (const w of dailyPnl.warnings) {
              console.warn(`[cron/sync-crm] pnl diario ${company.id}: ${w}`);
            }
            // La misma corrida escribe el desglose por persona (migración 122).
            // Se avisa SÓLO si hay dinero sin dueño: si esa fila crece, el
            // cruce cuenta→usuario se está rompiendo, y una exclusión
            // silenciosa es indistinguible de un cruce roto. Cuando es cero no
            // se loguea nada — un aviso que sale siempre deja de leerse.
            if (dailyPnl.ownerlessAccounts > 0) {
              console.warn(
                `[cron/sync-crm] pnl por usuario ${company.id}: ${dailyPnl.ownerlessAccounts} cuenta(s) con factor conocido pero SIN userId en tradingaccounts. Su dinero (${dailyPnl.ownerlessPnlUsd} USD en ${dailyPnl.ownerlessRows} día(s)) quedó en la fila '(sin-dueño)': contado, no silenciado.`,
              );
            }
          } catch (err) {
            pnlErrors.push(`pnl diario: ${err instanceof Error ? err.message : 'unknown'}`);
          }

          // ── Origen del dinero y comportamiento de trading ─────────────────
          // Los dos alimentan el score y la ficha del retiro. Van con el modo
          // COMPLETO: el origen del dinero recorre wallettransfers entera y el
          // comportamiento paga ir a la fila en una tabla de 68M — ninguno de
          // los dos cambia lo suficiente en 15 minutos para justificar ese costo.
          if (modoCompleto) {
            // La lista de cuentas del CRM decide qué cuenta entra a las cifras de
            // PNL y cuál es de prueba. Va con el modo completo: sólo cambia
            // cuando alguien abre una cuenta, y una cuenta nueva se ve excluida
            // (y CONTADA como excluida) hasta la siguiente corrida completa.
            try {
              tradingAccounts = await syncTradingAccounts(admin, company.id);
              for (const w of tradingAccounts.warnings) {
                console.warn(`[cron/sync-crm] cuentas ${company.id}: ${w}`);
              }
            } catch (err) {
              extraErrors.push(`cuentas: ${err instanceof Error ? err.message : 'unknown'}`);
            }
            try {
              walletSources = await syncWalletSources(admin, company.id);
              for (const w of walletSources.warnings) {
                console.warn(`[cron/sync-crm] fuentes ${company.id}: ${w}`);
              }
            } catch (err) {
              extraErrors.push(`fuentes: ${err instanceof Error ? err.message : 'unknown'}`);
            }
            // ── Totales mensuales del CRM (migración 100) ──────────────────
            // P2P, ventas de prop firm y retiros de prop firm aprobados, mes a
            // mes. Va con el modo COMPLETO y recalcula la serie entera: son
            // cuatro consultas de menos de un segundo sobre colecciones de
            // miles de documentos, y un cursor sólo agregaría el bug de dejar
            // contada para siempre una transferencia que después se rechazó.
            //
            // NO escribe en p2p_transfers ni en prop_firm_sales: lo cargado a
            // mano no se toca. La pantalla muestra las dos columnas al lado.
            try {
              monthlyTotals = await syncCrmMonthlyTotals(admin, company.id);
              for (const w of monthlyTotals.warnings) {
                console.warn(`[cron/sync-crm] totales mensuales ${company.id}: ${w}`);
              }
            } catch (err) {
              extraErrors.push(`totales mensuales: ${err instanceof Error ? err.message : 'unknown'}`);
            }
            // ── Produccion IB por estructura (migracion 098) ──────────────
            // Va con el modo COMPLETO y no cada 15 minutos por dos razones
            // medidas: `ib_reward_daily` son 37.146 documentos que se recorren
            // enteros, y el desglose por simbolo entra por el indice
            // {ibUserId, dealTime} de `ibrewards` un IB a la vez porque un
            // barrido por fecha sobre sus 11.829.132 documentos se pasa de los
            // 15 s del lector de Orion.
            //
            // LO QUE NO SE ESPEJA HOY SE PIERDE: el broker purga `ibrewards` a
            // los quince dias, asi que este es el unico momento en que el
            // desglose forex/sinteticos de un dia se puede capturar. Si esta
            // llamada deja de correr, la pantalla no muestra ceros: muestra
            // "sin dato", que es lo correcto y lo visible.
            try {
              ibProduction = await syncIbProduction(admin, company.id);
              for (const w of ibProduction.warnings) {
                console.warn(`[cron/sync-crm] produccion ib ${company.id}: ${w}`);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'unknown';
              if (!/no configurad|not configured|sin credencial/i.test(msg)) {
                extraErrors.push(`produccion ib: ${msg}`);
              }
            }
            try {
              const cuentas = await accountsNeedingBehavior(admin, company.id);
              if (cuentas.length > 0) {
                behavior = await syncTradingBehavior(admin, company.id, cuentas);
                for (const w of behavior.warnings) {
                  console.warn(`[cron/sync-crm] comportamiento ${company.id}: ${w}`);
                }
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'unknown';
              if (!/no configurad|not configured|sin credencial/i.test(msg)) {
                extraErrors.push(`comportamiento: ${msg}`);
              }
            }
          }
        }

        results.push({
          ...res,
          companyName: company.name,
          paypros,
          payprosWithdrawals,
          mt5,
          exposure,
          walletSources,
          monthlyTotals,
          ibProduction,
          behavior,
          tradingAccounts,
          dailyPnl,
          allUsers,
          aggregates,
          errors: [
            ...res.errors, ...payprosErrors, ...mt5Errors,
            ...orionErrors, ...expErrors, ...pnlErrors, ...extraErrors,
          ],
        });
      } catch (err) {
        // Una empresa que revienta no puede cortar a las demás.
        const msg = err instanceof Error ? err.message : 'unknown';
        console.error(`[cron/sync-crm] ${company.id} falló:`, msg);
        results.push({
          companyId: company.id,
          companyName: company.name,
          ranAt,
          full: cursoresDesdeCero,
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
      // Tres modos, un solo campo: que el log diga cuál corrió. Un re-barrido
      // del espejo firmado como 'rapido' sería indistinguible de la corrida de
      // cada 15 minutos, y ahí ya no se puede auditar si el cron diario existe.
      modo: soloEspejo ? 'espejo' : modoCompleto ? 'completo' : 'rapido',
      full: cursoresDesdeCero,
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
