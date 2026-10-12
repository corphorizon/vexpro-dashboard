// ─────────────────────────────────────────────────────────────────────────────
// propfirm-view — las decisiones de la cola de prop firm que no son de
// dibujo, puras para testearlas («Libro mayor», 2026-10-12).
//
//   · `checkTally`: cumple / incumple / sin comprobar, SIEMPRE los tres. Un
//     estado que no sea uno de los tres no se cuenta en ninguno (no se asume
//     «cumple»).
//   · `finalStatusCounts`: los estados finales del CRM que HAY en el
//     historial, con su conteo, de más a menos frecuente. Sale de los datos y
//     no de una lista fija: un estado nuevo de Orion aparece con su chip en
//     vez de esconder sus retiros. `null` se agrupa como «—».
//   · `filterByFinalStatus`: null = todos.
//
// Antes estas tres cosas vivían inline en el componente (un `filter` por
// estado repetido tres veces y un Map en un useMemo): sin test, y el conteo
// de «sin comprobar» era el que más importaba y el único sin verificar.
// ─────────────────────────────────────────────────────────────────────────────

export interface CheckTally {
  pass: number;
  fail: number;
  unverifiable: number;
}

export function checkTally(checks: { status: string }[] | null | undefined): CheckTally {
  const out: CheckTally = { pass: 0, fail: 0, unverifiable: 0 };
  for (const c of checks ?? []) {
    if (c.status === 'pass' || c.status === 'fail' || c.status === 'unverifiable') out[c.status] += 1;
  }
  return out;
}

export const NO_STATUS = '—';

export function finalStatusCounts(rows: { status: string | null }[]): { status: string; count: number }[] {
  const n = new Map<string, number>();
  for (const r of rows) {
    const k = r.status ?? NO_STATUS;
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  return [...n.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        // «—» (sin estado) al final de su empate: no es un estado, es la falta de uno.
        Number(a.status === NO_STATUS) - Number(b.status === NO_STATUS) ||
        a.status.localeCompare(b.status),
    );
}

export function filterByFinalStatus<T extends { status: string | null }>(rows: T[], status: string | null): T[] {
  if (status === null) return rows;
  return rows.filter((r) => (r.status ?? NO_STATUS) === status);
}
