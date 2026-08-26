// ─────────────────────────────────────────────────────────────────────────────
// PNL abierto y cerrado del día, por categoría de cuenta.
//
// ── LA TRAMPA DE LAS COLUMNAS DE TIEMPO ────────────────────────────────────
// `mt5_deals` tiene TRES columnas de tiempo y sólo una sirve:
//
//     Time       DATETIME   correcta, pero SIN índice → 31 s por consulta
//     Timestamp  BIGINT     NO es epoch: es FILETIME (100 ns desde 1601).
//                           `Timestamp >= UNIX_TIMESTAMP(...)` es verdadero
//                           para TODA la tabla, así que "hoy" devolvía los
//                           68 millones de deals con cara de dato bueno.
//     TimeMsc    DATETIME(6) indexada, y el nombre miente: no son
//                           milisegundos. Compararla contra un número devuelve
//                           CERO filas en 28 s.
//
// Se usa `TimeMsc` comparada contra fechas. El índice
// `idx_deals_entry_timemsc_login (Entry, TimeMsc, Login)` cubre exactamente
// este filtro: medido, un día cerrado tarda 748 ms recién empezado y 26 s
// completo.
//
// ── POR QUÉ UTC SIN CONVERTIR ──────────────────────────────────────────────
// El servidor MySQL del broker corre en UTC: `NOW()` y `UTC_TIMESTAMP()`
// devuelven lo mismo. Así que `UTC_DATE()` ya es el corte que pidió Kevin y no
// hay que aplicar ningún desplazamiento. Si algún día el servidor se mueve de
// zona, esto deja de ser cierto EN SILENCIO — por eso el sync lo verifica y
// avisa en vez de confiar.
//
// ── QUÉ CUENTA COMO PNL CERRADO ────────────────────────────────────────────
// La ganancia realizada vive en el deal de SALIDA: `Entry IN (1,3)` (OUT y
// OUT_BY). Y `Action IN (0,1)` (compra/venta) deja afuera `Action = 2`, que son
// las operaciones de saldo: depósitos, retiros y crédito. Sin ese filtro, un
// depósito grande entra al "PNL del día" como si el cliente hubiera ganado.
// Medido: los Action=2 de la tabla suman 425 millones.
//
// ── LAS CUENTAS QUE NO ESTÁN EN EL CRM ─────────────────────────────────────
// En MetaTrader hay ~1.140 cuentas reales más que en el CRM, y son de prueba.
// Operan y generan PNL igual que cualquiera. Se excluyen cruzando contra
// `crm_trading_accounts`, y las excluidas se CUENTAN: una exclusión silenciosa
// es indistinguible de un error de cruce.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { withMt5Connection, type Mt5Session } from '@/lib/api-integrations/mt5-sql/client';
import { round2 } from '@/lib/utils';

/** Categorías que se reportan. Ver el comentario de la columna en la migración. */
export const PNL_CATEGORIES = ['USD', 'CENT', 'PROPFIRM', 'BOOST'] as const;
export type PnlCategory = (typeof PNL_CATEGORIES)[number];

/**
 * Clasificación de la cuenta.
 *
 * ── EL ESCAPE DE LA BARRA, QUE YA FALLÓ UNA VEZ ────────────────────────────
 * Los grupos de MT5 usan barra invertida: `real\PropFirm\LeverageX12`. Para que
 * MySQL compare una barra literal hacen falta CUATRO en el texto SQL, y para
 * escribir cuatro en un literal de TypeScript hacen falta OCHO. Con menos, el
 * LIKE no matchea nada y PropFirm desaparece del informe sin ningún error.
 *
 * `LeverageX12` cuenta como PROPFIRM (Kevin, 2026-08-26): es un producto de la
 * prop firm, no una categoría aparte.
 *
 * ── QUÉ SON LAS BOOST, Y CÓMO SE SUPO ──────────────────────────────────────
 * Las "Boost x12" no se llaman Boost en ningún lado. Viven en dos grupos:
 *
 *     real\Broker\Synthetics_Apalancados    337 cuentas
 *     real\Broker\Apalancada                 57 cuentas
 *
 * Los dos con apalancamiento 1:33 y creados el 2026-08-02. El "x12" NO es el
 * apalancamiento de MT5: es el multiplicador de capital que acredita el CRM
 * (`walletCredit` / `capitalDelta` en `leveraged_account_events`), y por eso el
 * apalancamiento del servidor es bajo.
 *
 * La identificación no es por el nombre: se verificó contra Orion. Los 332
 * logins que el CRM trata como cuenta apalancada caen TODOS en esos dos grupos
 * y en ninguno más. Sin ese cruce, "Apalancada" habría sido una corazonada
 * sobre una palabra.
 *
 * La rama va ANTES del descarte por moneda: cuelgan de `real\Broker`, así que
 * sin ella caen en USD — que es exactamente donde estaban escondidas.
 *
 * La moneda sale de `mt5_groups.Currency`, que es el dato autoritativo. Deducir
 * "cent" del nombre del grupo funciona hasta que alguien crea un grupo con otro
 * nombre.
 */
export const CATEGORIA_SQL =
  "CASE WHEN u.`Group` LIKE 'real\\\\\\\\PropFirm%' THEN 'PROPFIRM' " +
  "WHEN u.`Group` LIKE 'real\\\\\\\\Broker\\\\\\\\%Apalancad%' THEN 'BOOST' " +
  "WHEN g.Currency = 'USC' THEN 'CENT' ELSE 'USD' END";

export const SQL_ABIERTO = [
  'SELECT p.Login AS login,',
  `       ${CATEGORIA_SQL} AS categoria,`,
  '       g.Currency AS moneda,',
  '       COUNT(*) AS posiciones,',
  '       SUM(p.Profit) AS profit,',
  '       SUM(p.Storage) AS swap',
  '  FROM mt5_positions p',
  '  JOIN mt5_users u  ON u.Login = p.Login',
  '  JOIN mt5_groups g ON g.`Group` = u.`Group`',
  " WHERE u.`Group` NOT LIKE 'demo%'",
  ' GROUP BY p.Login, categoria, moneda',
].join('\n');

export const SQL_CERRADO = [
  'SELECT d.Login AS login,',
  `       ${CATEGORIA_SQL} AS categoria,`,
  '       g.Currency AS moneda,',
  '       COUNT(*) AS ops,',
  '       SUM(d.Profit) AS profit,',
  '       SUM(d.Storage) AS swap,',
  '       SUM(d.Commission) AS comision',
  '  FROM mt5_deals d',
  '  JOIN mt5_users u  ON u.Login = d.Login',
  '  JOIN mt5_groups g ON g.`Group` = u.`Group`',
  ' WHERE d.Entry IN (1,3) AND d.Action IN (0,1)',
  '   AND d.TimeMsc >= ? AND d.TimeMsc < ?',
  "   AND u.`Group` NOT LIKE 'demo%'",
  ' GROUP BY d.Login, categoria, moneda',
].join('\n');

export interface PnlCategoryTotals {
  category: PnlCategory;
  currency: string;
  openPositions: number;
  openAccounts: number;
  openPnl: number;
  openSwap: number;
  closedDeals: number;
  closedAccounts: number;
  closedPnl: number;
  closedSwap: number;
  closedCommission: number;
  accountsOutsideCrm: number;
}

export interface PnlResult {
  snapshotAt: string;
  utcDay: string;
  totals: PnlCategoryTotals[];
  loginsSeen: number;
  loginsInCrm: number;
  elapsedMs: number;
  warnings: string[];
}

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : 0;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** El día UTC de una fecha, como `YYYY-MM-DD`. */
export function utcDayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface Fila {
  login: unknown;
  categoria: unknown;
  moneda: unknown;
  posiciones?: unknown;
  ops?: unknown;
  profit: unknown;
  swap: unknown;
  comision?: unknown;
}

/**
 * Cuáles de estos logins existen en el CRM como cuenta live.
 *
 * Se pregunta sólo por los que aparecieron en MT5 (~1.100 en una corrida
 * normal) y no se baja la lista entera de 23.275: traer 24 páginas de Supabase
 * para descartar mil logins es pagar el viaje al revés.
 */
async function loginsEnCrm(
  admin: SupabaseClient,
  companyId: string,
  logins: number[],
): Promise<Set<number>> {
  const dentro = new Set<number>();
  for (const part of chunk(logins, 300)) {
    const { data, error } = await admin
      .from('crm_trading_accounts')
      .select('login')
      .eq('company_id', companyId)
      .eq('is_live', true)
      .in('login', part);
    if (error) throw new Error(`crm_trading_accounts: ${error.message}`);
    for (const r of data ?? []) dentro.add(Number(r.login));
  }
  return dentro;
}

export async function syncMt5Pnl(
  admin: SupabaseClient,
  companyId: string,
  opts: { day?: string } = {},
): Promise<PnlResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const ahora = new Date();
  const utcDay = opts.day ?? utcDayOf(ahora);

  const { abiertas, cerradas, relojDesviado } = await withMt5Connection(
    companyId,
    async (session: Mt5Session) => {
      // El corte UTC depende de que el servidor del broker esté en UTC. Se
      // comprueba en vez de confiar: si algún día se mueve de zona, el "día"
      // cambiaría de significado sin que nada falle.
      const reloj = await session.query<{ desvio: unknown }>(
        'SELECT TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW()) AS desvio',
      );
      const desvio = Math.abs(num(reloj[0]?.desvio));

      const desde = `${utcDay} 00:00:00`;
      const hasta = `${utcDay} 23:59:59.999999`;

      const abiertas = await session.query<Fila>(SQL_ABIERTO);
      const cerradas = await session.query<Fila>(SQL_CERRADO, [desde, hasta]);
      return { abiertas, cerradas, relojDesviado: desvio > 1 };
    },
  );

  if (relojDesviado) {
    warnings.push(
      'El servidor de MetaTrader ya NO está en UTC: los cortes del día dejaron de ser cortes UTC.',
    );
  }

  const todos = new Set<number>();
  for (const f of abiertas) todos.add(num(f.login));
  for (const f of cerradas) todos.add(num(f.login));
  const enCrm = await loginsEnCrm(admin, companyId, [...todos]);

  const vacio = (categoria: PnlCategory, moneda: string): PnlCategoryTotals => ({
    category: categoria,
    currency: moneda,
    openPositions: 0,
    openAccounts: 0,
    openPnl: 0,
    openSwap: 0,
    closedDeals: 0,
    closedAccounts: 0,
    closedPnl: 0,
    closedSwap: 0,
    closedCommission: 0,
    accountsOutsideCrm: 0,
  });

  const porCategoria = new Map<PnlCategory, PnlCategoryTotals>();
  const fueraDelCrm = new Map<PnlCategory, Set<number>>();

  const acumula = (f: Fila, tipo: 'abierto' | 'cerrado') => {
    const categoria = String(f.categoria) as PnlCategory;
    if (!PNL_CATEGORIES.includes(categoria)) return;
    const login = num(f.login);
    const t = porCategoria.get(categoria) ?? vacio(categoria, String(f.moneda ?? ''));

    if (!enCrm.has(login)) {
      const s = fueraDelCrm.get(categoria) ?? new Set<number>();
      s.add(login);
      fueraDelCrm.set(categoria, s);
      porCategoria.set(categoria, t);
      return;
    }

    if (tipo === 'abierto') {
      t.openPositions += num(f.posiciones);
      t.openAccounts += 1;
      t.openPnl += num(f.profit);
      t.openSwap += num(f.swap);
    } else {
      t.closedDeals += num(f.ops);
      t.closedAccounts += 1;
      t.closedPnl += num(f.profit);
      t.closedSwap += num(f.swap);
      t.closedCommission += num(f.comision);
    }
    porCategoria.set(categoria, t);
  };

  for (const f of abiertas) acumula(f, 'abierto');
  for (const f of cerradas) acumula(f, 'cerrado');

  for (const [categoria, s] of fueraDelCrm) {
    const t = porCategoria.get(categoria);
    if (t) t.accountsOutsideCrm = s.size;
  }

  const totals = [...porCategoria.values()].map((t) => ({
    ...t,
    openPnl: round2(t.openPnl),
    openSwap: round2(t.openSwap),
    closedPnl: round2(t.closedPnl),
    closedSwap: round2(t.closedSwap),
    closedCommission: round2(t.closedCommission),
  }));

  const snapshotAt = ahora.toISOString();
  if (totals.length > 0) {
    const { error } = await admin.from('mt5_pnl_snapshots').upsert(
      totals.map((t) => ({
        company_id: companyId,
        snapshot_at: snapshotAt,
        utc_day: utcDay,
        category: t.category,
        currency: t.currency,
        open_positions: t.openPositions,
        open_accounts: t.openAccounts,
        open_pnl: t.openPnl,
        open_swap: t.openSwap,
        closed_deals: t.closedDeals,
        closed_accounts: t.closedAccounts,
        closed_pnl: t.closedPnl,
        closed_swap: t.closedSwap,
        closed_commission: t.closedCommission,
        accounts_outside_crm: t.accountsOutsideCrm,
      })),
      { onConflict: 'company_id,snapshot_at,category' },
    );
    if (error) throw new Error(`mt5_pnl_snapshots: ${error.message}`);
  }

  const excluidas = [...fueraDelCrm.values()].reduce((a, s) => a + s.size, 0);
  if (excluidas > 0) {
    warnings.push(
      `${excluidas} cuenta(s) operaron pero no están en el CRM: quedaron FUERA de las cifras.`,
    );
  }

  return {
    snapshotAt,
    utcDay,
    totals,
    loginsSeen: todos.size,
    loginsInCrm: enCrm.size,
    elapsedMs: Date.now() - started,
    warnings,
  };
}
