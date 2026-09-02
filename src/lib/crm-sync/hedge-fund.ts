// ─────────────────────────────────────────────────────────────────────────────
// El espejo del HEDGE FUND: Orion (Mongo) → las nueve tablas `crm_hf_*`
// (migración 125).
//
// ── POR QUÉ ES COMPLETO Y NO INCREMENTAL ───────────────────────────────────
// El resto de este directorio usa un cursor por `updatedAt` con solape de 48 h.
// Acá NO, y es deliberado:
//
//   · EL VOLUMEN NO LO JUSTIFICA. Censado el 2026-09-02 en las dos empresas:
//     AP Markets 7 fondos, 22 inversiones, 23 comisiones, 2 asientos de libro,
//     1 payout y 20 certificados; Vex Pro 5 fondos y 1 inversión. Son tres
//     cifras en total. Un barrido completo cuesta lo mismo que el filtro.
//
//   · EL CURSOR YA NOS COSTÓ DINERO. Entre el 2026-08-31 y el 2026-09-01, SEIS
//     retiros de agosto —US$ 9.536,98— nunca llegaron a `crm_withdrawals` pese
//     a que el sync incremental corrió cada 15 minutos y sus `updatedAt` eran
//     normales. Un `?full=1` los recuperó a los seis. La sospecha es que un
//     `find()` sin `sort` sobre una colección viva puede saltarse documentos
//     entre batches. Con volúmenes de tres cifras no hay ninguna razón para
//     exponerse a eso: ver la cabecera de `src/app/api/cron/sync-crm/route.ts`.
//
//   · UN ESTADO CAMBIA SIN MOVER LA FECHA DE NEGOCIO. Una inversión pasa de
//     ACTIVE a TERMINATED sin que su `startDate` se mueva. Filtrar por fecha
//     de negocio dejaría el cambio afuera, que es justo lo que hay que ver.
//
// ── QUÉ PASA CON LO QUE DESAPARECE DEL CRM ─────────────────────────────────
// Nada se borra. Cada fila lleva `synced_at` = la corrida que la vio EN EL CRM,
// y al terminar se CUENTAN las filas que quedaron atrás (`unseen`). Una
// desaparición silenciosa es indistinguible de un cruce roto (§1.2). El
// histórico de un fondo terminado sigue valiendo aunque Orion lo purgue.
//
// ── LOS DATOS DE PRUEBA SE ESPEJAN, PERO NO CUENTAN ────────────────────────
// El fondo `qa-tst` y el usuario "Dev Sup" se guardan igual. Es la regla G7 del
// repo: *excluir las demo de las cifras, PERO espejarlas marcadas, para poder
// auditar la exclusión*. Quien filtra son los endpoints
// (`src/app/api/admin/hedge-fund/*`), con la lista canónica de
// `src/lib/hedge-fund/test-data.ts`, y las pantallas muestran «N excluidos
// (pruebas)». Acá se CUENTAN para que la corrida también lo diga.
//
// ── EL VIGILANTE DE LA CONFIGURACIÓN DE COMISIONES ─────────────────────────
// Kevin, 2026-09-02: los porcentajes de AP Markets quedaron en 0/0/0 A
// PROPÓSITO —fue un error que ya se corrigió— y hay que poder contestar dentro
// de tres meses si alguien los volvió a tocar. Cada corrida compara el
// FINGERPRINT (los niveles ordenados, sin `updatedAt`: guardar la pantalla sin
// cambiar nada no es un cambio) contra el último snapshot guardado. Si difiere:
// snapshot nuevo + `audit_logs` + notificación. Si es igual: sólo se pisa
// `last_seen_at`, así una corrida cada 15 minutos no deja 96 filas por día.
//
// ── LO QUE SE DESCARTÓ ─────────────────────────────────────────────────────
//   · `users.totalAmountByHedge` — está en CERO para todos los usuarios de las
//     dos empresas. Es la fuente que parecía obvia y devuelve un capital bajo
//     gestión de cero con cara de dato bueno.
//   · Sync incremental — ver arriba.
//   · Integrar el capital a la cadena de distribución — Kevin lo dejó por
//     aparte; este archivo no toca `distribution*.ts` ni resumen-general.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrionMongoSession } from '@/lib/api-integrations/orion-mongo/client';
import { notify, dailyKey } from '@/lib/notifications/notify';
import {
  toCertificateRow,
  toCommissionConfig,
  toCommissionRow,
  toFundRow,
  toInvestmentRow,
  toLedgerRow,
  toMonthlyReturnRow,
  toPayoutRow,
  toWithdrawalRequestRow,
  commissionConfigChanged,
} from '@/lib/hedge-fund/normalize';
import { exclusionReason } from '@/lib/hedge-fund/test-data';
import type {
  HedgeFundSyncResult,
  HfCommissionConfig,
  HfTableStats,
  MongoDoc,
} from '@/lib/hedge-fund/types';

/**
 * Techo de documentos por colección. Con 22 inversiones sobra por tres órdenes
 * de magnitud; existe para que un día raro no se lleve la memoria de la
 * función. Si se toca, se AVISA: un recorte silencioso es indistinguible de
 * «no hay más» (§1.2), así que llegar al techo mete un warning en el resultado.
 */
const MAX_DOCS = 50_000;

/** Filas por upsert. Mismo criterio que el resto del directorio. */
const UPSERT_CHUNK = 500;

/** Módulo con el que se firman los `audit_logs` de este sync. */
export const HEDGE_FUND_AUDIT_MODULE = 'hedge_fund';

/** La acción del audit log cuando el vigilante detecta un cambio. */
export const HEDGE_FUND_CONFIG_CHANGED_ACTION = 'hedge_fund_commission_config_changed';

const EMPTY_STATS: HfTableStats = { fetched: 0, upserted: 0, excluded: 0, unseen: 0 };

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface EspejarOpts<TRow extends object> {
  session: OrionMongoSession;
  admin: SupabaseClient;
  companyId: string;
  ranAt: string;
  collection: string;
  table: string;
  /** Columnas de la PK, en el orden de la migración. */
  onConflict: string;
  map: (doc: MongoDoc) => TRow | null;
  warnings: string[];
}

/**
 * Espeja una colección entera. Devuelve los conteos, incluido cuántas filas de
 * NUESTRA tabla no aparecieron en esta corrida.
 */
async function espejar<TRow extends object>(
  opts: EspejarOpts<TRow>,
): Promise<HfTableStats> {
  const docs = (await opts.session.db
    .collection(opts.collection)
    .find({})
    .limit(MAX_DOCS)
    .toArray()) as unknown as MongoDoc[];

  if (docs.length >= MAX_DOCS) {
    opts.warnings.push(
      `${opts.collection}: se alcanzó el techo de ${MAX_DOCS} documentos. La lista puede estar RECORTADA — subí MAX_DOCS o paginá antes de creerle a estas cifras.`,
    );
  }

  const filas: TRow[] = [];
  const vistas = new Set<string>();
  let excluded = 0;
  let sinLlave = 0;

  for (const doc of docs) {
    const row = opts.map(doc);
    if (!row) {
      // Sin llave natural no hay fila posible: se cuenta y se avisa, nunca se
      // traga en silencio.
      sinLlave++;
      continue;
    }
    // Los de prueba SE ESPEJAN (G7) y se cuentan. Filtrar es tarea de los
    // endpoints, con la lista canónica de test-data.ts.
    if (
      exclusionReason({
        fund_key: (row as { fund_key?: string | null }).fund_key ?? null,
        user_external_id: (row as { user_external_id?: string | null }).user_external_id ?? null,
      })
    ) {
      excluded++;
    }

    // Deduplicación dentro del MISMO payload: dos filas con la misma PK hacen
    // fallar el upsert entero ("ON CONFLICT DO UPDATE cannot affect row a
    // second time") y se perdería el lote completo, no la fila repetida.
    const clave = opts.onConflict
      .split(',')
      .map((c) => String((row as Record<string, unknown>)[c.trim()] ?? ''))
      .join('|');
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    filas.push(row);
  }

  if (sinLlave > 0) {
    opts.warnings.push(
      `${opts.collection}: ${sinLlave} documento(s) SIN llave natural, descartados. No se pueden espejar sin romper la PK.`,
    );
  }

  let upserted = 0;
  for (const parte of chunk(filas, UPSERT_CHUNK)) {
    const { error } = await opts.admin
      .from(opts.table)
      .upsert(parte, { onConflict: opts.onConflict });
    if (error) throw new Error(`${opts.table}: ${error.message}`);
    upserted += parte.length;
  }

  // Lo que el CRM ya no tiene. NO se borra: se cuenta. `company_id` explícito
  // porque con el service role RLS no aplica (§4.2).
  const { count, error: countError } = await opts.admin
    .from(opts.table)
    .select('company_id', { count: 'exact', head: true })
    .eq('company_id', opts.companyId)
    .lt('synced_at', opts.ranAt);
  if (countError) {
    opts.warnings.push(`${opts.table}: no se pudo contar lo no visto (${countError.message}).`);
  }

  return { fetched: docs.length, upserted, excluded, unseen: count ?? 0 };
}

/**
 * El último snapshot guardado de la configuración de comisiones, o `null` si
 * nunca vimos ninguno.
 */
async function ultimoSnapshot(
  admin: SupabaseClient,
  companyId: string,
): Promise<{ id: string; config: HfCommissionConfig } | null> {
  const { data, error } = await admin
    .from('crm_hf_commission_config_snapshots')
    .select('id, fingerprint, direct_levels, recurring_levels, max_levels, source_updated_at, updated_by, raw')
    .eq('company_id', companyId)
    .order('first_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: String(data.id),
    config: {
      fingerprint: String(data.fingerprint),
      directLevels: Array.isArray(data.direct_levels) ? data.direct_levels : [],
      recurringLevels: Array.isArray(data.recurring_levels) ? data.recurring_levels : [],
      maxLevels: data.max_levels === null ? null : Number(data.max_levels),
      sourceUpdatedAt: data.source_updated_at ? String(data.source_updated_at) : null,
      updatedBy: data.updated_by ? String(data.updated_by) : null,
      raw: (data.raw ?? {}) as Record<string, unknown>,
    },
  };
}

/** Texto legible de una config, para el audit log y para el aviso. */
export function describeCommissionConfig(cfg: HfCommissionConfig | null): string {
  if (!cfg) return 'sin configuración previa';
  const niveles = (ls: HfCommissionConfig['directLevels']) =>
    ls.length === 0 ? '—' : ls.map((l) => `N${l.level}=${l.percent}%`).join(' ');
  return `directos [${niveles(cfg.directLevels)}] · recurrentes [${niveles(cfg.recurringLevels)}] · maxLevels ${cfg.maxLevels ?? '—'}`;
}

/**
 * El vigilante. Devuelve el cambio detectado, o `null` si la configuración es
 * la misma de siempre.
 */
async function vigilarConfig(
  session: OrionMongoSession,
  admin: SupabaseClient,
  companyId: string,
  ranAt: string,
  warnings: string[],
): Promise<HedgeFundSyncResult['configChanged']> {
  // Es un singleton: si hubiera más de uno, el CRM tiene un problema y hay que
  // verlo. Se trae el primero y se avisa.
  const docs = (await session.db
    .collection('hedgefundcommissionconfigs')
    .find({})
    .limit(5)
    .toArray()) as unknown as MongoDoc[];

  if (docs.length === 0) {
    // Sin documento no hay nada que vigilar. NO se guarda un snapshot en cero:
    // «no hay configuración» y «la configuración paga 0%» son cosas distintas,
    // y guardarlas iguales haría que la primera aparición real se leyera como
    // un cambio de 0 a X que nadie hizo.
    return null;
  }
  if (docs.length > 1) {
    warnings.push(
      `hedgefundcommissionconfigs: ${docs.length} documentos donde debería haber UNO. Se usó el primero; revisar el CRM.`,
    );
  }

  const nueva = toCommissionConfig(docs[0]);
  const previo = await ultimoSnapshot(admin, companyId);

  if (!commissionConfigChanged(previo?.config ?? null, nueva)) {
    // Misma configuración: sólo se confirma que la seguimos viendo.
    const { error } = await admin
      .from('crm_hf_commission_config_snapshots')
      .update({ last_seen_at: ranAt })
      .eq('id', previo!.id)
      .eq('company_id', companyId);
    if (error) warnings.push(`snapshot de config (last_seen_at): ${error.message}`);
    return null;
  }

  const { error } = await admin.from('crm_hf_commission_config_snapshots').insert({
    company_id: companyId,
    fingerprint: nueva.fingerprint,
    direct_levels: nueva.directLevels,
    recurring_levels: nueva.recurringLevels,
    max_levels: nueva.maxLevels,
    source_updated_at: nueva.sourceUpdatedAt,
    updated_by: nueva.updatedBy,
    raw: nueva.raw,
    first_seen_at: ranAt,
    last_seen_at: ranAt,
  });
  if (error) {
    // Si no se puede guardar el snapshot NO se avisa del cambio: la próxima
    // corrida volvería a "detectarlo" y avisaría otra vez, para siempre.
    warnings.push(`snapshot de config (insert): ${error.message}. No se emitió aviso.`);
    return null;
  }

  return { before: previo?.config ?? null, after: nueva };
}

/**
 * Espeja el hedge fund de una empresa. Se llama DESDE `runCrmSync`, con la
 * sesión de Mongo ya abierta: abrir una segunda conexión al CRM por corrida
 * sería regalarle carga al broker por datos que ya podíamos leer.
 *
 * Cada colección va en su propio `try/catch` (§5.1): que `hedgefundcertificates`
 * falle no puede dejar sin espejar las inversiones, que son el dinero.
 */
export async function syncHedgeFund(
  session: OrionMongoSession,
  admin: SupabaseClient,
  companyId: string,
  ranAt: string,
): Promise<HedgeFundSyncResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const errors: string[] = [];

  const stats: Record<string, HfTableStats> = {
    funds: { ...EMPTY_STATS },
    investments: { ...EMPTY_STATS },
    ledgerEntries: { ...EMPTY_STATS },
    payouts: { ...EMPTY_STATS },
    commissions: { ...EMPTY_STATS },
    withdrawalRequests: { ...EMPTY_STATS },
    monthlyReturns: { ...EMPTY_STATS },
    certificates: { ...EMPTY_STATS },
  };

  const pasos: Array<{
    clave: keyof typeof stats;
    collection: string;
    table: string;
    onConflict: string;
    map: (doc: MongoDoc) => object | null;
  }> = [
    {
      clave: 'funds', collection: 'hedgefunds', table: 'crm_hf_funds',
      onConflict: 'company_id,fund_key',
      map: (d) => toFundRow(d, companyId, ranAt),
    },
    {
      clave: 'investments', collection: 'hedgefundinvestments', table: 'crm_hf_investments',
      onConflict: 'company_id,investment_id',
      map: (d) => toInvestmentRow(d, companyId, ranAt),
    },
    {
      clave: 'ledgerEntries', collection: 'hedgefundledgerentries', table: 'crm_hf_ledger_entries',
      onConflict: 'company_id,entry_id',
      map: (d) => toLedgerRow(d, companyId, ranAt),
    },
    {
      clave: 'payouts', collection: 'hedgefundpayouts', table: 'crm_hf_payouts',
      onConflict: 'company_id,payout_id',
      map: (d) => toPayoutRow(d, companyId, ranAt),
    },
    {
      clave: 'commissions', collection: 'hedgefundcommissions', table: 'crm_hf_commissions',
      onConflict: 'company_id,commission_id',
      map: (d) => toCommissionRow(d, companyId, ranAt),
    },
    {
      clave: 'withdrawalRequests', collection: 'hedgefundwithdrawalrequests',
      table: 'crm_hf_withdrawal_requests', onConflict: 'company_id,request_id',
      map: (d) => toWithdrawalRequestRow(d, companyId, ranAt),
    },
    {
      clave: 'monthlyReturns', collection: 'hedgefundmonthlyreturns',
      table: 'crm_hf_monthly_returns', onConflict: 'company_id,fund_key,ym',
      map: (d) => toMonthlyReturnRow(d, companyId, ranAt),
    },
    {
      clave: 'certificates', collection: 'hedgefundcertificates', table: 'crm_hf_certificates',
      onConflict: 'company_id,certificate_id',
      map: (d) => toCertificateRow(d, companyId, ranAt),
    },
  ];

  for (const paso of pasos) {
    try {
      stats[paso.clave] = await espejar({
        session, admin, companyId, ranAt,
        collection: paso.collection,
        table: paso.table,
        onConflict: paso.onConflict,
        map: paso.map,
        warnings,
      });
    } catch (err) {
      errors.push(`${paso.collection}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let configChanged: HedgeFundSyncResult['configChanged'] = null;
  try {
    configChanged = await vigilarConfig(session, admin, companyId, ranAt, warnings);
  } catch (err) {
    errors.push(`hedgefundcommissionconfigs: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── El rastro del cambio ──────────────────────────────────────────────────
  // Sólo cuando había una configuración ANTERIOR: el primer snapshot es «el
  // módulo se encendió», no «alguien tocó los porcentajes», y avisar de eso
  // enseñaría a ignorar el aviso.
  if (configChanged && configChanged.before) {
    const detalle =
      `Configuración de comisiones del hedge fund MODIFICADA en el CRM. ` +
      `Antes: ${describeCommissionConfig(configChanged.before)}. ` +
      `Ahora: ${describeCommissionConfig(configChanged.after)}.`;
    try {
      const { error } = await admin.from('audit_logs').insert({
        company_id: companyId,
        user_id: null,
        user_name: 'cron',
        action: HEDGE_FUND_CONFIG_CHANGED_ACTION,
        module: HEDGE_FUND_AUDIT_MODULE,
        details: detalle,
      });
      if (error) warnings.push(`audit_logs del cambio de config: ${error.message}`);
    } catch (err) {
      warnings.push(`audit_logs del cambio de config: ${err instanceof Error ? err.message : 'unknown'}`);
    }
    // `notify` nunca tira, pero el dedupe sí importa: sin él, una config
    // cambiada y un snapshot que no se pudo guardar avisarían en cada corrida.
    await notify(admin, {
      companyId,
      type: 'hedge_fund.commission_config_changed',
      params: {
        before: describeCommissionConfig(configChanged.before),
        after: describeCommissionConfig(configChanged.after),
      },
      link: '/hedge-fund',
      dedupeKey: dailyKey(`hf-config:${companyId}:${configChanged.after.fingerprint}`),
    });
    console.warn(`[crm-sync/hedge-fund] ${companyId}: ${detalle}`);
  }

  const excludedTotal = Object.values(stats).reduce((s, t) => s + t.excluded, 0);

  return {
    companyId,
    ranAt,
    funds: stats.funds,
    investments: stats.investments,
    ledgerEntries: stats.ledgerEntries,
    payouts: stats.payouts,
    commissions: stats.commissions,
    withdrawalRequests: stats.withdrawalRequests,
    monthlyReturns: stats.monthlyReturns,
    certificates: stats.certificates,
    configChanged,
    excludedTotal,
    elapsedMs: Date.now() - started,
    warnings,
    errors,
  };
}
