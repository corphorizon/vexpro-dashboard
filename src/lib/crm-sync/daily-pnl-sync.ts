// ─────────────────────────────────────────────────────────────────────────────
// El espejo del PNL diario del CRM: Mongo (Orion) → `crm_daily_pnl`.
//
// El PORQUÉ de cada número —de dónde sale, por qué se divide el centavo, qué
// entra y qué no, el signo— está en `daily-pnl.ts`, junto a las funciones
// puras que lo calculan. Acá está sólo lo que toca la red, que es lo que no se
// puede testear sin Mongo ni sin Supabase.
//
// ── LA VENTANA, Y POR QUÉ NO ES "AYER" ─────────────────────────────────────
// El job de Orion que llena `pnl_daily` corre cada 30 minutos y va detrás del
// reloj (medido el 2026-08-31: `lastRunAt` 07:00:04 con `lastWindowTo`
// 06:30:03). Tomar el cierre del día D a las 00:00 de D+1 dejaría afuera la
// última media hora del día, en silencio.
//
// Por eso se reescribe una VENTANA de días y no un día:
//   · cada corrida rápida (15 min) → HOY y AYER: el de hoy se ve en vivo y el
//     de ayer termina de cerrarse solo cuando Orion lo termina.
//   · cada corrida completa (4 h)  → los últimos 7 días: repara el hueco de
//     una corrida que falló y recoge los cambios hacia atrás (Orion purga
//     documentos de cuentas bloqueadas — `pnl_daily_purged`, 11.331
//     documentos, el último lote el 2026-08-31 01:22).
//
// Reescribir es idempotente y barato: `upsert` por (empresa, día).
//
// ── EL COSTO, MEDIDO ───────────────────────────────────────────────────────
// Contra producción el 2026-08-31 (Vex Pro), ida y vuelta completa (los
// documentos del día MÁS resolver las cuentas y sus grupos):
//
//   ventana de 2 días      1.933 docs ·  1.210 logins  →   2.176 ms
//   mes entero            42.028 docs ·  4.597 logins  →   2.664 ms
//   histórico completo   212.929 docs · 15.127 logins  →   6.897 ms
//
// Dos cosas se leen de esa tabla. La primera: el costo NO lo manda el número
// de documentos, lo manda la ida a Mongo — de 2 días a un año hay 110 veces
// más documentos y 3 veces más tiempo. La segunda: el histórico ENTERO entra
// cómodo en una sola llamada dentro de los 300 s del cron, así que el backfill
// no necesita paginarse.
//
// Las cuentas se piden sólo para los logins de la ventana (`$in` por lotes) y
// no enteras: `tradingaccounts` son 32.406 documentos y en la corrida rápida
// hacen falta 1.210.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { withOrionMongo } from '@/lib/api-integrations/orion-mongo/client';
import {
  aggregateCrmDailyPnl,
  utcDaysBetween,
  type CrmPnlAccount,
  type CrmPnlDailyDoc,
} from './daily-pnl';

/** Días que reescribe cada modo. Ver la cabecera. */
export const CRM_PNL_WINDOW_FAST_DAYS = 2;
export const CRM_PNL_WINDOW_FULL_DAYS = 7;

/**
 * Logins por consulta `$in`. Mongo no tiene el límite de URL de PostgREST,
 * pero un `$in` de decenas de miles arma un plan enorme; 5.000 mantiene la
 * ventana rápida en UNA sola consulta y el backfill en pocas decenas.
 */
const LOTE_LOGINS = 5_000;

export interface CrmDailyPnlSyncResult {
  from: string;
  to: string;
  daysWritten: number;
  /** Días del rango que Orion no tiene. NO se escriben en cero: no hay dato. */
  daysWithoutData: string[];
  docsRead: number;
  accountsResolved: number;
  elapsedMs: number;
  warnings: string[];
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** `YYYY-MM-DD` UTC de hoy. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** La ventana por defecto de un modo: `days` días terminando hoy. */
export function defaultWindow(days: number, now: Date = new Date()): { from: string; to: string } {
  const to = todayUtc(now);
  const from = new Date(Date.parse(`${to}T00:00:00.000Z`) - (days - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { from, to };
}

/**
 * Recalcula y guarda el cierre diario del CRM para el rango pedido.
 *
 * Un día sin documentos en Orion NO escribe fila: "no hay dato" y "cerró en
 * cero" son cosas distintas y la pantalla las dibuja distinto.
 */
export async function syncCrmDailyPnl(
  admin: SupabaseClient,
  companyId: string,
  range: { from: string; to: string },
): Promise<CrmDailyPnlSyncResult> {
  const started = Date.now();
  const { from, to } = range;

  if (utcDaysBetween(from, to).length === 0) {
    throw new Error(`crm_daily_pnl: rango inválido ${from}..${to}`);
  }

  const { docs, cuentas } = await withOrionMongo(companyId, async ({ db }) => {
    // El día es un STRING `YYYY-MM-DD` en el documento (verificado el
    // 2026-08-31: `pnl_daily.day = '2026-08-31'` junto a un `dayDate` que es
    // un BSON date). Se compara como texto a propósito: el orden lexicográfico
    // de `YYYY-MM-DD` es el cronológico, y comparar un string contra un Date
    // en Mongo devuelve CERO documentos sin ningún error.
    const docs = (await db
      .collection('pnl_daily')
      .find(
        { day: { $gte: from, $lte: to } },
        { projection: { _id: 0, day: 1, login: 1, deals: 1, lots: 1, rawPnl: 1 } },
      )
      .toArray()) as unknown as CrmPnlDailyDoc[];

    const logins = [...new Set(docs.map((d) => String(d.login ?? '')))].filter((l) => l !== '');

    // `servergroups` son 221 documentos: se traen enteros.
    const grupos = await db
      .collection('servergroups')
      .find({}, { projection: { _id: 0, serverGroupId: 1, metaTraderGroupId: 1, centsFactor: 1 } })
      .toArray();
    const porGrupo = new Map<string, { mt: string | null; cf: number }>();
    for (const g of grupos as Array<Record<string, unknown>>) {
      const id = typeof g.serverGroupId === 'string' ? g.serverGroupId : null;
      if (!id) continue;
      porGrupo.set(id, {
        mt: typeof g.metaTraderGroupId === 'string' ? g.metaTraderGroupId : null,
        // Un `centsFactor` ausente o raro NO se asume 1: se deja en 0 para que
        // la cuenta caiga en "sin factor conocido" y su dinero se cuente como
        // excluido en vez de entrar cien veces inflado.
        cf: typeof g.centsFactor === 'number' && g.centsFactor > 0 ? g.centsFactor : 0,
      });
    }

    const cuentas = new Map<string, CrmPnlAccount>();
    for (const lote of chunk(logins, LOTE_LOGINS)) {
      const accs = await db
        .collection('tradingaccounts')
        .find({ accountId: { $in: lote } }, { projection: { _id: 0, accountId: 1, groupId: 1 } })
        .toArray();
      for (const a of accs as Array<Record<string, unknown>>) {
        const login = a.accountId === null || a.accountId === undefined ? '' : String(a.accountId);
        const gid = typeof a.groupId === 'string' ? a.groupId : null;
        const g = gid ? porGrupo.get(gid) : undefined;
        // Sin grupo o sin factor conocido, la cuenta NO entra al dinero.
        if (!g || g.cf <= 0) continue;
        cuentas.set(login, { centsFactor: g.cf, metaTraderGroup: g.mt });
      }
    }

    return { docs, cuentas };
  });

  const { days, warnings } = aggregateCrmDailyPnl(docs, cuentas);

  const now = new Date().toISOString();
  const filas = days.map((d) => ({
    company_id: companyId,
    utc_day: d.utcDay,
    pnl_usd: d.pnlUsd,
    volume_lots: d.volumeLots,
    deals_count: d.dealsCount,
    accounts_count: d.accountsCount,
    unmatched_accounts: d.unmatchedAccounts,
    unmatched_deals: d.unmatchedDeals,
    unmatched_raw_pnl: d.unmatchedRawPnl,
    detail: { by_category: d.byCategory },
    source: 'api' as const,
    computed_at: now,
  }));

  for (const parte of chunk(filas, 500)) {
    const { error } = await admin
      .from('crm_daily_pnl')
      .upsert(parte, { onConflict: 'company_id,utc_day' });
    if (error) throw new Error(`crm_daily_pnl: ${error.message}`);
  }

  const conDatos = new Set(days.map((d) => d.utcDay));
  // El día de HOY está en curso: no tener actividad todavía no es un hueco.
  const hoy = todayUtc();
  const daysWithoutData = utcDaysBetween(from, to).filter((d) => d !== hoy && !conDatos.has(d));
  // Se avisa del hueco sólo si la empresa TIENE la serie. Una que no la tenga
  // (otro bróker, otro CRM) no puede llenar los logs con "faltan 7 días" cada
  // 15 minutos para siempre: eso no es un hueco, es un "no aplica". Mismo
  // criterio que crm_monthly_totals con las métricas de prop firm.
  if (daysWithoutData.length > 0 && days.length > 0) {
    warnings.push(
      `Sin datos de PNL en el CRM para ${daysWithoutData.length} día(s): ${daysWithoutData.join(', ')}. Quedan como hueco, NO como cero.`,
    );
  }

  return {
    from,
    to,
    daysWritten: filas.length,
    daysWithoutData,
    docsRead: docs.length,
    accountsResolved: cuentas.size,
    elapsedMs: Date.now() - started,
    warnings,
  };
}
