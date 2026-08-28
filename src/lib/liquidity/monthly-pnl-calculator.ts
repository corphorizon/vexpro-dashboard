// ─────────────────────────────────────────────────────────────────────────────
// PnL mes a mes de una cuenta, desde que se conectó al módulo de Liquidez.
//
// ── DE DÓNDE SALE (y de dónde NO) ──────────────────────────────────────────
// De MySQL, tabla `mt5_deals`. NO de MongoDB: Orion es el CRM y no tiene
// ninguna colección de operaciones — se verificó listando sus 132 colecciones.
//
// ── LAS TRES TRAMPAS DE `mt5_deals`, YA RESUELTAS EN EL REPO ───────────────
// Se replican de `mt5-sync/pnl.ts` porque las tres fallan EN SILENCIO:
//
//   1. Se filtra por `TimeMsc` CONTRA FECHAS. `Timestamp` es FILETIME
//      (comparado contra un epoch devuelve la tabla entera, 68 millones de
//      filas «con cara de dato bueno») y `Time` no tiene índice (31 s por
//      consulta). Comparar `TimeMsc` contra un número devuelve CERO filas.
//   2. `Entry IN (1,3)` — la ganancia realizada vive en el deal de SALIDA.
//   3. `Action IN (0,1)` — sin esto, los depósitos (`Action = 2`) entran como
//      si fueran ganancia. Medido en el repo: suman 425 millones.
//
// El resultado es `Profit + Storage (swap) + Commission`: lo que efectivamente
// movió el saldo, no sólo el bruto de la operación.
// ─────────────────────────────────────────────────────────────────────────────

import { withMt5Connection, type Mt5Session } from '@/lib/api-integrations/mt5-sql/client';

export interface MonthlyPnl {
  year: number;
  month: number;
  pnl: number;
  operations_count: number;
  /** El mes no está completo: el de la conexión (arranca a mitad) y el actual. */
  is_partial: boolean;
}

/**
 * Una fila por mes. Se agrupa en SQL y no en memoria: traer las operaciones
 * una por una para contarlas acá sería mover hasta 25.000 filas por cuenta
 * cuando alcanzan siete.
 */
const SQL_POR_MES = [
  'SELECT YEAR(TimeMsc)  AS anio,',
  '       MONTH(TimeMsc) AS mes,',
  '       COUNT(*)       AS ops,',
  '       SUM(Profit)    AS profit,',
  '       SUM(Storage)   AS swap,',
  '       SUM(Commission) AS comision',
  '  FROM mt5_deals',
  ' WHERE Login = ?',
  '   AND Entry IN (1,3) AND Action IN (0,1)',
  '   AND TimeMsc >= ? AND TimeMsc < ?',
  ' GROUP BY anio, mes',
  ' ORDER BY anio, mes',
].join('\n');

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : 0;
};

/** `YYYY-MM-DD HH:MM:SS` en UTC, que es el formato que espera el SQL Export. */
function comoSql(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * PnL mes a mes desde `connectionDate` hasta hoy.
 *
 * Devuelve TODOS los meses del rango, incluidos los que no tuvieron
 * operaciones — con `pnl: 0` y `operations_count: 0`. Un mes ausente y un mes
 * en cero se ven iguales en una tabla, y significan cosas distintas: «no operó»
 * es un dato, «no lo calculamos» es una omisión.
 */
export async function calculateMonthlyPnL(
  companyId: string,
  mt5Account: string,
  connectionDate: Date,
): Promise<MonthlyPnl[]> {
  const login = Number(mt5Account);
  if (!Number.isFinite(login) || login <= 0) return [];

  const ahora = new Date();
  if (connectionDate > ahora) return [];

  // El rango arranca en la fecha exacta de conexión —no en el 1º del mes— para
  // no atribuirle a la cuenta lo que operó ANTES de entrar al pool. Ése es el
  // motivo de que el primer mes sea parcial.
  const desde = comoSql(connectionDate);
  // Fin exclusivo: el instante actual. Así el mes en curso queda hasta hoy.
  const hasta = comoSql(new Date(ahora.getTime() + 1000));

  const filas = await withMt5Connection(companyId, async (s: Mt5Session) =>
    s.query<Record<string, unknown>>(SQL_POR_MES, [login, desde, hasta]),
  );

  const porClave = new Map<string, { pnl: number; ops: number }>();
  for (const r of filas) {
    const y = num(r.anio);
    const m = num(r.mes);
    if (!y || !m) continue;
    porClave.set(`${y}-${m}`, {
      // Swap y comisión ya vienen con su signo desde MT5: se suman, no se restan.
      pnl: Math.round((num(r.profit) + num(r.swap) + num(r.comision)) * 100) / 100,
      ops: num(r.ops),
    });
  }

  // Recorrer el calendario y no las filas: así los meses sin operaciones
  // también salen, con cero explícito.
  const out: MonthlyPnl[] = [];
  const primerAnio = connectionDate.getUTCFullYear();
  const primerMes = connectionDate.getUTCMonth() + 1;
  const ultimoAnio = ahora.getUTCFullYear();
  const ultimoMes = ahora.getUTCMonth() + 1;

  let y = primerAnio;
  let m = primerMes;
  // Tope defensivo: sin él, una `connectionDate` corrupta (año 1970) haría
  // girar el bucle 600 veces y devolver una tabla sin sentido.
  const MAX_MESES = 240;
  for (let i = 0; i < MAX_MESES; i += 1) {
    const dato = porClave.get(`${y}-${m}`) ?? { pnl: 0, ops: 0 };
    out.push({
      year: y,
      month: m,
      pnl: dato.pnl,
      operations_count: dato.ops,
      // Parcial en los dos extremos: el mes de conexión arranca a mitad y el
      // mes actual todavía no terminó.
      is_partial:
        (y === primerAnio && m === primerMes && connectionDate.getUTCDate() > 1) ||
        (y === ultimoAnio && m === ultimoMes),
    });
    if (y === ultimoAnio && m === ultimoMes) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }

  return out;
}
