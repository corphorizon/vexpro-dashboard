// ─────────────────────────────────────────────────────────────────────────────
// Espejo de la cola de retiros de prop firm, con su revisión automática.
//
// ── QUÉ REEMPLAZA ──────────────────────────────────────────────────────────
// Hasta hoy el circuito era: alguien se enteraba de que había un retiro, sabía
// qué cuenta era, entraba a MetaTrader, exportaba el historial, lo subía a una
// pantalla y leía cinco reglas. Si nadie se acordaba, no se revisaba.
//
// Ahora llega la solicitud y queda revisada contra el reglamento de SU
// programa, con todas las reglas que se pueden comprobar.
//
// ── POR QUÉ LAS APERTURAS SE CARGAN UNA VEZ ────────────────────────────────
// Detectar copia entre cuentas necesita las aperturas de TODAS las cuentas de
// prop firm del período —42.914 en 120 días—, no sólo las de la cuenta que se
// revisa: la sincronía es una relación entre dos.
//
// `reviewWithdrawal` las carga por su cuenta, que está bien para revisar una
// suelta pero es un desperdicio en lote: medido, cada retiro tardaba entre 10
// y 16 segundos y casi todo era volver a traer las mismas 42.914 filas. Acá se
// cargan UNA vez y se reparten.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { withOrionMongo } from '@/lib/api-integrations/orion-mongo/client';
import { loadCycleFromMt5, evaluateWithdrawal, type PropfirmWithdrawal } from '@/lib/risk/propfirm-auto';
import { loadHighImpact } from '@/lib/risk/economic-calendar';
import { loadAperturas, findSynchronizedPairs, loadSharedIpFacts, type SharedIpFacts } from '@/lib/risk/copy-detection';

/** Ventana del espejo. Los retiros viejos no cambian y no hace falta releerlos. */
const DIAS = 180;

/** Los ÚNICOS campos que se piden de Orion. La proyección es la aduana. */
export const ORION_WITHDRAWAL_FIELDS = [
  'withdrawId', 'loginAccount', 'username', 'userEmail', 'propFirmName',
  'requestedAmount', 'requestedDate', 'status', 'profitSharePercent',
  'authorizedDate', 'authorizedBy',
] as const;

export interface QueueSyncResult {
  mirrored: number;
  reviewed: number;
  failed: number;
  elapsedMs: number;
  warnings: string[];
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const fecha = (v: unknown): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export async function syncPropfirmQueue(
  admin: SupabaseClient,
  companyId: string,
): Promise<QueueSyncResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const desdeVentana = new Date(Date.now() - DIAS * 86_400_000);

  const { retiros, tamanos } = await withOrionMongo(companyId, async ({ db }) => {
    const retiros = await db
      .collection('withdrawalpropfirms')
      .find(
        { requestedDate: { $gte: desdeVentana } },
        { projection: Object.fromEntries(ORION_WITHDRAWAL_FIELDS.map((f) => [f, 1])) as Record<string, 1> },
      )
      .toArray();
    // El capital del programa, para poder dar el drawdown en porcentaje.
    const tamanos = await db
      .collection('userpropfirms')
      .find({}, { projection: { loginAccount: 1, accountBalance: 1 } })
      .toArray();
    return { retiros, tamanos };
  });

  const size = new Map<string, number | null>(
    tamanos.map((u) => [String(u.loginAccount), num(u.accountBalance)]),
  );

  // ── 1. Espejar todo ──────────────────────────────────────────────────────
  const filas = retiros.map((r) => ({
    company_id: companyId,
    withdraw_id: String(r.withdrawId),
    login: num(r.loginAccount),
    username: r.username ? String(r.username) : null,
    user_email: r.userEmail ? String(r.userEmail).toLowerCase() : null,
    program_name: r.propFirmName ? String(r.propFirmName) : null,
    requested_amount: num(r.requestedAmount),
    requested_date: fecha(r.requestedDate),
    status: r.status ? String(r.status) : null,
    profit_share_pct: num(r.profitSharePercent),
    authorized_date: fecha(r.authorizedDate),
    authorized_by: r.authorizedBy ? String(r.authorizedBy) : null,
    synced_at: new Date().toISOString(),
  }));

  for (let i = 0; i < filas.length; i += 500) {
    const { error } = await admin
      .from('propfirm_withdrawal_queue')
      .upsert(filas.slice(i, i + 500), { onConflict: 'company_id,withdraw_id' });
    if (error) throw new Error(`propfirm_withdrawal_queue: ${error.message}`);
  }

  // ── 2. Revisar los PENDIENTES ───────────────────────────────────────────
  // Sólo los pendientes: sobre un retiro ya aprobado o rechazado no hay nada
  // que decidir, y revisarlos todos en cada corrida gastaría minutos para
  // reescribir el mismo veredicto.
  const pendientes = retiros.filter((r) => String(r.status) === 'PENDING');
  if (pendientes.length === 0) {
    return { mirrored: filas.length, reviewed: 0, failed: 0, elapsedMs: Date.now() - started, warnings };
  }

  // Las aperturas de TODAS las cuentas, una sola vez. Ver la cabecera.
  const aperturas = await loadAperturas(companyId, new Date(Date.now() - 120 * 86_400_000));
  const paresTodos = findSynchronizedPairs(aperturas);

  // ── La IP, como DATO ────────────────────────────────────────────────────
  // Se resuelve para todos los pendientes de una vez, en UNA conexión al MySQL
  // del broker. No entra en el veredicto: viaja en `review_facts`, que es lo
  // que mira una persona. Ver la cabecera de copy-detection.ts para por qué no
  // puede ser una regla (hay una IP con 164 cuentas).
  //
  // Y va en try/catch: quedarse sin el dato de la IP no puede impedir que se
  // revise el reglamento, que es lo que decide.
  const loginsPendientes = pendientes.map((p) => num(p.loginAccount) ?? 0).filter((l) => l > 0);
  let ipPorLogin = new Map<number, SharedIpFacts>();
  try {
    ipPorLogin = await loadSharedIpFacts(companyId, loginsPendientes);
  } catch (err) {
    warnings.push(`No se pudo leer la IP de las cuentas: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── ¿Hay informe oficial del CRM para esa cuenta? ───────────────────────
  // `propfirm_audit_reports` guarda el HTML que genera Orion, pero SÓLO cuando
  // una cuenta se descalifica por pérdida (medido el 2026-08-27: 18 informes,
  // todos con motivo DAILY_LOSS u OVERALL_LOSS, ninguno de los 3 logins con
  // retiro pendiente). Por eso el informe que el revisor abre lo generamos
  // nosotros desde MT5 y éste se ofrece ADEMÁS, cuando existe.
  //
  // Se guarda sólo la fecha: el HTML pesa ~220 KB por informe y no tiene por
  // qué vivir en Postgres cuando la ruta puede traerlo de Orion al abrirlo.
  const informeOrion = new Map<number, string>();
  try {
    await withOrionMongo(companyId, async ({ db }) => {
      const docs = await db
        .collection('propfirm_audit_reports')
        // `login` está guardado como TEXTO en Orion, no como número.
        .find(
          { login: { $in: loginsPendientes.map((l) => String(l)) } },
          { projection: { login: 1, createdAt: 1 } },
        )
        .sort({ createdAt: -1 })
        .toArray();
      for (const d of docs) {
        const l = Number(d.login);
        if (!informeOrion.has(l)) informeOrion.set(l, fecha(d.createdAt) ?? '');
      }
      return null;
    });
  } catch (err) {
    warnings.push(`No se pudo consultar los informes del CRM: ${err instanceof Error ? err.message : String(err)}`);
  }

  let reviewed = 0;
  let failed = 0;
  for (const p of pendientes) {
    const w: PropfirmWithdrawal = {
      withdrawId: String(p.withdrawId),
      login: num(p.loginAccount) ?? 0,
      username: p.username ? String(p.username) : null,
      userEmail: p.userEmail ? String(p.userEmail) : null,
      programName: p.propFirmName ? String(p.propFirmName) : null,
      requestedAmount: num(p.requestedAmount) ?? 0,
      requestedDate: new Date(String(p.requestedDate)),
    };

    try {
      const cycle = await loadCycleFromMt5(companyId, w.login);
      const desde = cycle.startedAt ?? new Date(Date.now() - 120 * 86_400_000);
      const noticias = await loadHighImpact(admin, desde, w.requestedDate);
      const sincronizadas = paresTodos
        .filter((x) => x.loginA === w.login || x.loginB === w.login)
        .map((x) => ({
          otroLogin: x.loginA === w.login ? x.loginB : x.loginA,
          cobertura: x.cobertura,
          coincidencias: x.coincidencias,
          retrasoMedianoSeg: x.retrasoMedianoSeg,
        }));

      const r = evaluateWithdrawal(w, cycle, size.get(String(w.login)) ?? null, noticias, sincronizadas);

      const { error } = await admin
        .from('propfirm_withdrawal_queue')
        .update({
          reviewed_at: new Date().toISOString(),
          review_outcome: r.outcome,
          review_violations: r.violations,
          review_unverifiable: r.unverifiable,
          review_checks: r.checks,
          // Los datos de la IP y la existencia del informe del CRM se suman a
          // `facts` acá y no dentro de `evaluateWithdrawal`: ese motor decide
          // el veredicto y estos dos no lo tocan.
          review_facts: {
            ...r.facts,
            ...(ipPorLogin.get(w.login) ?? { ip: null, sharedIpTotal: 0, sharedIpAccounts: [], sharedIpMassive: false }),
            orionReportAt: informeOrion.get(w.login) ?? null,
          },
          review_cycle: r.cycle,
          review_error: null,
        })
        .eq('company_id', companyId)
        .eq('withdraw_id', w.withdrawId);
      if (error) throw new Error(error.message);

      reviewed += 1;
      for (const x of r.warnings) warnings.push(`${w.username ?? w.login}: ${x}`);
    } catch (err) {
      // Un retiro que falla no puede impedir la revisión de los demás, y el
      // error se GUARDA: una fila sin revisión y sin motivo se lee como "no
      // hacía falta revisarla".
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      await admin
        .from('propfirm_withdrawal_queue')
        .update({ reviewed_at: new Date().toISOString(), review_outcome: null, review_error: message })
        .eq('company_id', companyId)
        .eq('withdraw_id', w.withdrawId);
      warnings.push(`No se pudo revisar el retiro de ${w.username ?? w.login}: ${message}`);
    }
  }

  return { mirrored: filas.length, reviewed, failed, elapsedMs: Date.now() - started, warnings };
}
