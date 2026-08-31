// ─────────────────────────────────────────────────────────────────────────────
// Los totales de `commercial_monthly_results` por perfil, para los períodos que
// el selector del módulo dejó pasar.
//
// Es lo que la pestaña Comercial pintaba con cinco `filter().reduce()` inline
// (uno por columna) repetidos además en el CSV. Un mismo número tiene que salir
// del mismo camino lo pida la tabla o el export (invariante A3, §2.1): con dos
// copias, el día que se agregue una columna una de las dos se olvida.
//
// ── Sólo suma lo que ya está guardado ──────────────────────────────────────
// Estas son las filas MANUALES del período; no calcula comisiones ni las
// unifica con el net del CRM (eso es la tanda 2). La fórmula del dinero sigue
// viviendo sola en src/lib/commission-calculator.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que este módulo mira de una fila de resultados mensuales. */
export type MonthlyResultRow = {
  profile_id: string;
  period_id: string;
  net_deposit_current: number;
  net_deposit_total: number;
  pnl_current: number;
  commissions_earned: number;
  bonus: number;
  salary_paid: number;
  total_earned: number;
};

export type PerfilTotales = {
  netDepositCurrent: number;
  netDepositTotal: number;
  pnl: number;
  commissions: number;
  bonus: number;
  salary: number;
  total: number;
};

const CERO: PerfilTotales = {
  netDepositCurrent: 0,
  netDepositTotal: 0,
  pnl: 0,
  commissions: 0,
  bonus: 0,
  salary: 0,
  total: 0,
};

function acumular(acc: PerfilTotales, r: MonthlyResultRow): PerfilTotales {
  return {
    netDepositCurrent: acc.netDepositCurrent + (r.net_deposit_current || 0),
    netDepositTotal: acc.netDepositTotal + (r.net_deposit_total || 0),
    pnl: acc.pnl + (r.pnl_current || 0),
    commissions: acc.commissions + (r.commissions_earned || 0),
    bonus: acc.bonus + (r.bonus || 0),
    salary: acc.salary + (r.salary_paid || 0),
    total: acc.total + (r.total_earned || 0),
  };
}

/**
 * Los totales de cada perfil, ya filtrados por período.
 *
 * Devuelve un Map: un perfil SIN filas no está en el Map, y el llamador decide
 * si eso es `0` (la tabla suma cero, que es correcto) o "—". No se prellena con
 * ceros para todos los perfiles a propósito.
 */
export function totalesPorPerfil(
  results: readonly MonthlyResultRow[],
  periodIds: readonly string[],
): Map<string, PerfilTotales> {
  const permitidos = new Set(periodIds);
  const out = new Map<string, PerfilTotales>();
  for (const r of results) {
    if (!permitidos.has(r.period_id)) continue;
    out.set(r.profile_id, acumular(out.get(r.profile_id) ?? CERO, r));
  }
  return out;
}

/** El total de todos los perfiles juntos — el pie de la tabla y el KPI. */
export function totalesGenerales(porPerfil: Map<string, PerfilTotales>): PerfilTotales {
  let acc = CERO;
  for (const v of porPerfil.values()) {
    acc = {
      netDepositCurrent: acc.netDepositCurrent + v.netDepositCurrent,
      netDepositTotal: acc.netDepositTotal + v.netDepositTotal,
      pnl: acc.pnl + v.pnl,
      commissions: acc.commissions + v.commissions,
      bonus: acc.bonus + v.bonus,
      salary: acc.salary + v.salary,
      total: acc.total + v.total,
    };
  }
  return acc;
}

/** Atajo legible para las celdas: un perfil sin filas vale cero en la suma. */
export function totalesDe(
  porPerfil: Map<string, PerfilTotales>,
  profileId: string,
): PerfilTotales {
  return porPerfil.get(profileId) ?? CERO;
}
