// ─────────────────────────────────────────────────────────────────────────────
// Espejo de actividad de trading (MT5) — sync.
//
// Contesta la pregunta que le falta a la revisión de retiros: ¿el cliente
// OPERÓ, o depositó y pidió el retiro sin tocar el mercado?
//
// ── LAS TRES REGLAS QUE SALEN DE MEDIR, NO DE SUPONER (2026-08-24) ──────────
//
//  1. AGREGAR SÓLO COLUMNAS DEL ÍNDICE. El índice útil de mt5_deals es
//     (Login, TimeMsc, Entry, Action, Profit, Storage, Commission). Agregar
//     esas columnas para 177 cuentas tarda 345 ms; agregar además `Volume`,
//     que no está en el índice, tarda 13.221 ms. 38 veces más por una columna.
//     Por eso acá NO se pide volumen: el del cliente ya viene del CRM.
//
//  2. LA LLAVE ES EL CORREO. `ClientID` tiene 18 valores distintos en 26.422
//     cuentas y casi todos son 0: unir por ahí casaría con la base entera.
//
//  3. UN CLIENTE, VARIAS CUENTAS. 26.422 cuentas para 11.390 correos. Se
//     guarda una fila por cuenta y se suma al leer.
//
// DEMO NO CUENTA. Las cuentas demo se espejan marcadas pero no suman: operar
// en demo no es evidencia de haber operado el dinero depositado. Se guardan
// para poder auditar la exclusión en vez de que desaparezcan sin rastro.
//
// ALCANCE: EL UNIVERSO COMPLETO DEL CRM, POR TANDAS. Kevin lo amplió el
// 2026-08-25. No entra en una corrida (8.709 clientes ≈ 3,7 min a la tasa
// medida), así que se rota: los pendientes siempre, y una tanda de los demás
// ordenada por antigüedad del espejo. Converge en menos de un día y después se
// mantiene sola.
//
// Cada correo consultado deja rastro en `mt5_email_sync_state`, INCLUSO si no
// tiene ninguna cuenta. Sin eso, los correos sin cuenta serían para siempre
// "nunca mirados" y bloquearían la rotación: cada corrida volvería a preguntar
// por los mismos que no existen y el resto no se espejaría jamás.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { withMt5Connection, type Mt5Session } from '@/lib/api-integrations/mt5-sql/client';

/**
 * Cuántas cuentas se agregan por consulta. Con 177 el motor tardó 345 ms; se
 * trocea igual para que una lista larga no arme un IN gigante ni una consulta
 * de duración impredecible en la base del broker.
 */
const LOGIN_BATCH = 200;

/** Correos por vuelta al resolver cuentas. */
const EMAIL_BATCH = 300;

/**
 * `Entry` 0 y 1 son entrada y salida de mercado. El resto (2 = reverse,
 * 3 = close by) y sobre todo los `Action` de balance/credit NO son operar:
 * un depósito aparece como deal y contarlo diría que operó quien sólo depositó
 * — justo el error que este módulo existe para evitar.
 */
const MARKET_ENTRIES = '(0,1)';

export interface Mt5SyncResult {
  emailsRequested: number;
  /** Correos consultados que NO tienen ninguna cuenta en MT5. */
  emailsWithoutAccount: number;
  accountsFound: number;
  demoSkipped: number;
  accountsWithDeals: number;
  upserted: number;
  elapsedMs: number;
  warnings: string[];
}

interface AccountRow {
  Login: unknown;
  email: unknown;
  grp: unknown;
  Balance: unknown;
  Registration: unknown;
}

interface AggRow {
  Login: unknown;
  ops: unknown;
  profit: unknown;
  commission: unknown;
  storage: unknown;
  primera: unknown;
  ultima: unknown;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
};

/**
 * Las fechas vuelven como string porque el driver usa `dateStrings` (para que
 * no las reinterprete en la zona horaria del servidor). MT5 las escribe en
 * UTC, así que se marca explícitamente en vez de dejar que Date adivine la
 * zona local de quien corra esto.
 */
export function mt5DateToIso(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s || s.startsWith('0000')) return null;
  const d = new Date(s.replace(' ', 'T') + (/[Zz+]/.test(s) ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Normaliza igual que la consulta SQL, para que las dos puntas coincidan. */
export function normalizeEmail(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  return s || null;
}

/**
 * Espeja la actividad de trading de los clientes indicados por correo.
 * Devuelve el detalle de lo que hizo para que el cron lo pueda registrar.
 */
export async function syncTradingActivity(
  admin: SupabaseClient,
  companyId: string,
  emails: string[],
): Promise<Mt5SyncResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const wanted = [...new Set(emails.map(normalizeEmail).filter((e): e is string => !!e))];

  if (wanted.length === 0) {
    return {
      emailsRequested: 0, emailsWithoutAccount: 0, accountsFound: 0, demoSkipped: 0,
      accountsWithDeals: 0, upserted: 0, elapsedMs: Date.now() - started, warnings,
    };
  }

  const rows = await withMt5Connection(companyId, async (session: Mt5Session) => {
    // ── 1. Las cuentas de esos correos ──────────────────────────────────────
    const accounts: AccountRow[] = [];
    for (const part of chunk(wanted, EMAIL_BATCH)) {
      const ph = part.map(() => '?').join(',');
      const r = await session.query<AccountRow>(
        `SELECT Login, LOWER(TRIM(Email)) AS email, \`Group\` AS grp, Balance, Registration
           FROM mt5_users WHERE LOWER(TRIM(Email)) IN (${ph})`,
        part,
      );
      accounts.push(...r);
    }

    // ── 2. Agregado por cuenta, SÓLO columnas del índice ────────────────────
    // Las demo se espejan igual (marcadas) pero no se agregan: gastar tiempo
    // del broker en contar operaciones que no vamos a usar no tiene sentido.
    const realLogins = accounts
      .filter((a) => !String(a.grp ?? '').toLowerCase().startsWith('demo'))
      .map((a) => String(a.Login));

    const aggs = new Map<string, AggRow>();
    for (const part of chunk(realLogins, LOGIN_BATCH)) {
      const ph = part.map(() => '?').join(',');
      const r = await session.query<AggRow>(
        `SELECT Login,
                COUNT(*)         AS ops,
                SUM(Profit)      AS profit,
                SUM(Commission)  AS commission,
                SUM(Storage)     AS storage,
                MIN(TimeMsc)     AS primera,
                MAX(TimeMsc)     AS ultima
           FROM mt5_deals
          WHERE Login IN (${ph}) AND Entry IN ${MARKET_ENTRIES}
          GROUP BY Login`,
        part,
      );
      for (const a of r) aggs.set(String(a.Login), a);
    }

    return { accounts, aggs };
  });

  const demoSkipped = rows.accounts.filter((a) =>
    String(a.grp ?? '').toLowerCase().startsWith('demo'),
  ).length;

  const payload = rows.accounts.map((a) => {
    const login = String(a.Login);
    const isDemo = String(a.grp ?? '').toLowerCase().startsWith('demo');
    const agg = rows.aggs.get(login);
    return {
      company_id: companyId,
      login: Number(login),
      email: normalizeEmail(a.email),
      group_name: a.grp ? String(a.grp) : null,
      is_demo: isDemo,
      // Una cuenta sin operaciones queda en 0, NO en null: "no operó" es un
      // dato, y distinguirlo de "no lo sabemos" es justamente el punto.
      deals_count: agg ? (num(agg.ops) ?? 0) : 0,
      profit: agg ? num(agg.profit) : null,
      commission: agg ? num(agg.commission) : null,
      storage: agg ? num(agg.storage) : null,
      first_deal_at: agg ? mt5DateToIso(agg.primera) : null,
      last_deal_at: agg ? mt5DateToIso(agg.ultima) : null,
      account_balance: num(a.Balance),
      registration_at: mt5DateToIso(a.Registration),
      synced_at: new Date().toISOString(),
    };
  });

  let upserted = 0;
  for (const part of chunk(payload, 500)) {
    const { error } = await admin
      .from('mt5_account_activity')
      .upsert(part, { onConflict: 'company_id,login' });
    if (error) throw new Error(`mt5_account_activity: ${error.message}`);
    upserted += part.length;
  }

  // ── Rastro del INTENTO, no del resultado ────────────────────────────────
  // Se escribe una fila por cada correo CONSULTADO, con cuántas cuentas se le
  // encontraron. Cero es una respuesta válida. Esto es lo que permite rotar
  // por tandas sin que los correos sin cuenta se queden atascados al frente
  // de la cola para siempre.
  const encontradasPorCorreo = new Map<string, number>();
  for (const e of wanted) encontradasPorCorreo.set(e, 0);
  for (const p of payload) {
    if (p.email) encontradasPorCorreo.set(p.email, (encontradasPorCorreo.get(p.email) ?? 0) + 1);
  }

  const attemptAt = new Date().toISOString();
  const estados = [...encontradasPorCorreo.entries()].map(([email, n]) => ({
    company_id: companyId,
    email,
    last_attempt_at: attemptAt,
    accounts_found: n,
  }));
  for (const part of chunk(estados, 500)) {
    const { error } = await admin
      .from('mt5_email_sync_state')
      .upsert(part, { onConflict: 'company_id,email' });
    // Que falle el rastro no invalida los datos ya espejados, pero SÍ hay que
    // saberlo: sin rastro, la rotación deja de avanzar.
    if (error) warnings.push(`No se pudo registrar el rastro de espejado: ${error.message}`);
  }

  const sinCuenta = [...encontradasPorCorreo.values()].filter((n) => n === 0).length;
  if (sinCuenta > 0) {
    warnings.push(`${sinCuenta} correo(s) del CRM no tienen ninguna cuenta en MT5.`);
  }

  return {
    emailsRequested: wanted.length,
    emailsWithoutAccount: sinCuenta,
    accountsFound: rows.accounts.length,
    demoSkipped,
    accountsWithDeals: payload.filter((p) => p.deals_count > 0).length,
    upserted,
    elapsedMs: Date.now() - started,
    warnings,
  };
}
