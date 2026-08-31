// ─────────────────────────────────────────────────────────────────────────────
// El saldo que tenía una cuenta EN LA FECHA DE CONEXIÓN.
//
// ── POR QUÉ NO ALCANZA CON LEER EL BALANCE DE HOY ──────────────────────────
// Al dar de alta una cuenta retroactiva —una que ya venía operando— el balance
// que MT5 devuelve es el de HOY, no el que tenía ese día. Guardarlo como
// "balance a la conexión" pondría un número con cara de dato bueno en un campo
// que dice otra cosa.
//
// ── CÓMO SE RECONSTRUYE ────────────────────────────────────────────────────
//   saldo_en_T = balance_de_hoy − (todo lo que movió el saldo desde T)
//
// "Todo lo que movió el saldo" es `Profit + Storage + Commission` sobre TODOS
// los deals, sin filtrar por `Action`. Acá —y sólo acá— los depósitos y retiros
// (`Action = 2`) SÍ entran: mueven el balance igual que una operación. Es la
// diferencia con el cálculo de PnL, que los excluye porque no son resultado.
//
// Verificado contra la cuenta 136773: trading -8.182,71 (idéntico a la suma de
// su PnL mensual) + depósitos/retiros -1.383,96 = -9.566,67. Con balance de hoy
// en 0, el saldo al 06/03 da 9.566,67 y la identidad cierra exacta.
//
// ── LO QUE ESTO NO PUEDE SABER: EL EQUITY ──────────────────────────────────
// El equity es el balance MÁS el flotante de las posiciones abiertas en ese
// instante, y el flotante depende del precio de mercado de ese momento, que
// `mt5_deals` no guarda. Reconstruirlo sería inventarlo.
//
// Por eso se devuelve además CUÁNTAS posiciones estaban abiertas:
//   · 0  → no había flotante, y entonces equity = balance. El número es exacto.
//   · >0 → el equity real era otro, y quien mire tiene que saberlo.
// Se devuelve el dato en vez de tragárselo: un número aproximado presentado
// como exacto es peor que un número con su advertencia al lado.
// ─────────────────────────────────────────────────────────────────────────────

import { withMt5Connection, type Mt5Session } from '@/lib/api-integrations/mt5-sql/client';

export interface SaldoALaFecha {
  /** Balance reconstruido para ese instante. */
  balance: number;
  /**
   * Posiciones abiertas en ese instante. `null` significa que no se pudo
   * contar — distinto de `0`, que significa que no había ninguna.
   */
  posicionesAbiertas: number | null;
  /** `true` si no había flotante, y entonces el equity es igual al balance. */
  exacto: boolean;
}

/** `YYYY-MM-DD HH:MM:SS` en UTC, el formato que espera el SQL Export de MT5. */
function comoSql(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : 0;
};

// ── UNA SOLA IDA Y VUELTA ──────────────────────────────────────────────────
// Las tres lecturas van como subconsultas de un mismo SELECT. Eran tres
// consultas separadas, y contra un MT5 al otro lado de un túnel SOCKS lo que se
// paga no es el trabajo del motor sino cada viaje: las tres juntas medían
// 1.556 ms cuando ninguna llega a 500 ms por sí sola.
//
// `balance_hoy` sale NULL cuando el login no existe — distinto de un balance
// en cero, que es un login que existe y está vacío.
const SQL_SALDO = [
  'SELECT',
  '  (SELECT u.Balance FROM mt5_users u WHERE u.Login = ?) AS balance_hoy,',
  '  (SELECT SUM(d.Profit + d.Storage + d.Commission)',
  '     FROM mt5_deals d WHERE d.Login = ? AND d.TimeMsc >= ?) AS movido,',
  // El NOT EXISTS mira el cierre CONTRA LA MISMA FECHA, no contra hoy: una
  // posición que abrió antes y cerró después seguía abierta en ese momento.
  //
  // ── DOS FILTROS QUE PARECEN DE MÁS Y NO LO SON ────────────────────────
  //
  // `x.Login = d.Login` — `PositionID` NO es único entre cuentas. Las
  // operaciones de balance llevan `PositionID = 0`, y ese cero lo comparten
  // miles de logins. Sin atar el login, el NOT EXISTS encontraba el "cierre"
  // de la posición 0 de OTRA cuenta y daba por cerrada la propia.
  //
  // De paso es lo que hace que la consulta use el índice: sin el login, MySQL
  // barría `idx_deals_entry_timemsc_login` —1.090.454 filas medidas— por cada
  // fila candidata. Con él baja a 244. En la cuenta 136773: 3.754 ms → 637 ms.
  //
  // `d.Action IN (0,1)` — un depósito es `Action = 2`, `Entry = 0` y
  // `PositionID = 0`: tiene exactamente la forma de "una entrada que nunca
  // cerró". Sin este filtro, la 136773 contaba como posición abierta un
  // depósito de 8.000 del 26/02.
  //
  // Control de que la cuenta sigue bien: a las 14:27 del 31/03, dentro del
  // ticket 3342152 (abierto 14:26:02, cerrado 14:28:09), devuelve 1.
  '  (SELECT COUNT(*) FROM (',
  '     SELECT d.PositionID FROM mt5_deals d',
  '      WHERE d.Login = ? AND d.Action IN (0,1) AND d.Entry = 0 AND d.TimeMsc < ?',
  '        AND NOT EXISTS (',
  '          SELECT 1 FROM mt5_deals x',
  '           WHERE x.Login = d.Login AND x.PositionID = d.PositionID',
  '             AND x.Entry IN (1,3) AND x.TimeMsc < ?)',
  '      GROUP BY d.PositionID) t) AS abiertas',
].join('\n');

/**
 * Reconstruye el saldo de una cuenta a una fecha pasada.
 *
 * Devuelve `null` si el login no existe en MT5 — distinto de una cuenta que
 * existe y tenía cero.
 */
export async function calcularSaldoALaFecha(
  companyId: string,
  mt5Account: string,
  fecha: Date,
): Promise<SaldoALaFecha | null> {
  return withMt5Connection(companyId, (s) => saldoALaFechaEnSesion(s, mt5Account, fecha));
}

/**
 * Igual, pero sobre una sesión YA abierta.
 *
 * Abrir el túnel SOCKS cuesta más que las tres consultas juntas, y en
 * serverless no hay pool que sobreviva entre invocaciones. Cuando el llamador
 * ya tiene una sesión, reusarla ahorra varios segundos por cuenta.
 */
export async function saldoALaFechaEnSesion(
  s: Mt5Session,
  mt5Account: string,
  fecha: Date,
): Promise<SaldoALaFecha | null> {
  const login = Number(mt5Account);
  if (!Number.isFinite(login) || login <= 0) return null;

  const desde = comoSql(fecha);

  const filas = await s.query<Record<string, unknown>>(
    SQL_SALDO,
    [login, login, desde, login, desde, desde],
  );
  const r = filas[0];
  // `balance_hoy` en NULL es «el login no existe». Un login que existe con
  // saldo cero devuelve 0, y son cosas distintas.
  if (!r || r.balance_hoy === null || r.balance_hoy === undefined) return null;

  const balanceHoy = num(r.balance_hoy);
  // `SUM` sobre cero filas devuelve NULL, no 0: sin operaciones después de esa
  // fecha, lo movido es cero y el saldo de entonces es el de hoy.
  const movido = num(r.movido);
  const posicionesAbiertas = r.abiertas === null || r.abiertas === undefined ? null : num(r.abiertas);

  return {
    balance: Math.round((balanceHoy - movido) * 100) / 100,
    posicionesAbiertas,
    exacto: posicionesAbiertas === 0,
  };
}
