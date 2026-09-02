// ─────────────────────────────────────────────────────────────────────────────
// Los AGREGADOS del hedge fund — funciones PURAS.
//
// Viven separadas del endpoint por la misma razón de siempre en este repo: lo
// que toca la red no se puede testear, y lo que decide un número sí tiene que
// poder testearse. El endpoint lee filas; acá se calcula.
//
// ── EL CAPITAL DEL HEDGE FUND VA POR APARTE ────────────────────────────────
// Decisión de Kevin, 2026-09-02: este módulo muestra SUS PROPIOS números y NO
// se integra a balances, resumen general ni cadena de distribución. Por eso
// este archivo no importa nada de `distribution*.ts` ni escribe en ninguna
// tabla contable — y no debe empezar a hacerlo sin una decisión explícita:
// cambiar `distribution.ts` recalcula retroactivamente TODOS los períodos
// cerrados, incluida la plata ya repartida (§2.3).
//
// ── ESTADOS: EL VOCABULARIO ES DEL CRM ─────────────────────────────────────
// `ACTIVE`, `REJECTED`, `TERMINATED`. NO se normaliza a un vocabulario propio:
// un estado nuevo del CRM tiene que APARECER en la pantalla como estado nuevo,
// no caer en un 'unknown' que lo hace desaparecer de los filtros. Es la misma
// lección de `REVIEWED` en los retiros, que dejó 8 fuera de la cola.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  HfCommissionRow,
  HfFundRow,
  HfInvestmentRow,
  HfLedgerRow,
  HfPayoutRow,
} from './types';
import { parseExpectedReturn, projectReturn, type ProjectedReturn } from './normalize';

/** El único estado que cuenta como dinero VIVO del cliente. */
export const HF_STATUS_ACTIVE = 'ACTIVE';

/** El tipo de asiento del ledger que ACREDITA rendimiento al cliente. */
export const HF_LEDGER_PAYOUT = 'PAYOUT';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Suma tratando `null` como AUSENTE, no como cero. Ver §1.3. */
function sum(values: Array<number | null | undefined>): number {
  let total = 0;
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    total += v;
  }
  return round2(total);
}

export function isActive(inv: { status: string | null }): boolean {
  return inv.status === HF_STATUS_ACTIVE;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resumen por programa
// ─────────────────────────────────────────────────────────────────────────────

export interface FundSummary {
  fundKey: string;
  name: string | null;
  status: string | null;
  enabled: boolean | null;
  risk: string | null;
  currency: string | null;
  approvalMode: string | null;
  profitsLocked: boolean | null;
  minInvestment: number | null;
  holdingMonths: number | null;
  expectedReturnRaw: string | null;
  expectedReturnMinPct: number | null;
  expectedReturnMaxPct: number | null;
  /** Capital bajo gestión: suma de `balance` de las inversiones ACTIVE. */
  aum: number;
  /** Principal aportado por los clientes con inversión ACTIVE. */
  principal: number;
  /** Clientes DISTINTOS con al menos una inversión ACTIVE. */
  clients: number;
  activeInvestments: number;
  /** Inversiones del fondo en cualquier estado (para el contexto histórico). */
  totalInvestments: number;
  /**
   * Ticket promedio del capital activo. `null` cuando no hay ninguna inversión
   * activa: dividir por cero daría NaN y mostrar 0 diría «el ticket es cero».
   */
  averageTicket: number | null;
  /** Rendimientos ya acreditados a clientes de este fondo (ledger PAYOUT). */
  creditedReturns: number;
  /** La última corrida de pago del fondo. `null` = todavía no pagó ninguna. */
  lastPayoutAt: string | null;
  lastPayoutPercent: number | null;
}

export function buildFundSummaries(input: {
  funds: readonly HfFundRow[];
  investments: readonly HfInvestmentRow[];
  ledger: readonly HfLedgerRow[];
  payouts: readonly HfPayoutRow[];
}): FundSummary[] {
  const porFondo = new Map<string, HfInvestmentRow[]>();
  for (const inv of input.investments) {
    if (!inv.fund_key) continue;
    const lista = porFondo.get(inv.fund_key);
    if (lista) lista.push(inv);
    else porFondo.set(inv.fund_key, [inv]);
  }

  const creditadoPorFondo = new Map<string, number>();
  for (const e of input.ledger) {
    if (e.type !== HF_LEDGER_PAYOUT || !e.fund_key) continue;
    creditadoPorFondo.set(e.fund_key, (creditadoPorFondo.get(e.fund_key) ?? 0) + (e.amount ?? 0));
  }

  // La última corrida por fondo. Se ordena por `finished_at` con respaldo en
  // `started_at`: una corrida que arrancó y no terminó todavía no pagó nada,
  // pero es la más reciente que existe y esconderla sería mentir por omisión.
  const ultimoPayout = new Map<string, HfPayoutRow>();
  for (const p of input.payouts) {
    if (!p.fund_key) continue;
    const previo = ultimoPayout.get(p.fund_key);
    const fecha = p.finished_at ?? p.started_at ?? p.source_created_at ?? '';
    const fechaPrevia = previo ? (previo.finished_at ?? previo.started_at ?? previo.source_created_at ?? '') : '';
    if (!previo || fecha > fechaPrevia) ultimoPayout.set(p.fund_key, p);
  }

  return input.funds.map((f) => {
    const todas = porFondo.get(f.fund_key) ?? [];
    const activas = todas.filter(isActive);
    const aum = sum(activas.map((i) => i.balance));
    const clientes = new Set(activas.map((i) => i.user_external_id).filter((v): v is string => !!v));
    const ultimo = ultimoPayout.get(f.fund_key) ?? null;
    return {
      fundKey: f.fund_key,
      name: f.name,
      status: f.status,
      enabled: f.enabled,
      risk: f.risk,
      currency: f.currency,
      approvalMode: f.approval_mode,
      profitsLocked: f.profits_locked,
      minInvestment: f.min_investment,
      holdingMonths: f.holding_months,
      expectedReturnRaw: f.expected_return_raw,
      expectedReturnMinPct: f.expected_return_min_pct,
      expectedReturnMaxPct: f.expected_return_max_pct,
      aum,
      principal: sum(activas.map((i) => i.principal)),
      clients: clientes.size,
      activeInvestments: activas.length,
      totalInvestments: todas.length,
      averageTicket: activas.length > 0 ? round2(aum / activas.length) : null,
      creditedReturns: round2(creditadoPorFondo.get(f.fund_key) ?? 0),
      lastPayoutAt: ultimo ? (ultimo.finished_at ?? ultimo.started_at ?? null) : null,
      lastPayoutPercent: ultimo?.percent ?? null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Comisiones de red: bruto, reversos y NETO
// ─────────────────────────────────────────────────────────────────────────────

export interface CommissionTotals {
  /** Suma de los importes POSITIVOS. */
  paid: number;
  /** Suma de los NEGATIVOS, en valor absoluto. Se muestran, no se esconden. */
  reversed: number;
  /** paid − reversed. Es el número que se le pagó de verdad a la red. */
  net: number;
  count: number;
  reversedCount: number;
}

/**
 * ── POR QUÉ EL NETO NO SE CLAMPEA A CERO ───────────────────────────────────
 * Es la regla #1 de §2.1, la que ya pagó de más una vez: una comisión negativa
 * ES deuda del beneficiario, y llevarla a 0 la borra. Acá el reverso además se
 * cuenta y se muestra aparte, así que el neto nunca es una resta invisible.
 */
export function totalCommissions(rows: readonly HfCommissionRow[]): CommissionTotals {
  let paid = 0;
  let reversed = 0;
  let reversedCount = 0;
  for (const c of rows) {
    const a = c.amount;
    if (a === null || a === undefined || !Number.isFinite(a)) continue;
    if (a >= 0) paid += a;
    else {
      reversed += -a;
      reversedCount++;
    }
  }
  return {
    paid: round2(paid),
    reversed: round2(reversed),
    net: round2(paid - reversed),
    count: rows.length,
    reversedCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Vencimientos
// ─────────────────────────────────────────────────────────────────────────────

/** Días entre hoy y el vencimiento. Negativo = YA VENCIÓ y sigue abierta. */
export function daysUntil(endDate: string | null, now: Date = new Date()): number | null {
  if (!endDate) return null;
  const t = Date.parse(endDate);
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - now.getTime()) / 86_400_000);
}

export interface MaturityBuckets {
  /** Ya vencidas y todavía ACTIVE: el caso que hay que mirar primero. */
  overdue: { count: number; principal: number };
  in30: { count: number; principal: number };
  in60: { count: number; principal: number };
  in90: { count: number; principal: number };
}

/**
 * Los tramos son ACUMULATIVOS (30 ⊂ 60 ⊂ 90), que es como se lee la pregunta
 * «¿cuánto capital tengo que devolver en los próximos 60 días?». Hacerlos
 * excluyentes obligaría a sumar tres tarjetas mentalmente para contestarla.
 */
export function bucketMaturities(
  investments: readonly HfInvestmentRow[],
  now: Date = new Date(),
): MaturityBuckets {
  const vacio = () => ({ count: 0, principal: 0 });
  const out: MaturityBuckets = { overdue: vacio(), in30: vacio(), in60: vacio(), in90: vacio() };
  for (const inv of investments) {
    if (!isActive(inv)) continue;
    const dias = daysUntil(inv.end_date, now);
    if (dias === null) continue;
    const capital = inv.principal ?? inv.balance ?? 0;
    if (dias < 0) {
      out.overdue.count++;
      out.overdue.principal += capital;
      continue;
    }
    if (dias <= 30) { out.in30.count++; out.in30.principal += capital; }
    if (dias <= 60) { out.in60.count++; out.in60.principal += capital; }
    if (dias <= 90) { out.in90.count++; out.in90.principal += capital; }
  }
  for (const k of ['overdue', 'in30', 'in60', 'in90'] as const) {
    out[k].principal = round2(out[k].principal);
  }
  return out;
}

export interface MaturityMonth {
  /** 'YYYY-MM' del vencimiento. */
  ym: string;
  count: number;
  /** Capital que vence ese mes. */
  principal: number;
  /**
   * Rendimiento PROYECTADO al retorno esperado del fondo. `null` cuando NINGUNA
   * de las inversiones del mes tiene un rango parseable: proyectar sobre una
   * parte y presentarlo como el total del mes sería un número más chico con
   * cara de completo.
   */
  projected: ProjectedReturn | null;
  /** Inversiones del mes cuyo fondo no tiene retorno esperado parseable. */
  withoutProjection: number;
}

/** 'YYYY-MM' en UTC. El CRM guarda las fechas en UTC; convertir a local movería
 *  un vencimiento del 1 al mes anterior según dónde corra el proceso. */
export function monthKeyUtc(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 7);
}

/**
 * Calendario mensual de vencimientos con su proyección.
 *
 * SOLO inversiones ACTIVE: una TERMINATED ya devolvió su capital y sumarla
 * diría que hay que devolverlo otra vez.
 */
export function buildMaturityCalendar(
  investments: readonly HfInvestmentRow[],
  funds: readonly HfFundRow[],
): MaturityMonth[] {
  const porFondo = new Map(funds.map((f) => [f.fund_key, f]));
  const meses = new Map<string, MaturityMonth & { proyectables: number }>();

  for (const inv of investments) {
    if (!isActive(inv) || !inv.end_date) continue;
    const ym = monthKeyUtc(inv.end_date);
    if (!ym) continue;

    let mes = meses.get(ym);
    if (!mes) {
      mes = { ym, count: 0, principal: 0, projected: null, withoutProjection: 0, proyectables: 0 };
      meses.set(ym, mes);
    }

    const capital = inv.principal ?? inv.balance ?? 0;
    mes.count++;
    mes.principal += capital;

    const fondo = inv.fund_key ? porFondo.get(inv.fund_key) : undefined;
    // El rango se re-parsea del texto crudo cuando las columnas derivadas no
    // están: una fila espejada antes de que existiera el parseo no tiene por
    // qué quedar sin proyección para siempre.
    const rango =
      fondo && fondo.expected_return_min_pct !== null && fondo.expected_return_max_pct !== null
        ? { minPct: fondo.expected_return_min_pct, maxPct: fondo.expected_return_max_pct }
        : parseExpectedReturn(fondo?.expected_return_raw);

    const meses_ = inv.holding_months ?? fondo?.holding_months ?? null;
    const proy = projectReturn(capital, rango, meses_);
    if (proy === null) {
      mes.withoutProjection++;
      continue;
    }
    mes.proyectables++;
    mes.projected = {
      min: round2((mes.projected?.min ?? 0) + proy.min),
      max: round2((mes.projected?.max ?? 0) + proy.max),
    };
  }

  return [...meses.values()]
    .map((m): MaturityMonth => ({
      ym: m.ym,
      count: m.count,
      principal: round2(m.principal),
      projected: m.projected,
      withoutProjection: m.withoutProjection,
    }))
    .sort((a, b) => a.ym.localeCompare(b.ym));
}

// ─────────────────────────────────────────────────────────────────────────────
// El resumen de arriba de todo
// ─────────────────────────────────────────────────────────────────────────────

export interface HedgeFundOverview {
  /** Capital bajo gestión: suma de `balance` de las inversiones ACTIVE. */
  aum: number;
  /**
   * Pasivo con clientes = principal aportado + rendimientos ya acreditados
   * (Kevin, 2026-09-02). Es lo que el fondo le debe a la gente si mañana todos
   * cierran.
   *
   * Puede DIFERIR de `aum`, y esa diferencia es información, no un error de
   * cuenta: `balance` ya tiene descontado lo que el cliente retiró. Por eso se
   * exponen los dos y no uno derivado del otro — si el módulo mostrara sólo
   * uno, nadie podría ver que se separaron.
   */
  clientLiability: number;
  liabilityPrincipal: number;
  liabilityCreditedReturns: number;
  clients: number;
  activeInvestments: number;
  totalInvestments: number;
  creditedReturns: number;
  commissions: CommissionTotals;
  maturities: MaturityBuckets;
}

export function buildOverview(input: {
  investments: readonly HfInvestmentRow[];
  ledger: readonly HfLedgerRow[];
  commissions: readonly HfCommissionRow[];
  now?: Date;
}): HedgeFundOverview {
  const activas = input.investments.filter(isActive);
  const principal = sum(activas.map((i) => i.principal));
  const acreditado = sum(
    input.ledger.filter((e) => e.type === HF_LEDGER_PAYOUT).map((e) => e.amount),
  );
  return {
    aum: sum(activas.map((i) => i.balance)),
    clientLiability: round2(principal + acreditado),
    liabilityPrincipal: principal,
    liabilityCreditedReturns: acreditado,
    clients: new Set(
      activas.map((i) => i.user_external_id).filter((v): v is string => !!v),
    ).size,
    activeInvestments: activas.length,
    totalInvestments: input.investments.length,
    creditedReturns: acreditado,
    commissions: totalCommissions(input.commissions),
    maturities: bucketMaturities(input.investments, input.now ?? new Date()),
  };
}
