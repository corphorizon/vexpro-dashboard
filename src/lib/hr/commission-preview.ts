// ─────────────────────────────────────────────────────────────────────────────
// LA COMISIÓN INDIVIDUAL DE UN BDM EN UN MES — un solo camino.
//
// ── El porqué ──────────────────────────────────────────────────────────────
// «Un mismo número (lo que cobra una persona en un mes) tiene que salir del
// mismo camino, lo pida la tabla, el guardado o el PDF» (§2.1, invariante que
// dejó la auditoría A3). Hasta la tanda 2 ese camino estaba escrito inline en
// `indCalcs` (comisiones/page.tsx) y era el único lugar donde existía; ahora la
// pestaña Comercial de /rrhh muestra el mismo número, así que la composición
// —qué % aplica, qué salario, con qué acumulado— vive acá y las dos pantallas
// la llaman.
//
// NO es una fórmula nueva. Es la composición de tres funciones que ya estaban y
// que NO se tocan: `calculateBdmPctFromND` (el tier es piso, nunca techo),
// `calculateCommission` (división = net/2, base = división + acumulado, sin
// clamp) y `prorateFixedSalary` / `calculateSalaryFromND`.
//
// ── Qué comisión es ────────────────────────────────────────────────────────
// La PROPIA del BDM, la del tab Individual — no el diferencial que cobra su
// head sobre él (eso vive en bdmCalcs y depende del grupo que se esté mirando).
// En /rrhh la pregunta es «cuánto cobra esta persona este mes», así que es ésta.
//
// ── Perfiles de PnL ────────────────────────────────────────────────────────
// Quien cobra por PnL (`pnl_pct` cargado) NO pasa por acá: su base es el PnL del
// mes, que no sale del CRM y se sigue tecleando. Devuelve `null` para que la
// pantalla muestre "—" en vez de un cero que parecería un mes sin comisión.
// ─────────────────────────────────────────────────────────────────────────────

import {
  calculateBdmPctFromND,
  calculateCommission,
  calculateSalaryFromND,
  prorateFixedSalary,
} from '@/lib/commission-calculator';
import { netParaElMotor, type NetDepositSource, type ResolvedNetDeposit } from './net-deposit-input';

/** Lo mínimo del perfil que hace falta para componer la comisión. */
export type PerfilParaComision = {
  id: string;
  net_deposit_pct?: number | null;
  /** true = % fijo: los tramos por volumen no aplican (migración 128). */
  nd_pct_fixed?: boolean | null;
  pnl_pct?: number | null;
  fixed_salary?: boolean | null;
  salary?: number | null;
  hire_date?: string | null;
};

export type ComisionDelMes = {
  profileId: string;
  /** El insumo tal como se resolvió. `null` = SIN DATOS (entró al motor como 0). */
  nd: number | null;
  source: NetDepositSource;
  accumulatedIn: number;
  commissionPct: number;
  division: number;
  commission: number;
  realPayment: number;
  accumulatedOut: number;
  salary: number;
};

/**
 * Lo que cobra un BDM por net deposit en un mes.
 *
 * `null` cuando el perfil no cobra por net deposit (cobra por PnL): mostrar 0
 * ahí sería decir "no ganó nada", que es distinto de "no se calcula así".
 */
export function comisionIndividualDeBdm(params: {
  profile: PerfilParaComision;
  resolved: ResolvedNetDeposit;
  accumulatedIn: number;
  periodYear: number;
  periodMonth: number;
}): ComisionDelMes | null {
  const { profile, resolved, accumulatedIn, periodYear, periodMonth } = params;
  if (profile.pnl_pct != null) return null;

  const nd = netParaElMotor(resolved);
  // Con salario fijo el % es el pactado y no lo mejoran los tiers: el tier de
  // volumen es la contrapartida de no tener piso. Mismo criterio que indCalcs.
  const commissionPct = profile.fixed_salary
    ? (profile.net_deposit_pct ?? 0)
    : calculateBdmPctFromND(nd, profile.net_deposit_pct ?? 0, profile.nd_pct_fixed ?? false);

  const calc = calculateCommission(nd, accumulatedIn, commissionPct);
  const salary = profile.fixed_salary
    ? prorateFixedSalary(profile.salary ?? 0, profile.hire_date, periodYear, periodMonth)
    : calculateSalaryFromND(nd);

  return {
    profileId: profile.id,
    nd: resolved.value,
    source: resolved.source,
    commissionPct,
    salary,
    accumulatedIn: calc.accumulatedIn,
    division: calc.division,
    commission: calc.commission,
    realPayment: calc.realPayment,
    accumulatedOut: calc.accumulatedOut,
  };
}
