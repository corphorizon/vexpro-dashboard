// ─────────────────────────────────────────────────────────────────────────────
// Datos de una cuenta MT5 para el módulo de Liquidez.
//
// Reutiliza `withMt5Connection` — el cliente que ya resuelve las credenciales
// cifradas por empresa, sale por IP fija a través del proxy, fuerza solo-lectura
// y redacta las contraseñas de los errores. Crear una conexión nueva duplicaría
// todo eso, y el repo declara que las copias que se desincronizan en silencio
// son su modo de falla número uno.
//
// ── LO QUE ESTE ARCHIVO NO HACE ────────────────────────────────────────────
// No decide nada de liquidez. Sólo lee lo que MT5 sabe de la cuenta. Quién
// aporta al pool y cuánto lo decide `duplicate-account-detector.ts`.
// ─────────────────────────────────────────────────────────────────────────────

import { withMt5Connection, mt5DateUtc, type Mt5Session } from '@/lib/api-integrations/mt5-sql/client';

export interface Mt5AccountInfo {
  login: number;
  email: string | null;
  group: string | null;
  /** Dinero cerrado. */
  balance: number;
  /** Balance + flotante de las posiciones abiertas. Difiere del balance en el
   *  19% de las cuentas, así que se guardan los dos. */
  equity: number;
  /** Alta de la cuenta en MT5. */
  registeredAt: Date | null;
}

/**
 * `mt5_accounts` tiene el equity y `mt5_users` el resto.
 *
 * LEFT JOIN y no INNER: una cuenta recién creada puede no tener fila en
 * `mt5_accounts` todavía, y con INNER desaparecería sin que nada avisara — el
 * módulo diría «la cuenta no existe» cuando en realidad sí.
 */
const SQL_CUENTA = [
  'SELECT u.Login       AS login,',
  '       u.Email       AS email,',
  '       u.`Group`     AS grupo,',
  '       u.Balance     AS balance,',
  '       u.Registration AS alta,',
  '       a.Equity      AS equity',
  '  FROM mt5_users u',
  '  LEFT JOIN mt5_accounts a ON a.Login = u.Login',
  ' WHERE u.Login = ?',
  ' LIMIT 1',
].join('\n');

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Trae los datos de una cuenta. Devuelve `null` si el login no existe en MT5.
 *
 * `null` y «cuenta con todo en cero» son cosas distintas: la primera significa
 * que el número está mal, la segunda que la cuenta existe y está vacía. El
 * llamador tiene que poder distinguirlas.
 */
export async function fetchMt5Account(
  companyId: string,
  login: number,
): Promise<Mt5AccountInfo | null> {
  const filas = await withMt5Connection(companyId, async (s: Mt5Session) =>
    s.query<Record<string, unknown>>(SQL_CUENTA, [login]),
  );
  const r = filas[0];
  if (!r) return null;

  return {
    login: num(r.login),
    email: r.email ? String(r.email).trim().toLowerCase() : null,
    group: r.grupo ? String(r.grupo) : null,
    balance: num(r.balance),
    // Sin fila en `mt5_accounts` no hay equity: se cae al balance, que es el
    // equity de una cuenta sin posiciones abiertas.
    equity: r.equity === null || r.equity === undefined ? num(r.balance) : num(r.equity),
    // Toda fecha de MT5 pasa por mt5DateUtc: `new Date(texto)` depende de la
    // zona del proceso y ya produjo un desfase fantasma de 4 horas en este repo.
    registeredAt: mt5DateUtc(r.alta),
  };
}
