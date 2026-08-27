// ─────────────────────────────────────────────────────────────────────────────
// Diagnóstico operativo de una cuenta de trading (BROKER / SOCIAL / FUNDING).
//
// ── QUÉ RESPONDE ───────────────────────────────────────────────────────────
// «¿Cómo opera esta cuenta?» — y lo hace pasándole las MISMAS reglas que la
// revisión de prop firm, para que quien mira un retiro instantáneo no tenga
// que abrir MetaTrader y deducirlo a ojo.
//
// ── LA DIFERENCIA QUE HAY QUE TENER CLARA: ACÁ NO HAY REGLAMENTO ───────────
// En prop firm cada programa tiene un contrato: operar en 3 minutos con un
// mínimo de 5 ES una infracción, y el reglamento dice qué pasa. Una cuenta
// normal NO tiene reglamento — el cliente opera su propia plata y hace scalping
// si quiere. Nada de lo que se mide acá es «una infracción».
//
// Por eso el vocabulario cambia a propósito: son SEÑALES. Cada una describe un
// patrón que un humano querría mirar antes de soltar dinero, no un
// incumplimiento que se le pueda reclamar al cliente.
//
// ── Y NO TOCA EL SCORE DEL RETIRO ──────────────────────────────────────────
// El score de /risk/retiros está calibrado sobre 9.785 retiros resueltos, y ahí
// el trading se dejó como CONTEXTO a propósito: medido sobre 3.711 retiros
// decididos, «nunca operó» tuvo CERO rechazos. Esta señal vive aparte, se
// muestra al lado del score y no lo modifica. Cuando haya decisiones
// acumuladas se podrá medir si predice; recién entonces se discute integrarla.
//
// ── NO TODAS LAS SEÑALES CUENTAN PARA EL RIESGO ────────────────────────────
// Y eso se decidió MIDIENDO, no suponiendo. La primera versión contaba las
// siete por igual con umbral 4, y el resultado fue que el 72% de las cuentas
// que operan quedaba en «alto»: cinco de las siete señales se disparan en el
// 73-94% de las cuentas, porque describen a un trader retail normal, no a una
// anomalía. Ver SENALES_DE_RIESGO, que trae las frecuencias medidas.
//
// Las cinco comunes se siguen mostrando —son el diagnóstico operativo que se
// pidió— pero el riesgo sale sólo de las que discriminan.
// ─────────────────────────────────────────────────────────────────────────────

import { analyzeReport } from '@/lib/risk/rules';
import { DEFAULT_RULE_CONFIG } from '@/lib/risk/types';
import type { Trade } from '@/lib/risk/types';
import { mt5DateUtc, withMt5Connection, type Mt5Session } from '@/lib/api-integrations/mt5-sql/client';
import { computeDurationDistribution, WITHDRAWAL_REVIEW_BUCKETS } from '@/lib/risk/duration-distribution';

/** `Volume` viene en diezmilésimas de lote. Mismo divisor que exposición y prop firm. */
const LOTS_DIVISOR = 10_000;

/**
 * Techo de posiciones por cuenta.
 *
 * Emparejar entrada y salida por `PositionID` es caro porque esa columna NO
 * está en el índice: 60 cuentas tardan 16,7 s sobre las 68,4 M de filas
 * (medido — ver la cabecera de mt5-sync/behavior.ts). Y hay cuentas enormes:
 * una tiene 44.547 posiciones.
 *
 * Cuando se recorta se marca `truncated` y se emite un aviso. Un recorte
 * silencioso es indistinguible de «esta cuenta opera poco», que es justo la
 * conclusión opuesta a la verdadera.
 */
export const MAX_POSICIONES = 25_000;

/**
 * QUÉ SEÑALES CUENTAN PARA EL RIESGO — y por qué no todas.
 *
 * Medido el 2026-08-27 sobre las primeras 200 cuentas (120 con operaciones):
 *
 *   Operaciones de menos de 5 min      94%   ← describe, no alarma
 *   Grid / cobertura                   84%   ←
 *   Concentración >30% del beneficio   83%   ←
 *   Consistencia de lotes              73%   ←
 *   Martingala                         73%   ←
 *   Ventana de noticias                23%   ← discrimina
 *   Densidad sub-minuto (robot)        10%   ← discrimina
 *
 * Cinco de las siete se disparan en 73-94% de las cuentas. Eso no es una señal:
 * es la descripción de cómo opera un trader retail cualquiera. Las reglas
 * nacieron para prop firm, donde son cláusulas de un contrato que el trader se
 * CUIDA de no romper; un cliente con su propia plata no tiene ese contrato.
 *
 * Con las siete contando por igual, el 72% de las cuentas que operan quedaba en
 * «alto» — inservible para priorizar, que es justo para lo que existe.
 *
 * Así que las cinco comunes se siguen MOSTRANDO (son el diagnóstico operativo
 * que se pidió: cómo opera cada cuenta) pero NO cuentan para el riesgo. El
 * riesgo sale de las raras, que son las que separan una cuenta de las demás.
 *
 * Es el mismo criterio con el que el score de retiros descartó KYC y «dirección
 * compartida»: una señal que le pasa a casi todos no distingue a nadie.
 */
export const SENALES_DE_RIESGO = new Set(['hft', 'news_window', 'copy_trading']);

/**
 * Señales de riesgo en `fail` que hacen falta para cada nivel.
 *
 * Con tres señales contando (y dos de ellas a menudo sin comprobar), los
 * umbrales viejos —4 y 2— eran inalcanzables. Ahora: una llama la atención,
 * dos ya es un patrón.
 *
 * Siguen siendo una heurística: cuando haya decisiones acumuladas se podrá
 * medir si predicen, y recién ahí discutir integrarlas al score.
 */
export const RIESGO_ALTO = 2;
export const RIESGO_MEDIO = 1;

export type SignalStatus = 'pass' | 'fail' | 'unverifiable';
export type AccountRisk = 'ok' | 'medio' | 'alto';

export interface AccountSignal {
  id: string;
  label: string;
  status: SignalStatus;
  /** Qué se midió, en una línea legible. */
  detail: string;
  /** Operaciones que disparan la señal, cuando la señal las señala una a una. */
  offendingTrades: number;
  /** Sólo en `unverifiable`: por qué no se pudo. */
  whyNot?: string;
  /**
   * `true` = cuenta para el riesgo. `false` = describe cómo opera la cuenta,
   * pero no alarma. Ver SENALES_DE_RIESGO y sus mediciones.
   */
  countsForRisk: boolean;
}

export interface AccountFacts {
  positions: number;
  firstTradeAt: Date | null;
  lastTradeAt: Date | null;
  /** Resultado neto con swap y comisiones. */
  netResult: number;
  avgDurationSec: number | null;
  under1min: number;
  under5min: number;
  won: number;
  lost: number;
  lotsTotal: number;
  /** Caída máxima del saldo acumulado (sobre operaciones CERRADAS). */
  maxDrawdown: number;
  topSymbols: Array<{ symbol: string; positions: number; profit: number }>;
  durations: Array<{ label: string; count: number; profit: number }>;
}

export interface AccountReview {
  login: number;
  facts: AccountFacts;
  signals: AccountSignal[];
  /** Señales en estado `fail`. Es lo que deriva el riesgo. */
  flagged: number;
  unverifiable: number;
  risk: AccountRisk;
  truncated: boolean;
  warnings: string[];
}

/**
 * Operaciones cerradas de un conjunto de cuentas, emparejando entrada y salida
 * por `PositionID` — la misma forma que usa la revisión de prop firm.
 *
 * `TimeMsc` es DATETIME(6) e indexada. `Timestamp` es FILETIME (compararla
 * contra un epoch devuelve la tabla entera) y `Time` no tiene índice: las dos
 * obvias fallan sin dar error. Ver la cabecera de mt5-sync/pnl.ts.
 */
function sqlPosiciones(cuantas: number): string {
  const ph = Array.from({ length: cuantas }, () => '?').join(',');
  return [
    'SELECT Login, PositionID,',
    '       MIN(CASE WHEN Entry = 0 THEN TimeMsc END)      AS apertura,',
    '       MAX(CASE WHEN Entry IN (1,3) THEN TimeMsc END) AS cierre,',
    '       MAX(Symbol)                                     AS simbolo,',
    '       MAX(CASE WHEN Entry = 0 THEN Action END)        AS accion,',
    '       MAX(CASE WHEN Entry = 0 THEN Volume END)        AS volumen,',
    '       MAX(CASE WHEN Entry = 0 THEN Price END)         AS precio_ap,',
    '       MAX(CASE WHEN Entry IN (1,3) THEN Price END)    AS precio_ci,',
    '       SUM(Profit)                                     AS profit,',
    '       SUM(Storage)                                    AS swap,',
    '       SUM(Commission)                                 AS comision',
    '  FROM mt5_deals',
    ` WHERE Login IN (${ph}) AND PositionID > 0 AND Action IN (0,1)`,
    ' GROUP BY Login, PositionID',
    'HAVING apertura IS NOT NULL AND cierre IS NOT NULL',
    ' ORDER BY Login, apertura',
  ].join('\n');
}

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Trae las operaciones de TODA la vida de las cuentas indicadas, agrupadas por
 * login y en la forma que espera el motor de reglas.
 *
 * El alcance es toda la vida a propósito (decisión de Stiven, 2026-08-27): a
 * diferencia de prop firm, acá no hay «ciclo» que reinicie la cuenta.
 *
 * `logins` viene ya acotado por el llamador: esta función NO decide el alcance
 * porque el costo depende enteramente de cuántas cuentas se le pasen.
 */
export async function loadTradesByLogin(
  companyId: string,
  logins: number[],
): Promise<Map<number, Trade[]>> {
  const out = new Map<number, Trade[]>();
  if (logins.length === 0) return out;

  const filas = await withMt5Connection(companyId, async (s: Mt5Session) =>
    s.query<Record<string, unknown>>(sqlPosiciones(logins.length), logins),
  );

  for (const r of filas) {
    const login = num(r.Login);
    const apertura = mt5DateUtc(r.apertura);
    const cierre = mt5DateUtc(r.cierre);
    if (!login || !apertura || !cierre) continue;
    let arr = out.get(login);
    if (!arr) { arr = []; out.set(login, arr); }
    // El techo se aplica ACÁ y no en SQL: un LIMIT sobre un GROUP BY de varias
    // cuentas recortaría cuentas enteras en vez de acotar las grandes.
    if (arr.length >= MAX_POSICIONES) continue;
    arr.push({
      // DESDE CERO: `ruleGrid` y `ruleMartingala` hacen `trades[t.index]`, así
      // que `index` TIENE que ser la posición en el array. Ver types.ts.
      index: arr.length,
      position: num(r.PositionID),
      symbol: String(r.simbolo ?? '—'),
      // `Action` 0 = compra, 1 = venta. Es la acción de la ENTRADA.
      type: num(r.accion) === 0 ? 'buy' : 'sell',
      volume: num(r.volumen) / LOTS_DIVISOR,
      openPrice: num(r.precio_ap),
      closePrice: num(r.precio_ci),
      sl: null,
      tp: null,
      openTime: apertura,
      closeTime: cierre,
      commission: num(r.comision),
      swap: num(r.swap),
      profit: num(r.profit),
      durationMinutes: (cierre.getTime() - apertura.getTime()) / 60_000,
    });
  }
  return out;
}

/** Caída máxima del saldo acumulado, recorrido en orden de CIERRE. */
function caidaMaxima(trades: Trade[]): number {
  const porCierre = [...trades].sort((a, b) => a.closeTime.getTime() - b.closeTime.getTime());
  let acumulado = 0, pico = 0, peor = 0;
  for (const t of porCierre) {
    acumulado += t.profit + t.swap + t.commission;
    if (acumulado > pico) pico = acumulado;
    const caida = pico - acumulado;
    if (caida > peor) peor = caida;
  }
  return Math.round(peor * 100) / 100;
}

function hechos(trades: Trade[]): AccountFacts {
  const n = trades.length;
  const porSimbolo = new Map<string, { positions: number; profit: number }>();
  let lots = 0, under1 = 0, under5 = 0, won = 0, lost = 0, neto = 0, durSum = 0;
  let first: Date | null = null, last: Date | null = null;

  for (const t of trades) {
    const s = porSimbolo.get(t.symbol) ?? { positions: 0, profit: 0 };
    s.positions += 1;
    s.profit += t.profit;
    porSimbolo.set(t.symbol, s);
    lots += t.volume;
    const seg = t.durationMinutes * 60;
    durSum += seg;
    if (seg < 60) under1 += 1;
    if (seg < 300) under5 += 1;
    neto += t.profit + t.swap + t.commission;
    if (t.profit > 0) won += 1;
    else if (t.profit < 0) lost += 1;
    if (!first || t.openTime < first) first = t.openTime;
    if (!last || t.closeTime > last) last = t.closeTime;
  }

  return {
    positions: n,
    firstTradeAt: first,
    lastTradeAt: last,
    netResult: Math.round(neto * 100) / 100,
    avgDurationSec: n > 0 ? Math.round(durSum / n) : null,
    under1min: under1,
    under5min: under5,
    won,
    lost,
    lotsTotal: Math.round(lots * 100) / 100,
    maxDrawdown: caidaMaxima(trades),
    topSymbols: [...porSimbolo.entries()]
      .map(([symbol, v]) => ({ symbol, positions: v.positions, profit: Math.round(v.profit * 100) / 100 }))
      .sort((a, b) => b.positions - a.positions)
      .slice(0, 5),
    durations: computeDurationDistribution(trades, WITHDRAWAL_REVIEW_BUCKETS).buckets
      .map((b) => ({ label: b.label, count: b.count, profit: b.profitTotal })),
  };
}

/**
 * Evalúa una cuenta: hechos + señales.
 *
 * `noticias` es opcional. Si no llegan, la señal de noticias queda
 * `unverifiable` en vez de darse por cumplida — no tener el calendario a mano
 * no es evidencia de que el cliente no operó contra una noticia.
 *
 * `sincronizadas` igual: sin el cálculo cruzado entre cuentas, la señal de
 * copia queda sin comprobar. Nunca se da por limpia.
 */
export function evaluateAccount(
  login: number,
  trades: Trade[],
  opts: {
    noticias?: Array<{ at: number; name: string; currency: string | null }> | null;
    sincronizadas?: Array<{ otroLogin: number; cobertura: number; coincidencias: number; retrasoMedianoSeg: number }> | null;
    truncated?: boolean;
  } = {},
): AccountReview {
  const warnings: string[] = [];
  const facts = hechos(trades);
  const signals: AccountSignal[] = [];

  if (opts.truncated) {
    warnings.push(
      `La cuenta supera las ${MAX_POSICIONES} posiciones: se analizaron las primeras. Las señales son de esa parte, no de toda la cuenta.`,
    );
  }

  // Sin operaciones no hay nada que decir — y decirlo importa: «no operó» es un
  // dato, no una señal en contra. Medido sobre 3.711 retiros decididos, «nunca
  // operó» tuvo CERO rechazos.
  if (trades.length === 0) {
    return {
      login,
      facts,
      signals: [],
      flagged: 0,
      unverifiable: 0,
      risk: 'ok',
      truncated: Boolean(opts.truncated),
      warnings: [...warnings, 'La cuenta no tiene operaciones cerradas.'],
    };
  }

  // ── Las cinco del motor existente, con la configuración por defecto ──────
  // Para una cuenta normal no hay reglamento del que sacar los parámetros, así
  // que se usan los del motor (5 min, lotes ×0,25–×2, 30% de concentración,
  // grid 3, martingala 5). Son el punto de comparación, no un contrato.
  const totalProfit = trades.reduce((s, t) => s + t.profit, 0);
  const motor = analyzeReport(
    {
      trades,
      metadata: { traderName: '', accountNumber: String(login), broker: '', period: '', totalNetProfit: totalProfit },
    },
    DEFAULT_RULE_CONFIG,
  );
  const etiquetas: Record<string, string> = {
    consistencia: 'Consistencia de lotes (×0,25 a ×2,00 del promedio)',
    profitPct: 'Concentración: una operación supera el 30% del beneficio',
    tiempoMin: 'Operaciones de menos de 5 minutos',
    grid: 'Grid / cobertura',
    martingala: 'Martingala',
  };
  for (const r of motor.ruleResults) {
    if (r.status === 'skipped') continue;
    const n = r.violations.length;
    signals.push({
      id: r.ruleName,
      label: etiquetas[r.ruleName] ?? r.displayName,
      status: r.status === 'fail' ? 'fail' : 'pass',
      detail: n > 0
        ? `${n} de ${trades.length} operaciones (${r.violationPct.toFixed(1)}%)`
        : `${trades.length} operaciones, ninguna dispara la señal`,
      offendingTrades: n,
      countsForRisk: SENALES_DE_RIESGO.has(r.ruleName),
    });
  }

  // ── Densidad de operaciones de menos de un minuto ────────────────────────
  // No es una prueba de HFT: separa operador manual de automático. Y un robot
  // NO implica abuso — hay clientes que operan así legítimamente.
  const pct = (facts.under1min / trades.length) * 100;
  signals.push({
    id: 'hft',
    label: 'Densidad de operaciones de menos de un minuto',
    status: pct > 50 ? 'fail' : 'pass',
    detail: `${facts.under1min} de ${trades.length} (${pct.toFixed(1)}%) duran menos de un minuto`
      + (pct > 50 ? ' — señal de sistema automático, mirar a mano' : ''),
    offendingTrades: facts.under1min,
    countsForRisk: true,
  });

  // ── Ventana de noticias de alto impacto ─────────────────────────────────
  if (opts.noticias && opts.noticias.length > 0) {
    const ventana = 5 * 60_000;
    let infractoras = 0;
    const ejemplos: string[] = [];
    for (const t of trades) {
      // Se cruza la MONEDA con el símbolo: un dato de empleo de EE.UU. mueve
      // los pares con USD, no un sintético como Boom 1000. Sin ese cruce,
      // media jornada sería zona prohibida.
      const cerca = opts.noticias.find((nt) => {
        if (!nt.currency) return false;
        if (!t.symbol.toUpperCase().includes(nt.currency.toUpperCase())) return false;
        const dt = Math.min(
          Math.abs(t.openTime.getTime() - nt.at),
          Math.abs(t.closeTime.getTime() - nt.at),
        );
        return dt <= ventana;
      });
      if (cerca) {
        infractoras += 1;
        if (ejemplos.length < 3) ejemplos.push(`${t.symbol} · ${cerca.name}`);
      }
    }
    signals.push({
      id: 'news_window',
      label: 'Opera dentro de ±5 min de noticias de alto impacto',
      status: infractoras > 0 ? 'fail' : 'pass',
      detail: infractoras > 0
        ? `${infractoras} operación(es): ${ejemplos.join(' · ')}`
        : `Ninguna cerca de las ${opts.noticias.length} noticias del período`,
      offendingTrades: infractoras,
      countsForRisk: true,
    });
  } else {
    signals.push({
      id: 'news_window',
      label: 'Opera dentro de ±5 min de noticias de alto impacto',
      status: 'unverifiable',
      detail: 'No se comprobó',
      offendingTrades: 0,
      countsForRisk: true,
      whyNot: 'No se cargó el calendario económico del período.',
    });
  }

  // ── Copia entre cuentas ─────────────────────────────────────────────────
  if (opts.sincronizadas) {
    const fuertes = opts.sincronizadas.filter((p) => p.cobertura >= 0.6);
    signals.push({
      id: 'copy_trading',
      label: 'Opera sincronizada con otras cuentas',
      status: fuertes.length > 0 ? 'fail' : 'pass',
      detail: fuertes.length > 0
        // El retraso es lo que hay que leer: un humano no hace clic con medio
        // segundo de diferencia en dos cuentas separadas.
        ? `Sincronizada con ${fuertes.length} cuenta(s): ` + fuertes.slice(0, 3)
          .map((p) => `${p.otroLogin} (${Math.round(p.cobertura * 100)}%, retraso ~${p.retrasoMedianoSeg}s)`)
          .join(' · ')
        : 'Ninguna cuenta opera sincronizada con ésta',
      offendingTrades: fuertes.reduce((a, p) => a + p.coincidencias, 0),
      countsForRisk: true,
    });
  } else {
    signals.push({
      id: 'copy_trading',
      label: 'Opera sincronizada con otras cuentas',
      status: 'unverifiable',
      detail: 'No se comprobó',
      offendingTrades: 0,
      countsForRisk: true,
      whyNot: 'La detección de copia necesita las aperturas de todas las cuentas del período.',
    });
  }

  // Sólo las que discriminan. Ver SENALES_DE_RIESGO.
  const flagged = signals.filter((s) => s.status === 'fail' && s.countsForRisk).length;
  const unverifiable = signals.filter((s) => s.status === 'unverifiable').length;
  const risk: AccountRisk =
    flagged >= RIESGO_ALTO ? 'alto' : flagged >= RIESGO_MEDIO ? 'medio' : 'ok';

  return {
    login,
    facts,
    signals,
    flagged,
    unverifiable,
    risk,
    truncated: Boolean(opts.truncated),
    warnings,
  };
}

/**
 * ¿Operó DESPUÉS de pedir el retiro?
 *
 * Se resuelve al LEER, contra el `last_trade_at` guardado de la cuenta: es
 * exacto, no cuesta nada, y así el diagnóstico almacenado sigue siendo de la
 * CUENTA — no hay que recalcularlo por cada retiro del mismo cliente.
 *
 * En prop firm esto provoca rechazo automático (T&C 11). Acá no hay contrato
 * que lo prohíba, pero sigue siendo de lo más informativo que se puede mirar:
 * es objetivo e imposible de ver a ojo en un export de MetaTrader.
 *
 * Devuelve `null` cuando falta algún dato: «no lo sabemos» y «no operó» son
 * cosas distintas.
 */
export function tradedAfterRequest(
  lastTradeAt: Date | string | null,
  requestedAt: Date | string | null,
): boolean | null {
  if (!lastTradeAt || !requestedAt) return null;
  const last = lastTradeAt instanceof Date ? lastTradeAt : new Date(lastTradeAt);
  const req = requestedAt instanceof Date ? requestedAt : new Date(requestedAt);
  if (Number.isNaN(last.getTime()) || Number.isNaN(req.getTime())) return null;
  return last.getTime() > req.getTime();
}
