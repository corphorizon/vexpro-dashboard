// ─────────────────────────────────────────────────────────────────────────────
// chain-view — cómo se MUESTRA la cadena de distribución cuando una serie del
// CRM no llegó (Home, /resumen-general, /socios). Rediseño «Libro mayor»,
// 2026-10-12.
//
// POR QUÉ: la lógica de «falta Broker P&L / Prop Firm» ya existía
// (`computeCheckedChain`, `pendingValueLabel`, `incompleteNotice` en
// distribution-inputs.ts, incidente 2026-10-05: el «PDF mes» de Vex Pro salió
// con Monto a distribuir $0 porque las series seguían en vuelo). Lo que NO
// existía era una decisión única de PRESENTACIÓN: cada pantalla elegía a ojo
// el color del aviso (/socios: `info` si cargaba, `warning` si no; la home:
// ninguno, el texto suelto en la tarjeta) y, el caso grave, qué hacer en
// CONSOLIDADO: /socios leía `currentChain` (null en consolidado) con `?? 0` y
// mostraba «Ingresos $0.00 · Monto a distribuir $0.00» para cualquier rango
// de meses — el número plausible y falso del §1.2. Medido en el código del
// 2026-10-12: 6 lecturas `currentChain?.x ?? 0` en socios/page.tsx.
//
// Acá:
//   · `seriesState`: loading/failed → texto (el MISMO de pendingValueLabel,
//     que comparte el PDF) + badge `stale` bajo el KPI + banner `stale`
//     (cargando) o `bad` (falló: el informe queda incompleto).
//   · `sumChain`: totales de 1..N períodos con la regla de la cadena —
//     ingresos/resultado son null si ALGÚN mes tiene su propia serie
//     faltante; reserva/a distribuir, si alguno está `pendiente` (incluye el
//     arrastre de un mes anterior). Un período que no está en la cadena hace
//     null todo: no se suma lo que no se encontró.
//
// LO QUE NO HACE: calcular nada de la fórmula. Suma resultados de
// `computeCheckedChain` (distribution.ts sigue siendo la única fuente, §2.2).
//
// DESCARTADO:
//   · `failed` → badge `bad` bajo el KPI (pedido de la tanda: `stale` para
//     los dos estados). El dato existe en el CRM; lo que falló es traerlo.
//     El banner sí sube a `bad` porque el informe queda incompleto.
//   · Sumar los meses completos y avisar «(parcial)»: es el número que Kevin
//     tuvo en la mano el 2026-10-05; el rótulo se pierde al copiarlo.
// ─────────────────────────────────────────────────────────────────────────────

import {
  pendingValueLabel,
  type AutoSeriesStatusMap,
  type PeriodDistResultChecked,
} from './distribution-inputs';
import { round2 } from './utils';

export type SeriesPhase = 'loading' | 'failed';

export interface SeriesState {
  phase: SeriesPhase;
  /** «Cargando datos del CRM…» / «Sin datos del CRM» — el texto de pendingValueLabel. */
  label: string;
  /** Badge bajo un KPI sin número. */
  badge: 'stale';
  /** Banner de estado del dato (spec §5.5). */
  notice: 'stale' | 'bad';
}

type CompletenessLike = Pick<PeriodDistResultChecked, 'incompleto' | 'incompletoEstado' | 'heredaIncompleto'>;

/**
 * Estado de las series de UN período. `scope: 'own'` mira sólo sus propias
 * series (ingresos y resultado); `'chain'` también el arrastre de un mes
 * anterior incompleto (reserva, a distribuir, reparto). null = definitivo.
 */
export function seriesState(
  c: CompletenessLike | null | undefined,
  status?: AutoSeriesStatusMap,
  scope: 'own' | 'chain' = 'chain',
): SeriesState | null {
  if (!c) return null;
  const own = c.incompleto.length > 0;
  if (!own && (scope === 'own' || !c.heredaIncompleto)) return null;
  const view = own ? { ...c, heredaIncompleto: false } : c;
  const label = pendingValueLabel(view, status);
  if (!label) return null;
  const loading = own
    ? c.incompletoEstado === 'loading'
    : !!status && (status.brokerPnl === 'loading' || status.crmMonthly === 'loading');
  const phase: SeriesPhase = loading ? 'loading' : 'failed';
  return { phase, label, badge: 'stale', notice: phase === 'loading' ? 'stale' : 'bad' };
}

/** El peor de varios estados: `failed` pesa más que `loading` (no se va a resolver solo). */
export function worstSeriesState(states: ReadonlyArray<SeriesState | null>): SeriesState | null {
  let worst: SeriesState | null = null;
  for (const s of states) {
    if (!s) continue;
    if (!worst || (worst.phase === 'loading' && s.phase === 'failed')) worst = s;
  }
  return worst;
}

/** Lo mínimo de un período de la cadena que `sumChain` necesita. */
export type ChainEntryLike = CompletenessLike &
  Pick<
    PeriodDistResultChecked,
    'ingresosNetos' | 'egresosNetos' | 'saldoAFavor' | 'reserveThisPeriod' | 'montoDistribuir' | 'pendiente'
  >;

export interface ChainKpis {
  /** null = algún mes no tiene su serie del CRM (o el período no está en la cadena). */
  ingresosNetos: number | null;
  /** Egresos no dependen del CRM: sólo null si falta un período. */
  egresosNetos: number | null;
  resultado: number | null;
  /** null = algún mes está pendiente (propio o heredado). */
  reserva: number | null;
  aDistribuir: number | null;
  /** Estado para ingresos / resultado. */
  ownState: SeriesState | null;
  /** Estado para reserva / a distribuir / reparto. */
  chainState: SeriesState | null;
  /** Cuántos de los períodos pedidos están pendientes (para «2 de 4 meses»). */
  pendingCount: number;
  /** Cuántos períodos pedidos no se encontraron en la cadena. */
  missingCount: number;
}

/**
 * Totales de 1..N períodos de la cadena. En un período único devuelve sus
 * números tal cual (redondeados a centavos); en consolidado, la suma — y null
 * en cuanto un sumando no sea definitivo.
 */
export function sumChain(
  entries: ReadonlyArray<ChainEntryLike | null | undefined>,
  status?: AutoSeriesStatusMap,
): ChainKpis {
  const found = entries.filter((e): e is ChainEntryLike => e != null);
  const missingCount = entries.length - found.length;
  const ownState = worstSeriesState(found.map((e) => seriesState(e, status, 'own')));
  const chainState = worstSeriesState(found.map((e) => seriesState(e, status, 'chain')));
  const pendingCount = found.filter((e) => e.pendiente).length;
  const complete = entries.length > 0 && missingCount === 0;
  const ownKnown = complete && found.every((e) => e.incompleto.length === 0);
  const chainKnown = complete && pendingCount === 0;
  const sum = (pick: (e: ChainEntryLike) => number) => round2(found.reduce((s, e) => s + pick(e), 0));
  return {
    ingresosNetos: ownKnown ? sum((e) => e.ingresosNetos) : null,
    egresosNetos: complete ? sum((e) => e.egresosNetos) : null,
    resultado: ownKnown ? sum((e) => e.saldoAFavor) : null,
    reserva: chainKnown ? sum((e) => e.reserveThisPeriod) : null,
    aDistribuir: chainKnown ? sum((e) => e.montoDistribuir) : null,
    ownState,
    chainState,
    pendingCount,
    missingCount,
  };
}
