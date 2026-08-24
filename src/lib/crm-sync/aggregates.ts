// ─────────────────────────────────────────────────────────────────────────────
// Agregados por cliente desde Orion — lo que Atlas consume.
//
// Atlas NUNCA ve un documento individual de `deposits` ni de `tradingaccounts`:
// consume seis agregados por cliente. Acá se calculan.
//
// ── LA ADUANA: LA PROYECCIÓN ES LA DEFENSA ─────────────────────────────────
// `tradingaccounts` tiene `masterPassword` e `investorPassword` EN TEXTO PLANO
// en el origen. La protección no es filtrarlos al mapear: es NO PEDIRLOS. Lo
// que no está en la proyección no viaja por la red, no llega a memoria y no
// puede terminar en un log ni en un volcado de error.
//
// Atlas tiene la misma lista con sus propios tests, y acordamos que viva en
// los dos lados: su lista blanca protege lo que entra por SU sync, no lo que
// salga por una API nuestra.
//
// ── DE DÓNDE SALE CADA COSA ────────────────────────────────────────────────
// Depósitos y retiros NO se piden a Mongo: ya los tenemos espejados en
// crm_deposits / crm_withdrawals. Pedirle dos veces lo mismo al broker sería
// gastar su servidor para nada.
//
// De Mongo sólo salen las tres colecciones que todavía no espejamos: wallets,
// tradingaccounts y socialtradingaccounts.
//
// ── NULL NO ES CERO ────────────────────────────────────────────────────────
// Un cliente sin billeteras devuelve 0 (lo calculamos y da cero). Un cliente
// que no procesamos queda en NULL. Confundirlos hace que alguien con 4.000
// dólares se muestre en cero, y el segmento "depositó y no tiene cuenta live"
// mienta sin que nadie lo note.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { withOrionMongo } from '@/lib/api-integrations/orion-mongo/client';
import { round2 } from '@/lib/utils';

/**
 * Los ÚNICOS campos que se piden de cada colección. Cambiar esto es cambiar
 * qué sale de la base del broker: hay un test que lo fija.
 */
export const ORION_WALLET_FIELDS = ['userId', 'walletType', 'balance'] as const;
export const ORION_TRADING_ACCOUNT_FIELDS = ['userId', 'real'] as const;
export const ORION_SOCIAL_ACCOUNT_FIELDS = ['userId'] as const;

/**
 * Campos que NO deben salir NUNCA. No es el mecanismo de defensa —ése es la
 * proyección— sino la afirmación contra la que corre el test.
 *
 * `masterPassword` e `investorPassword` están en texto plano en el origen;
 * copiarlas multiplicaría los sitios desde los que se puede robar acceso a
 * 30.962 cuentas. `targetAddress` es la billetera de destino de un retiro: un
 * agente de call center no tiene ningún motivo para verla.
 */
export const ORION_FORBIDDEN_FIELDS = [
  'masterPassword',
  'investorPassword',
  'targetAddress',
  'password',
  'otp',
  'frontPageId',
  'backPageId',
  'proofOfAddress',
  'selfie',
  'hash',
  'profileImage',
  'address',
  'birthDate',
] as const;

/** Sólo el saldo de billetera cuenta como `wallet_balance`. */
const BALANCE_WALLET_TYPE = 'BALANCE';

export interface AggregatesResult {
  customers: number;
  upserted: number;
  wallets: number;
  tradingAccounts: number;
  socialAccounts: number;
  elapsedMs: number;
  warnings: string[];
}

/** Arma la proyección de Mongo a partir de una lista blanca. */
export function projectionOf(fields: readonly string[]): Record<string, 1> {
  const p: Record<string, 1> = {};
  for (const f of fields) p[f] = 1;
  return p;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
};

/**
 * Recalcula los agregados de los clientes de la empresa.
 *
 * ── DOS MODOS, Y LA DIFERENCIA IMPORTA ─────────────────────────────────────
 * COMPLETO (sin `changedSince`): recalcula los 20.900. Es lo correcto de fondo
 * porque los agregados dependen de colecciones enteras — si una billetera baja
 * de saldo, el total del cliente cambia sin que el cliente se "actualice", y
 * un cursor sobre `users` no lo detectaría nunca.
 *
 * RÁPIDO (`changedSince`): recalcula sólo los clientes cuyos depósitos o
 * retiros se movieron desde esa marca. Existe porque el traspaso a Retención
 * se dispara con `depositCount` y necesita 15 minutos de latencia, mientras
 * que barrer las tres colecciones de Mongo cada 15 minutos sería multiplicar
 * por 16 la carga sobre la base de PRODUCCIÓN del broker para refrescar datos
 * que casi nunca cambian.
 *
 * El modo rápido NO refresca conteos de cuentas de los clientes que no
 * movieron dinero ni cambiaron de saldo: para eso está el completo cada 4
 * horas. Es un compromiso consciente, no un olvido.
 *
 * ── SI CAMBIÁS CÓMO SE CALCULA ALGO ACÁ, CORRÉ UNA COMPLETA ────────────────
 * El modo rápido sólo reescribe a quien se movió, así que un cambio de fórmula
 * o de campo NO llega a las filas ya guardadas: se quedan con el valor viejo
 * indefinidamente, sin dar error.
 *
 * Pasó de verdad el 2026-08-25 al corregir el campo de retiros: 3.604 de 3.820
 * clientes conservaron el importe anterior y el total quedó $30.040 corto
 * hasta que se disparó una completa. La sesión de Atlas se comió el mismo
 * problema dos veces el mismo día. No es una posibilidad teórica.
 *
 * Disparo manual: /api/cron/sync-crm?mode=full
 */
export async function syncCustomerAggregates(
  admin: SupabaseClient,
  companyId: string,
  opts: { changedSince?: string | null } = {},
): Promise<AggregatesResult> {
  const started = Date.now();
  const warnings: string[] = [];

  // ── 0. En modo rápido, QUIÉN hay que recalcular ─────────────────────────
  //
  // Dos motivos para entrar en la lista, y hacen falta los dos:
  //
  //  · movió dinero (depósito o retiro nuevo en nuestro espejo), que es lo que
  //    dispara el traspaso a Retención;
  //  · le cambió el SALDO de billetera, que Kevin pidió refrescar también cada
  //    15 minutos.
  //
  // El saldo NO se puede detectar por movimientos: cambia por transferencias
  // internas, comisiones y ajustes que no dejan depósito. La única forma de
  // saber a quién le cambió es LEERLOS TODOS y comparar. Medido: leer las
  // 62.652 billeteras tarda 1,6 s — barato de sobra para cada 15 minutos.
  //
  // Lo que se evita igual es lo caro: recalcular y REESCRIBIR 20.900 filas
  // cuando cambiaron veinte.
  const movieronDinero = opts.changedSince
    ? await usersWithRecentMoney(admin, companyId, opts.changedSince)
    : null;

  // ── 1. Lo que ya tenemos espejado: depósitos y retiros ──────────────────
  const dineroPlataforma = await depositsAndWithdrawals(admin, companyId);

  // ── 2. Las billeteras SIEMPRE se leen enteras (ver arriba) ──────────────
  const saldosMongo = await withOrionMongo(companyId, async ({ db }) =>
    db
      .collection('wallets')
      .aggregate(
        [
          { $match: { walletType: BALANCE_WALLET_TYPE } },
          { $project: projectionOf(ORION_WALLET_FIELDS) },
          { $group: { _id: '$userId', balance: { $sum: '$balance' } } },
        ],
        { allowDiskUse: false, maxTimeMS: 60_000 },
      )
      .toArray(),
  );

  const saldoPorUsuario = new Map<string, number>();
  for (const w of saldosMongo) {
    if (w._id) saldoPorUsuario.set(String(w._id), round2(numOrNull(w.balance) ?? 0));
  }

  // ── 3. En modo rápido: unir los que movieron dinero con los que cambiaron
  //      de saldo ────────────────────────────────────────────────────────
  let soloEstos: Set<string> | null = null;
  if (movieronDinero) {
    soloEstos = new Set(movieronDinero);
    const guardados = await fetchAllRows<{ user_external_id: string; wallet_balance: number | null }>(
      (from, to) =>
        admin
          .from('crm_customer_aggregates')
          .select('user_external_id, wallet_balance')
          .eq('company_id', companyId)
          .order('user_external_id', { ascending: true })
          .range(from, to),
    );
    const antes = new Map(guardados.map((g) => [g.user_external_id, Number(g.wallet_balance) || 0]));
    for (const [uid, saldo] of saldoPorUsuario) {
      if (Math.abs(saldo - (antes.get(uid) ?? 0)) > 0.005) soloEstos.add(uid);
    }
    // Un cliente que tenía saldo y ya no aparece en Mongo también cambió.
    for (const [uid, saldo] of antes) {
      if (saldo !== 0 && !saldoPorUsuario.has(uid)) soloEstos.add(uid);
    }

    if (soloEstos.size === 0) {
      return {
        customers: 0, upserted: 0, wallets: saldoPorUsuario.size,
        tradingAccounts: 0, socialAccounts: 0,
        elapsedMs: Date.now() - started, warnings,
      };
    }
  }

  // ── 4. El resto de Mongo, ya filtrado ───────────────────────────────────
  const desdeMongo = await withOrionMongo(companyId, async ({ db }) => {
    const filtroUsuarios = soloEstos ? { userId: { $in: [...soloEstos] } } : {};

    const accountAgg = await db
      .collection('tradingaccounts')
      .aggregate(
        [
          ...(soloEstos ? [{ $match: filtroUsuarios }] : []),
          { $project: projectionOf(ORION_TRADING_ACCOUNT_FIELDS) },
          {
            $group: {
              _id: '$userId',
              total: { $sum: 1 },
              live: { $sum: { $cond: [{ $eq: ['$real', true] }, 1, 0] } },
            },
          },
        ],
        { allowDiskUse: false, maxTimeMS: 60_000 },
      )
      .toArray();

    const socialAgg = await db
      .collection('socialtradingaccounts')
      .aggregate(
        [
          ...(soloEstos ? [{ $match: filtroUsuarios }] : []),
          { $project: projectionOf(ORION_SOCIAL_ACCOUNT_FIELDS) },
          { $group: { _id: '$userId', total: { $sum: 1 } } },
        ],
        { allowDiskUse: false, maxTimeMS: 60_000 },
      )
      .toArray();

    return { accountAgg, socialAgg };
  });

  const cuentasPorUsuario = new Map<string, { total: number; live: number }>();
  for (const a of desdeMongo.accountAgg) {
    if (a._id) cuentasPorUsuario.set(String(a._id), { total: Number(a.total ?? 0), live: Number(a.live ?? 0) });
  }
  const socialPorUsuario = new Map<string, number>();
  for (const s of desdeMongo.socialAgg) {
    if (s._id) socialPorUsuario.set(String(s._id), Number(s.total ?? 0));
  }

  // ── 3. El universo: nuestros perfiles espejados ─────────────────────────
  const perfiles = await fetchAllRows<{
    user_external_id: string;
    email: string | null;
    raw: Record<string, unknown> | null;
  }>((from, to) =>
    admin
      .from('crm_user_snapshots')
      .select('user_external_id, email, raw')
      .eq('company_id', companyId)
      .order('user_external_id', { ascending: true })
      .range(from, to),
  );

  const now = new Date().toISOString();
  const payload = perfiles
    .filter((p) => !soloEstos || soloEstos.has(p.user_external_id))
    .map((p) => {
    const uid = p.user_external_id;
    const cuentas = cuentasPorUsuario.get(uid);
    const dinero = dineroPlataforma.get(uid);
    const raw = p.raw ?? {};
    return {
      company_id: companyId,
      user_external_id: uid,
      email: p.email ? p.email.trim().toLowerCase() : null,
      // Cero porque lo calculamos y da cero, no porque falte el dato.
      // Redondeado al centavo al ESCRIBIR: sumar cientos de importes en coma
      // flotante deja colas como 453.795038, que después aparecen como
      // "diferencias" al comparar contra otro sistema que sí redondeó.
      wallet_balance: saldoPorUsuario.get(uid) ?? 0,
      total_deposits: round2(dinero?.total ?? 0),
      deposit_count: dinero?.count ?? 0,
      last_deposit_at: dinero?.last ?? null,
      total_withdrawals: round2(dinero?.withdrawn ?? 0),
      accounts_count: cuentas?.total ?? 0,
      live_accounts_count: cuentas?.live ?? 0,
      social_accounts_count: socialPorUsuario.get(uid) ?? 0,
      kyc_level: raw.kycLevel != null ? String(raw.kycLevel) : null,
      enabled_withdrawals: typeof raw.enabledWithdrawals === 'boolean' ? raw.enabledWithdrawals : null,
      client_id: raw.clientId != null ? String(raw.clientId) : null,
      synced_at: now,
    };
  });

  let upserted = 0;
  for (const part of chunk(payload, 500)) {
    const { error } = await admin
      .from('crm_customer_aggregates')
      .upsert(part, { onConflict: 'company_id,user_external_id' });
    if (error) throw new Error(`crm_customer_aggregates: ${error.message}`);
    upserted += part.length;
  }

  const sinPerfil = saldoPorUsuario.size - payload.filter((p) => saldoPorUsuario.has(p.user_external_id)).length;
  if (sinPerfil > 0) {
    warnings.push(`${sinPerfil} usuario(s) con billetera en Orion no tienen perfil espejado.`);
  }

  return {
    customers: payload.length,
    upserted,
    wallets: saldoPorUsuario.size,
    tradingAccounts: cuentasPorUsuario.size,
    socialAccounts: socialPorUsuario.size,
    elapsedMs: Date.now() - started,
    warnings,
  };
}

/**
 * Clientes cuyos depósitos o retiros se escribieron desde `since`. Es el
 * conjunto que el modo rápido tiene que recalcular: si a alguien no le entró
 * ni le salió dinero, su `depositCount` no cambió y el traspaso a Retención no
 * puede depender de él.
 */
async function usersWithRecentMoney(
  admin: SupabaseClient,
  companyId: string,
  since: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const tabla of ['crm_deposits', 'crm_withdrawals'] as const) {
    const filas = await fetchAllRows<{ user_external_id: string | null }>((from, to) =>
      admin
        .from(tabla)
        .select('user_external_id, external_id')
        .eq('company_id', companyId)
        .gte('synced_at', since)
        .order('external_id', { ascending: true })
        .range(from, to),
    );
    for (const f of filas) if (f.user_external_id) out.add(f.user_external_id);
  }
  return out;
}

/**
 * Depósitos y retiros desde NUESTRO espejo. Sólo los completados: un depósito
 * cancelado no es plata que entró, y contarlo diría que el cliente financió
 * cuando no lo hizo.
 */
async function depositsAndWithdrawals(
  admin: SupabaseClient,
  companyId: string,
): Promise<Map<string, { total: number; count: number; last: string | null; withdrawn: number }>> {
  const out = new Map<string, { total: number; count: number; last: string | null; withdrawn: number }>();

  const deps = await fetchAllRows<{ user_external_id: string | null; amount_paid: number | null; deposit_at: string | null }>(
    (from, to) =>
      admin
        .from('crm_deposits')
        .select('user_external_id, amount_paid, deposit_at')
        .eq('company_id', companyId)
        .eq('status_norm', 'completed')
        // El orden NO es cosmético: sin él, Postgres puede devolver las
        // páginas en distinto orden y una fila sale dos veces mientras otra no
        // sale nunca. Ver la cabecera de fetchAllRows.
        .order('external_id', { ascending: true })
        .range(from, to),
  );
  for (const d of deps) {
    if (!d.user_external_id) continue;
    const cur = out.get(d.user_external_id) ?? { total: 0, count: 0, last: null, withdrawn: 0 };
    cur.total += d.amount_paid ?? 0;
    cur.count += 1;
    if (d.deposit_at && (!cur.last || d.deposit_at > cur.last)) cur.last = d.deposit_at;
    out.set(d.user_external_id, cur);
  }

  // ── POR QUÉ `requested_amount` Y NO `transaction_amount` ────────────────
  // Los dos existen y los DOS son reales, pero miden hechos distintos:
  //
  //   requestedAmount    lo que sale de la BILLETERA del cliente
  //   transactionAmount  lo que el cliente RECIBE por fuera, neto de comisión
  //   fee                se lo queda el broker
  //
  // Verificado contra `wallettransfers`, el libro de la billetera, sobre 3.628
  // clientes donde los dos importes difieren: lo descontado coincide con
  // `requestedAmount` en 2.978 casos y con `transactionAmount` en CERO.
  //
  // DEFINICIÓN DEL NEGOCIO (Kevin, 2026-08-25), textual: "al cliente le
  // descontamos 100 de su balance; para el broker el retiro es de 97 más la
  // comisión que cobre el procesador".
  //
  // Hay DOS respuestas correctas según quién pregunte. Acá se calcula la
  // POSICIÓN DEL CLIENTE, así que manda lo que salió de su saldo: 100. La
  // salida de caja del broker es otro número y otra pregunta.
  //
  // No es el mismo caso que en depósitos. Ahí `depositValue` era la INTENCIÓN
  // del usuario y `amountPaid` el hecho; acá los dos son hechos. Asumir que el
  // paralelo se sostenía fue un error mío el 2026-08-25, corregido el mismo día
  // haciéndole a los retiros la misma prueba del libro que ya se le había hecho
  // a los depósitos.
  const wds = await fetchAllRows<{ user_external_id: string | null; requested_amount: number | null }>((from, to) =>
    admin
      .from('crm_withdrawals')
      .select('user_external_id, requested_amount')
      .eq('company_id', companyId)
      .eq('status_norm', 'approved')
      .order('external_id', { ascending: true })
      .range(from, to),
  );
  for (const w of wds) {
    if (!w.user_external_id) continue;
    const cur = out.get(w.user_external_id) ?? { total: 0, count: 0, last: null, withdrawn: 0 };
    cur.withdrawn += w.requested_amount ?? 0;
    out.set(w.user_external_id, cur);
  }

  return out;
}

/**
 * Trae TODAS las filas paginando.
 *
 * DOS TRAMPAS, LAS DOS SILENCIOSAS:
 *
 *  1. PostgREST corta en 1.000 filas y no avisa. Con 39.000 depósitos, sin
 *     paginar se calcularían los agregados sobre el 2,5% de los datos.
 *
 *  2. Cada consulta que se pagine DEBE traer un `.order(...)` por una columna
 *     única. Sin orden explícito, Postgres no garantiza que las páginas sean
 *     consistentes entre sí: una fila puede salir en dos páginas y otra en
 *     ninguna. No da error — da números mal.
 *
 * La segunda nos costó 15.095 diferencias en la comparación con Atlas el
 * 2026-08-25: un cliente con 5 depósitos aparecía con 0, y otro con 1 depósito
 * de $300 aparecía con 2 de $600 (exactamente el doble). El espejo estaba
 * perfecto; lo que estaba mal era esta paginación.
 */
async function fetchAllRows<T>(
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
