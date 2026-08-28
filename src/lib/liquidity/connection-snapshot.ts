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

const SQL_BALANCE_HOY = 'SELECT Balance AS balance FROM mt5_users WHERE Login = ? LIMIT 1';

// Se filtra por `TimeMsc` contra una fecha, como en todo el repo: `Timestamp`
// es FILETIME y devuelve la tabla entera, y `Time` no tiene índice.
const SQL_MOVIDO_DESDE = [
  'SELECT SUM(Profit + Storage + Commission) AS movido',
  '  FROM mt5_deals',
  ' WHERE Login = ?',
  '   AND TimeMsc >= ?',
].join('\n');

/**
 * Posiciones que estaban abiertas en ese instante: entraron antes (`Entry = 0`)
 * y todavía no habían salido (`Entry IN (1,3)`).
 *
 * El `NOT EXISTS` mira el cierre CONTRA LA MISMA FECHA, no contra hoy: una
 * posición que abrió antes y cerró después seguía abierta en ese momento, y
 * comparando contra hoy desaparecería.
 */
const SQL_ABIERTAS_EN = [
  'SELECT COUNT(*) AS n FROM (',
  '  SELECT d.PositionID',
  '    FROM mt5_deals d',
  '   WHERE d.Login = ? AND d.Entry = 0 AND d.TimeMsc < ?',
  '     AND NOT EXISTS (',
  '       SELECT 1 FROM mt5_deals x',
  '        WHERE x.PositionID = d.PositionID',
  '          AND x.Entry IN (1,3) AND x.TimeMsc < ?)',
  '   GROUP BY d.PositionID) t',
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
  const login = Number(mt5Account);
  if (!Number.isFinite(login) || login <= 0) return null;

  const desde = comoSql(fecha);

  return withMt5Connection(companyId, async (s: Mt5Session) => {
    const usuario = await s.query<Record<string, unknown>>(SQL_BALANCE_HOY, [login]);
    if (!usuario[0]) return null;
    const balanceHoy = num(usuario[0].balance);

    const mov = await s.query<Record<string, unknown>>(SQL_MOVIDO_DESDE, [login, desde]);
    // `SUM` sobre cero filas devuelve NULL, no 0: sin cuenta abierta después de
    // esa fecha, lo movido es cero y el saldo de entonces es el de hoy.
    const movido = num(mov[0]?.movido);

    const ab = await s.query<Record<string, unknown>>(SQL_ABIERTAS_EN, [login, desde, desde]);
    const posicionesAbiertas = ab[0] ? num(ab[0].n) : null;

    return {
      balance: Math.round((balanceHoy - movido) * 100) / 100,
      posicionesAbiertas,
      exacto: posicionesAbiertas === 0,
    };
  });
}
