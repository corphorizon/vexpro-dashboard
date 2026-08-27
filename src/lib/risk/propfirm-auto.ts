// ─────────────────────────────────────────────────────────────────────────────
// Revisión automática de un retiro de prop firm.
//
// ── QUÉ CAMBIA RESPECTO DE HOY ─────────────────────────────────────────────
// Hoy alguien exporta el historial de MT5, lo sube como archivo y mira cinco
// reglas. Los 304 retiros de prop firm traen `loginAccount`, así que las
// operaciones las podemos traer nosotros: la subida sobra.
//
// El motor de reglas NO se toca. `analyzeReport` sigue siendo el mismo y sigue
// recibiendo la misma forma; lo único que cambia es de dónde salen las
// operaciones. Las reglas que ese motor no cubre —operar después de pedir el
// retiro, fines de semana, días mínimos, ganancia mínima— se evalúan acá.
//
// ── LA REGLA QUE MÁS IMPORTA Y QUE NADIE MIRA ──────────────────────────────
// Operar DESPUÉS de solicitar el retiro provoca el rechazo automático (T&C
// 11). Es objetiva, no admite deducción, y es imposible de ver a ojo en un
// export de MT5 porque hay que cruzar la hora de la solicitud con la de cada
// operación. Es la que más gana con automatizarse.
//
// ── LO QUE ESTE MÓDULO NO HACE ─────────────────────────────────────────────
// No aprueba ni rechaza nada. Devuelve qué reglas se cumplen, cuáles no y
// cuáles NO SE PUDIERON COMPROBAR. Esa tercera categoría existe a propósito:
// varias reglas del reglamento necesitan datos que no tenemos, y mostrarlas
// como "cumple" afirmaría un cumplimiento que nadie verificó.
// ─────────────────────────────────────────────────────────────────────────────

import { withMt5Connection, type Mt5Session } from '@/lib/api-integrations/mt5-sql/client';
import { analyzeReport } from '@/lib/risk/rules';
import type { Trade, RuleConfig } from '@/lib/risk/types';
import { rulesForProgram, type ProgramRules, type CheckId, type RuleSpec } from '@/lib/risk/programs';
import { computeDurationDistribution, WITHDRAWAL_REVIEW_BUCKETS } from '@/lib/risk/duration-distribution';

/** `Volume` viene en diezmilésimas de lote. Mismo divisor que la exposición. */
const LOTS_DIVISOR = 10_000;

/**
 * Operaciones cerradas de una cuenta, emparejando entrada y salida por
 * `PositionID` — igual que el módulo de comportamiento.
 *
 * `TimeMsc` es DATETIME(6) e indexada; `Timestamp` es FILETIME y `Time` no
 * tiene índice. Ver la cabecera de mt5-sync/pnl.ts: las dos obvias fallan sin
 * dar error.
 */
const SQL_POSICIONES = [
  'SELECT PositionID,',
  '       MIN(CASE WHEN Entry = 0 THEN TimeMsc END)        AS apertura,',
  '       MAX(CASE WHEN Entry IN (1,3) THEN TimeMsc END)   AS cierre,',
  '       MAX(Symbol)                                       AS simbolo,',
  '       MAX(CASE WHEN Entry = 0 THEN Action END)          AS acccion,',
  '       MAX(CASE WHEN Entry = 0 THEN Volume END)          AS volumen,',
  '       MAX(CASE WHEN Entry = 0 THEN Price END)           AS precio_ap,',
  '       MAX(CASE WHEN Entry IN (1,3) THEN Price END)      AS precio_ci,',
  '       SUM(Profit)                                       AS profit,',
  '       SUM(Storage)                                      AS swap,',
  '       SUM(Commission)                                   AS comision',
  '  FROM mt5_deals',
  ' WHERE Login = ? AND PositionID > 0 AND Action IN (0,1)',
  ' GROUP BY PositionID',
  'HAVING apertura IS NOT NULL AND cierre IS NOT NULL',
  ' ORDER BY apertura',
].join('\n');

/**
 * Operaciones de SALDO de la cuenta: creación y pagos de retiro.
 *
 * ── POR QUÉ IMPORTAN MÁS QUE NINGUNA OTRA COSA ──────────────────────────────
 * Cuando se aprueba un retiro, la cuenta vuelve al balance inicial y empieza un
 * ciclo nuevo (Kevin, 2026-08-27). La revisión siguiente SÓLO puede mirar lo
 * operado desde ese reinicio.
 *
 * Sin esto, a un cliente en su tercer retiro se lo juzgaría con las operaciones
 * de los ciclos uno y dos — que ya se revisaron y ya se le pagaron. Y no daría
 * ningún error: daría un informe con más operaciones de las que corresponden y
 * con infracciones que ya estaban saldadas.
 *
 * El reinicio está DENTRO de MT5, no hay que inferirlo desde Orion:
 *   `ACC-CREATED 150130`            → la cuenta se creó
 *   `Withdrawal trx: 950d4b02964e`  → se pagó un retiro
 * `Action = 2` son las operaciones de saldo (depósitos, retiros, crédito).
 */
const SQL_SALDO = [
  'SELECT TimeMsc AS cuando, Profit AS importe, Comment AS comentario',
  '  FROM mt5_deals',
  ' WHERE Login = ? AND Action = 2',
  ' ORDER BY TimeMsc',
].join('\n');

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : 0;
};

const fecha = (v: unknown): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

export interface PropfirmWithdrawal {
  withdrawId: string;
  login: number;
  username: string | null;
  userEmail: string | null;
  programName: string | null;
  requestedAmount: number;
  requestedDate: Date;
}

export type CheckStatus = 'pass' | 'fail' | 'unverifiable';

export interface CheckResult {
  id: CheckId;
  label: string;
  status: CheckStatus;
  /** Qué se midió, en una línea legible. */
  detail: string;
  /** Operaciones que incumplen, cuando la regla las señala una a una. */
  offendingTrades: number;
  /** Sólo en `unverifiable`: por qué no se pudo. */
  whyNot?: string;
}

export interface CycleFacts {
  /**
   * Caída máxima del ciclo, en dinero: la mayor distancia entre un pico del
   * saldo acumulado y el valle posterior.
   *
   * ── NO ES EL DRAWDOWN DEL CRM, Y LA DIFERENCIA IMPORTA ──────────────────
   * Esto se calcula con operaciones CERRADAS, o sea sobre el saldo. El CRM
   * mide sobre el EQUITY, que incluye lo flotante de las posiciones abiertas
   * — y por eso el suyo siempre será igual o mayor que este.
   *
   * El que decide si la cuenta se descalifica es el del CRM. Este es para
   * mirar, y por eso se informa en vez de compararse contra un límite.
   */
  maxDrawdown: number;
  /** La misma caída como % del capital del programa, si se conoce. */
  maxDrawdownPct: number | null;
  /** Capital del programa (Orion `userpropfirms.accountBalance`). */
  accountSize: number | null;
  /** Resultado neto del ciclo, con swap y comisiones. */
  netResult: number;
  /** Reparto de duraciones con los tramos de la revisión. */
  durations: Array<{ label: string; count: number; profit: number }>;
}

export interface WithdrawalReview {
  withdrawal: PropfirmWithdrawal;
  program: ProgramRules | null;
  trades: number;
  checks: CheckResult[];
  /** Reglas incumplidas. El reglamento cuenta VIOLACIONES, no operaciones. */
  violations: number;
  /** Reglas que no se pudieron comprobar. Ver la cabecera. */
  unverifiable: number;
  /** Datos del ciclo para que los lea una persona. No son reglas. */
  facts: CycleFacts;
  /** Cuándo arrancó el ciclo y qué lo arrancó. */
  cycle: { startedAt: Date | null; startedBy: string; excludedTrades: number };
  /** Lo que el reglamento dice que pasa con ese número de violaciones. */
  outcome: 'ok' | 'denied_new_period' | 'denied_no_new_period' | 'cannot_review';
  warnings: string[];
}

export interface AccountCycle {
  /** Operaciones del ciclo VIGENTE, no de toda la vida de la cuenta. */
  trades: Trade[];
  /** Cuándo arrancó el ciclo: la creación, o el último retiro pagado. */
  startedAt: Date | null;
  /** Qué lo arrancó, para poder mostrarlo. */
  startedBy: 'creacion' | 'retiro_pagado' | 'desconocido';
  /** Operaciones que quedaron FUERA por ser de ciclos anteriores. */
  excludedFromPreviousCycles: number;
}

/**
 * Trae las operaciones del CICLO VIGENTE y las pasa a la forma del motor.
 *
 * Ver `SQL_SALDO`: el ciclo arranca en el último pago de retiro, o en la
 * creación de la cuenta si todavía no cobró ninguno.
 */
export async function loadCycleFromMt5(
  companyId: string,
  login: number,
): Promise<AccountCycle> {
  const { filas, saldo } = await withMt5Connection(companyId, async (s: Mt5Session) => ({
    filas: await s.query<Record<string, unknown>>(SQL_POSICIONES, [login]),
    saldo: await s.query<Record<string, unknown>>(SQL_SALDO, [login]),
  }));

  // El último retiro pagado manda; si no hubo, la creación de la cuenta.
  let startedAt: Date | null = null;
  let startedBy: AccountCycle['startedBy'] = 'desconocido';
  for (const m of saldo) {
    const cuando = fecha(m.cuando);
    if (!cuando) continue;
    const comentario = String(m.comentario ?? '');
    if (/withdraw/i.test(comentario)) { startedAt = cuando; startedBy = 'retiro_pagado'; }
    else if (/ACC-CREATED/i.test(comentario) && !startedAt) { startedAt = cuando; startedBy = 'creacion'; }
  }

  const trades: Trade[] = [];
  let excluidas = 0;
  for (const r of filas) {
    const apertura = fecha(r.apertura);
    const cierre = fecha(r.cierre);
    if (!apertura || !cierre) continue;
    // Del ciclo anterior: ya se revisó y ya se pagó.
    if (startedAt && apertura < startedAt) { excluidas += 1; continue; }
    const i = trades.length;
    trades.push({
      // DESDE CERO, no desde uno: `ruleGrid` hace `trades[t.index]`, así que
      // `index` TIENE que ser la posición en el array. Numerar desde 1 no da
      // error — devuelve la operación equivocada en cada violación y
      // `undefined` en la última. Ver el comentario en types.ts.
      index: i,
      position: num(r.PositionID),
      symbol: String(r.simbolo ?? '—'),
      // `Action` 0 = compra, 1 = venta. Es la acción de la ENTRADA.
      type: num(r.acccion) === 0 ? 'buy' : 'sell',
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
  return { trades, startedAt, startedBy, excludedFromPreviousCycles: excluidas };
}

/** El reglamento del programa traducido a la config que espera `analyzeReport`. */
function configFor(program: ProgramRules): RuleConfig {
  const p = (id: CheckId): RuleSpec | undefined => program.rules.find((r) => r.id === id);
  const dur = p('min_duration');
  const cons = p('lot_consistency');
  const conc = p('profit_concentration');
  const grid = p('grid');
  const mart = p('martingale');
  return {
    // `enabled: false` cuando el programa NO tiene la regla — que es el caso
    // de X12, donde grid y martingala están PERMITIDOS. Aplicárselas sería
    // inventar infracciones que el cliente compró el derecho a no tener.
    consistencia: {
      enabled: Boolean(cons),
      factorMin: cons?.params?.factorMin ?? 0.25,
      factorMax: cons?.params?.factorMax ?? 2,
    },
    profitPct: { enabled: Boolean(conc), pct: conc?.params?.maxPct ?? 30 },
    tiempoMin: { enabled: Boolean(dur), minutos: dur?.params?.minutos ?? 5 },
    grid: { enabled: Boolean(grid), minGrid: grid?.params?.minSimultaneas ?? 3 },
    martingala: { enabled: Boolean(mart), gapMaximo: mart?.params?.gapMaximo ?? 5 },
  };
}

/**
 * Caída máxima del saldo acumulado dentro del ciclo.
 *
 * Se recorre el resultado acumulado operación a operación —en orden de
 * CIERRE, que es cuando el saldo se mueve— y se guarda la mayor distancia
 * entre un pico y el valle que le sigue.
 */
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

/** Días distintos en los que hubo al menos un cierre. */
function diasOperados(trades: Trade[]): number {
  return new Set(trades.map((t) => t.closeTime.toISOString().slice(0, 10))).size;
}

export function evaluateWithdrawal(
  w: PropfirmWithdrawal,
  cycle: AccountCycle,
  /** `userpropfirms.accountBalance` de Orion. Viene en las 280 cuentas activas. */
  accountSize: number | null = null,
  /**
   * Noticias de ALTO impacto del período, del calendario de MetaQuotes.
   * Si no se pasan, la regla queda como "no comprobada" en vez de darse por
   * cumplida — no tener el calendario a mano no es evidencia de nada.
   */
  noticias: Array<{ at: number; name: string; currency: string | null }> | null = null,
): WithdrawalReview {
  const warnings: string[] = [];
  const trades = cycle.trades;
  const program = rulesForProgram(w.programName);

  const caida = caidaMaxima(trades);
  const facts: CycleFacts = {
    maxDrawdown: caida,
    maxDrawdownPct: accountSize && accountSize > 0
      ? Math.round((caida / accountSize) * 10_000) / 100
      : null,
    accountSize,
    netResult: Math.round(trades.reduce((a, t) => a + t.profit + t.swap + t.commission, 0) * 100) / 100,
    durations: computeDurationDistribution(trades, WITHDRAWAL_REVIEW_BUCKETS).buckets
      .map((b) => ({ label: b.label, count: b.count, profit: b.profitTotal })),
  };
  const cicloInfo = {
    startedAt: cycle.startedAt,
    startedBy: cycle.startedBy,
    excludedTrades: cycle.excludedFromPreviousCycles,
  };

  if (!program) {
    // Sin reglamento no se inventa uno: aplicarle a un programa desconocido
    // las reglas de otro produce infracciones falsas.
    warnings.push(
      `El programa «${w.programName ?? '—'}» no está en el registro de reglamentos: no se puede revisar.`,
    );
    return {
      withdrawal: w, program: null, trades: trades.length, checks: [],
      violations: 0, unverifiable: 0, outcome: 'cannot_review', warnings,
      facts, cycle: cicloInfo,
    };
  }

  const checks: CheckResult[] = [];
  const tieneRegla = (id: CheckId) => program.rules.find((r) => r.id === id);

  // ── Las cinco del motor existente, con los parámetros del programa ───────
  const totalProfit = trades.reduce((s, t) => s + t.profit, 0);
  const motor = analyzeReport(
    { trades, metadata: { traderName: w.username ?? '', accountNumber: String(w.login), broker: '', period: '', totalNetProfit: totalProfit } },
    configFor(program),
  );
  const mapa: Record<string, CheckId> = {
    consistencia: 'lot_consistency', profitPct: 'profit_concentration',
    tiempoMin: 'min_duration', grid: 'grid', martingala: 'martingale',
  };
  for (const r of motor.ruleResults) {
    const id = mapa[r.ruleName];
    const spec = id ? tieneRegla(id) : undefined;
    // Una regla que el programa NO tiene no se reporta: no es que la cumpla,
    // es que no le aplica.
    if (!spec || r.status === 'skipped') continue;
    checks.push({
      id: id!,
      label: spec.label,
      status: r.status === 'fail' ? 'fail' : 'pass',
      detail: r.violations.length > 0
        ? `${r.violations.length} de ${trades.length} operaciones (${r.violationPct.toFixed(1)}%)`
        : `${trades.length} operaciones, ninguna incumple`,
      offendingTrades: r.violations.length,
    });
  }

  // ── Operar DESPUÉS de solicitar el retiro (T&C 11) ──────────────────────
  if (tieneRegla('trades_after_request')) {
    const posteriores = trades.filter((t) => t.openTime > w.requestedDate);
    checks.push({
      id: 'trades_after_request',
      label: tieneRegla('trades_after_request')!.label,
      status: posteriores.length > 0 ? 'fail' : 'pass',
      detail: posteriores.length > 0
        ? `${posteriores.length} operación(es) abiertas tras la solicitud — rechazo automático`
        : 'Ninguna operación después de la solicitud',
      offendingTrades: posteriores.length,
    });
  }

  // ── Fin de semana ────────────────────────────────────────────────────────
  const finde = tieneRegla('weekend');
  if (finde) {
    // Se mira la APERTURA: una posición abierta el viernes y cerrada el lunes
    // no es "operar el fin de semana", es dejarla corriendo.
    const enFinde = trades.filter((t) => [0, 6].includes(t.openTime.getUTCDay()));
    checks.push({
      id: 'weekend', label: finde.label,
      status: enFinde.length > 0 ? 'fail' : 'pass',
      detail: enFinde.length > 0 ? `${enFinde.length} operación(es) abiertas en sábado o domingo` : 'Ninguna apertura en fin de semana',
      offendingTrades: enFinde.length,
    });
  }

  // ── Ventana de noticias de alto impacto ─────────────────────────────────
  const noticiaSpec = tieneRegla('news_window');
  if (noticiaSpec && noticias) {
    const ventana = (noticiaSpec.params?.minutos ?? 5) * 60_000;
    const infractoras: string[] = [];
    for (const t of trades) {
      // ── POR QUÉ SE CRUZA LA MONEDA CON EL SÍMBOLO ─────────────────────
      // Un dato de empleo de Estados Unidos mueve los pares con USD; no mueve
      // un índice sintético como Boom 1000, que no responde a la economía
      // real. Marcar TODAS las operaciones alrededor de cada noticia
      // convertiría media jornada en zona prohibida y llenaría el informe de
      // infracciones que nadie va a sostener frente al cliente.
      //
      // El cruce es un heurístico: se mira si el símbolo contiene el código de
      // la moneda. EURUSD contra una noticia de USD, sí; Boom 1000 Index, no.
      const cerca = noticias.find((n) => {
        if (!n.currency) return false;
        if (!t.symbol.toUpperCase().includes(n.currency.toUpperCase())) return false;
        const dt = Math.min(
          Math.abs(t.openTime.getTime() - n.at),
          Math.abs(t.closeTime.getTime() - n.at),
        );
        return dt <= ventana;
      });
      if (cerca) infractoras.push(`#${t.index} ${t.symbol} · ${cerca.name}`);
    }
    checks.push({
      id: 'news_window',
      label: noticiaSpec.label,
      status: infractoras.length > 0 ? 'fail' : 'pass',
      detail: infractoras.length > 0
        ? `${infractoras.length} operación(es) dentro de ±5 min de una noticia de alto impacto: ${infractoras.slice(0, 3).join(' · ')}`
        : `Ninguna operación cerca de las ${noticias.length} noticias de alto impacto del período`,
      offendingTrades: infractoras.length,
    });
  }

  // ── Días desde la primera operación ─────────────────────────────────────
  const desdePrimera = tieneRegla('days_since_first_trade');
  if (desdePrimera && trades.length > 0) {
    const primera = trades.reduce((a, t) => (t.openTime < a ? t.openTime : a), trades[0].openTime);
    const dias = Math.floor((w.requestedDate.getTime() - primera.getTime()) / 86_400_000);
    const exigidos = desdePrimera.params?.dias ?? 30;
    checks.push({
      id: 'days_since_first_trade', label: desdePrimera.label,
      status: dias >= exigidos ? 'pass' : 'fail',
      detail: `${dias} días desde la primera operación (${primera.toISOString().slice(0, 10)}), exige ${exigidos}`,
      offendingTrades: 0,
    });
  }

  // ── Días operados ────────────────────────────────────────────────────────
  const minDias = tieneRegla('min_trading_days');
  if (minDias) {
    const d = diasOperados(trades);
    const exigidos = minDias.params?.dias ?? 0;
    checks.push({
      id: 'min_trading_days', label: minDias.label,
      status: d >= exigidos ? 'pass' : 'fail',
      detail: `${d} días con operaciones cerradas, exige ${exigidos}`,
      offendingTrades: 0,
    });
  }

  // ── HFT por densidad ─────────────────────────────────────────────────────
  const hft = tieneRegla('hft');
  if (hft && trades.length > 0) {
    const bajoUnMinuto = trades.filter((t) => t.durationMinutes < 1).length;
    const pct = (bajoUnMinuto / trades.length) * 100;
    const techo = hft.params?.maxSubMinutePct ?? 50;
    checks.push({
      id: 'hft', label: hft.label,
      status: pct > techo ? 'fail' : 'pass',
      // No es una prueba de HFT: el reglamento no lo define formalmente. Es una
      // señal para que mire una persona, y el texto lo dice.
      detail: `${bajoUnMinuto} de ${trades.length} operaciones (${pct.toFixed(1)}%) duran menos de un minuto${pct > techo ? ' — señal de sistema automático, revisar a mano' : ''}`,
      offendingTrades: bajoUnMinuto,
    });
  }

  // ── Las que NO se pueden comprobar ──────────────────────────────────────
  for (const spec of program.rules.filter((r) => !r.checkable)) {
    checks.push({
      id: spec.id, label: spec.label, status: 'unverifiable',
      detail: 'No se comprobó', offendingTrades: 0, whyNot: spec.whyNot,
    });
  }

  // ── RED CONTRA LA OMISIÓN SILENCIOSA ────────────────────────────────────
  // Una regla declarada en el reglamento para la que nadie escribió su
  // evaluación NO puede simplemente no aparecer. Pasó al escribir esto:
  // `min_profit_pct` estaba en el registro, no tenía rama, y desaparecía del
  // informe — que se lee como "no aplica" cuando en realidad es "no se miró".
  //
  // Es el mismo fallo que dejó una pestaña vacía con 167 retiros del otro
  // lado: el dato existía y el camino para mostrarlo no. Acá se cierra por
  // construcción: lo que el reglamento declara, o se evalúa, o sale marcado.
  const evaluadas = new Set(checks.map((c) => c.id));
  for (const spec of program.rules) {
    if (evaluadas.has(spec.id)) continue;
    checks.push({
      id: spec.id,
      label: spec.label,
      status: 'unverifiable',
      detail: 'No se comprobó',
      offendingTrades: 0,
      whyNot:
        spec.whyNot ??
        'La regla está en el reglamento pero el motor todavía no la evalúa. No es que se cumpla: es que nadie la miró.',
    });
  }

  const violations = checks.filter((c) => c.status === 'fail').length;
  const unverifiable = checks.filter((c) => c.status === 'unverifiable').length;

  // Operar tras la solicitud rechaza SOLO, sin contar violaciones (T&C 11).
  const operoDespues = checks.some((c) => c.id === 'trades_after_request' && c.status === 'fail');

  const outcome: WithdrawalReview['outcome'] =
    operoDespues || violations >= 4 ? 'denied_no_new_period'
      : violations >= 3 ? 'denied_new_period'
        : 'ok';

  if (trades.length === 0) {
    warnings.push('La cuenta no tiene operaciones cerradas en MetaTrader: no hay nada que revisar.');
  }
  if (unverifiable > 0) {
    warnings.push(`${unverifiable} regla(s) del reglamento NO se pudieron comprobar con los datos disponibles.`);
  }

  if (cycle.excludedFromPreviousCycles > 0) {
    warnings.push(
      `${cycle.excludedFromPreviousCycles} operación(es) quedaron fuera por ser de ciclos anteriores ` +
      `(el ciclo arrancó el ${cycle.startedAt?.toISOString().slice(0, 10)} por ${cycle.startedBy === 'retiro_pagado' ? 'un retiro pagado' : 'la creación de la cuenta'}).`,
    );
  }
  if (!cycle.startedAt) {
    // Sin marca de inicio no se sabe qué es "este ciclo": se revisa todo, y se
    // dice. Callarlo haría pasar por revisión de un ciclo lo que es de varios.
    warnings.push('No se encontró el inicio del ciclo en MetaTrader: se revisaron TODAS las operaciones de la cuenta.');
  }

  return {
    withdrawal: w, program, trades: trades.length, checks, violations,
    unverifiable, outcome, warnings, facts, cycle: cicloInfo,
  };
}
