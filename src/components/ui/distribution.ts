// ─────────────────────────────────────────────────────────────────────────────
// computeDistribution — el cálculo de la barra de distribución (spec §7).
//
// Puro y separado del componente para testearlo. Reglas de la spec:
//   · Base = activos líquidos: sólo valores > 0. Deudas (negativos), ceros y
//     null NO entran — y se CUENTAN (`excludedCount`, `excludedTotal`,
//     `missingCount`) para que la UI lo diga. Una exclusión silenciosa es
//     indistinguible de un cruce roto (reglas-del-proyecto.md §1.2).
//   · Máximo 5 segmentos con nombre + «Otros»; todo lo < 2 % va a «Otros».
//     Si «Otros» juntaría UN solo ítem y queda lugar, se muestra con nombre:
//     un «Otros» que es un solo canal esconde un nombre sin ahorrar nada.
//   · Los % de la leyenda suman exactamente 100,0 (resto mayor sobre décimas):
//     una leyenda que suma 99,9 % parece un canal perdido.
//   · Ordenado de mayor a menor; el orden define el color de la rampa.
//
// DESCARTADO: calcular los % sobre el total con deudas restadas — un canal
// sobre una base neta puede pasar el 100 % y la barra no tiene cómo mostrarlo.
// ─────────────────────────────────────────────────────────────────────────────

export interface DistributionInput {
  key: string;
  label: string;
  /** null = sin dato (no es 0): se cuenta en `missingCount`. */
  value: number | null | undefined;
  /** Saldo viejo: el segmento va rayado del mismo tono. */
  stale?: boolean;
}

export interface DistributionSegment {
  key: string;
  label: string;
  value: number;
  /** Porcentaje con 1 decimal; la suma de todos es 100. */
  pct: number;
  stale: boolean;
  /** Es el agrupado «Otros». */
  others: boolean;
  /** Ítems que contiene (1 salvo «Otros»). */
  count: number;
  /** Posición en la rampa (0 = el mayor). «Otros» no usa la rampa. */
  rank: number;
}

export interface Distribution {
  segments: DistributionSegment[];
  total: number;
  /** Valores ≤ 0 (deudas, ceros) que no entran a la barra. */
  excludedCount: number;
  excludedTotal: number;
  /** null/NaN: sin dato, no sumados. */
  missingCount: number;
}

export const MAX_NAMED_SEGMENTS = 5;
export const OTHERS_THRESHOLD_PCT = 2;
export const OTHERS_KEY = '__others__';

/** Reparte 100,0 % en décimas por resto mayor. Exportada para test. */
export function roundToHundred(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return values.map(() => 0);
  const raw = values.map((v) => (v / total) * 1000); // en décimas de punto
  const floors = raw.map(Math.floor);
  let rest = 1000 - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    floors[i] += 1;
    rest -= 1;
  }
  return floors.map((d) => d / 10);
}

export function computeDistribution(items: DistributionInput[], othersLabel = 'Otros'): Distribution {
  let excludedCount = 0;
  let excludedTotal = 0;
  let missingCount = 0;
  const positives: { key: string; label: string; value: number; stale: boolean }[] = [];
  for (const it of items) {
    const v = it.value;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      missingCount += 1;
    } else if (v <= 0) {
      excludedCount += 1;
      excludedTotal += v;
    } else {
      positives.push({ key: it.key, label: it.label, value: v, stale: Boolean(it.stale) });
    }
  }
  positives.sort((a, b) => b.value - a.value);
  const total = positives.reduce((a, p) => a + p.value, 0);

  const named: typeof positives = [];
  let rest: typeof positives = [];
  for (const p of positives) {
    const share = total > 0 ? (p.value / total) * 100 : 0;
    if (named.length < MAX_NAMED_SEGMENTS && share >= OTHERS_THRESHOLD_PCT) named.push(p);
    else rest.push(p);
  }
  if (rest.length === 1 && named.length < MAX_NAMED_SEGMENTS) {
    named.push(rest[0]);
    rest = [];
  }

  const groups = named.map((p, rank) => ({ ...p, others: false, count: 1, rank }));
  if (rest.length > 0) {
    groups.push({
      key: OTHERS_KEY,
      label: othersLabel,
      value: rest.reduce((a, p) => a + p.value, 0),
      stale: rest.some((p) => p.stale),
      others: true,
      count: rest.length,
      rank: groups.length,
    });
  }
  const pcts = roundToHundred(groups.map((g) => g.value));
  return {
    segments: groups.map((g, i) => ({ ...g, pct: pcts[i] })),
    total,
    excludedCount,
    excludedTotal,
    missingCount,
  };
}
