// ─────────────────────────────────────────────────────────────────────────────
// Reglamento de los programas de prop firm — registro ÚNICO.
//
// ── POR QUÉ ES DATO Y NO CÓDIGO ────────────────────────────────────────────
// Las reglas cambian por programa Y por empresa: esto es white-label. Vex tiene
// cuatro programas con reglamentos distintos entre sí, y el día que Exura o
// AP Markets monten el suyo van a tener otros. Un `if (programa === 'x12')`
// desperdigado por el motor hace que agregar una empresa signifique tocar el
// motor, que es exactamente como se rompen los motores.
//
// Fuente: https://funded.vexprofx.com/es (sección «Ver reglas completas») y
// los T&C oficiales, leídos el 2026-08-27. Cada regla lleva de dónde sale.
//
// ── LO QUE ESTE ARCHIVO NO DECIDE ──────────────────────────────────────────
// No dice si un retiro se aprueba. Dice qué hay que comprobar y con qué
// números. La consecuencia de incumplir —3 violaciones deniegan con período
// nuevo, 4 o más deniegan sin él— también está acá porque es parte del
// reglamento, pero quien la aplica es una persona.
//
// ── Y LO QUE NO SE PUEDE COMPROBAR ─────────────────────────────────────────
// Varias reglas del reglamento NO son verificables con lo que tenemos:
// operar en noticias necesita un calendario económico, el arbitraje de
// latencia necesita datos de tick del proveedor, y la copia entre usuarios
// necesita correlacionar cuentas.
//
// Esas reglas figuran igual, marcadas `checkable: false`. NUNCA deben
// mostrarse como "cumple": una pantalla en verde que incluye reglas que nadie
// miró afirma un cumplimiento que no se probó, y es peor que no mostrarlas.
// ─────────────────────────────────────────────────────────────────────────────

/** Las reglas que el motor sabe evaluar a partir de las operaciones de MT5. */
export type CheckId =
  | 'min_duration'
  | 'lot_consistency'
  | 'profit_concentration'
  | 'grid'
  | 'martingale'
  | 'weekend'
  | 'trades_after_request'
  | 'days_since_first_trade'
  | 'min_trading_days'
  | 'hft'
  // ── Declaradas pero NO verificables con los datos de hoy ────────────────
  | 'news_window'
  | 'copy_trading'
  | 'account_delegation';

export interface RuleSpec {
  id: CheckId;
  /** Qué se comprueba, en una línea, para mostrar en pantalla. */
  label: string;
  /**
   * `false` = el motor NO puede evaluarla con los datos disponibles. Se
   * muestra como "no verificable", jamás como "cumple".
   */
  checkable: boolean;
  /** Por qué no se puede comprobar. Obligatorio cuando `checkable` es false. */
  whyNot?: string;
  /** Parámetros de la regla. Su forma depende del `id`. */
  params?: Record<string, number>;
}

export interface ProgramRules {
  /** Cómo lo llama Orion en `withdrawalpropfirms.propFirmName`. */
  orionNames: string[];
  label: string;
  /** Pérdida diaria máxima, en % sobre el equity más alto del día. */
  maxDailyLossPct: number | null;
  /** Pérdida total máxima, en % sobre el equity más alto histórico. */
  maxTotalLossPct: number | null;
  /**
   * Reparto del beneficio por período, en orden. Vex Instant arranca en 70% y
   * llega a 95% en el quinto. El índice es el número de retiro del cliente.
   */
  profitSplitByPeriod: number[];
  rules: RuleSpec[];
}

// ── LO QUE EL CRM YA BLOQUEA, ACÁ NO SE REPITE ─────────────────────────────
// Ganancia mínima y drawdown los verifica el CRM antes de dejar pedir el
// retiro: si no se cumplen, la solicitud no llega a existir. Duplicarlos acá
// sólo crearía una segunda definición que puede discrepar de la primera, y
// discrepar en silencio.
//
// El drawdown SÍ se informa, pero como DATO —cuánto llegó a caer la cuenta en
// el ciclo— no como regla que apruebe o rechace.
//
// ── EL ARBITRAJE DE LATENCIA TAMPOCO ES UNA REGLA ─────────────────────────
// No se puede probar sin el flujo de ticks del proveedor. En su lugar se
// informa el reparto de duraciones de las operaciones, que es lo que Kevin
// pidió mirar: un dato que una persona interpreta, no un veredicto que el
// motor inventa.

/** Reglas prohibidas en TODOS los programas de fondeo (T&C 2.1). */
const PROHIBIDAS_SIEMPRE: RuleSpec[] = [
  {
    id: 'hft',
    label: 'HFT y sistemas de ticks',
    checkable: true,
    // Aproximación por densidad: no existe una definición formal de HFT en el
    // reglamento, así que se marca para revisión humana en vez de fallar sola.
    params: { maxSubMinutePct: 50 },
  },
  {
    id: 'copy_trading',
    label: 'Copia de operaciones entre usuarios',
    checkable: false,
    whyNot: 'Exige correlacionar las operaciones de varias cuentas entre sí. Es posible, pero no está construido.',
  },
  {
    id: 'account_delegation',
    label: 'Delegar la cuenta a un tercero',
    checkable: false,
    whyNot: 'No hay ningún dato que distinga a quién opera la cuenta.',
  },
];

/**
 * ── YA SE PUEDE COMPROBAR (2026-08-27) ─────────────────────────────────────
 * Antes decía que hacía falta un calendario económico y no había ninguno.
 * Ahora está: el de MetaQuotes, que es EL MISMO que el trader ve en su
 * terminal. Eso importa más que la exactitud — si se rechaza un retiro por
 * operar en una noticia, tiene que ser la noticia que él tenía delante.
 */
const SIN_NOTICIAS: RuleSpec = {
  id: 'news_window',
  label: 'No operar 5 min antes ni después de noticias de alto impacto',
  checkable: true,
  params: { minutos: 5 },
};

/**
 * Regla de los lotes: rango sobre el lote promedio.
 * promedio = volumen total / órdenes cerradas; rango [×0.25, ×2.00].
 */
const CONSISTENCIA: RuleSpec = {
  id: 'lot_consistency',
  label: 'Consistencia de lotes (promedio ×0,25 a ×2,00)',
  checkable: true,
  params: { factorMin: 0.25, factorMax: 2.0 },
};

/** Si una sola operación genera más del 30% del beneficio, el exceso se deduce. */
const CONCENTRACION: RuleSpec = {
  id: 'profit_concentration',
  label: 'Ninguna operación supera el 30% del beneficio total',
  checkable: true,
  params: { maxPct: 30 },
};

const GRID: RuleSpec = { id: 'grid', label: 'Grid trading', checkable: true, params: { minSimultaneas: 3 } };
const MARTINGALA: RuleSpec = { id: 'martingale', label: 'Martingala', checkable: true, params: { gapMaximo: 5 } };

/**
 * Operar DESPUÉS de pedir el retiro.
 *
 * Es la regla más dura del reglamento y la más fácil de comprobar: cualquier
 * operación abierta tras la solicitud provoca el rechazo automático (T&C 11).
 * No admite deducción ni interpretación, y hoy no la mira nadie.
 */
const POST_SOLICITUD: RuleSpec = {
  id: 'trades_after_request',
  label: 'No operar después de solicitar el retiro',
  checkable: true,
};

export const PROGRAM_RULES: ProgramRules[] = [
  {
    orionNames: ['VEX INSTANT FOREX', 'VEX INSTANT SYNTHETICS'],
    label: 'Vex Instant',
    maxDailyLossPct: 3,
    maxTotalLossPct: 6,
    // T&C 5.3: 1º 70% · 2º 75% · 3º 80% · 4º 90% · 5º 95%
    profitSplitByPeriod: [70, 75, 80, 90, 95],
    rules: [
      { id: 'min_duration', label: 'Cada operación abierta al menos 5 minutos', checkable: true, params: { minutos: 5 } },
      CONSISTENCIA,
      CONCENTRACION,
      GRID,
      MARTINGALA,
      POST_SOLICITUD,
      { id: 'days_since_first_trade', label: '30 días desde la primera operación', checkable: true, params: { dias: 30 } },
      ...PROHIBIDAS_SIEMPRE,
    ],
  },
  {
    orionNames: ['VEX2PRO FOREX', 'VEX2PRO SYNTHETICS'],
    label: 'Vex2Pro',
    maxDailyLossPct: 5,
    maxTotalLossPct: 10,
    // T&C 4.6: 1º 80% · 2º 85% · 3º 90% · 4º 95%
    profitSplitByPeriod: [80, 85, 90, 95],
    rules: [
      // Ojo: acá el mínimo es 2 minutos, NO 5. Es la diferencia que más fácil
      // se pasa por alto si el motor tuviera un único número global.
      { id: 'min_duration', label: 'Cada operación abierta al menos 2 minutos', checkable: true, params: { minutos: 2 } },
      GRID,
      MARTINGALA,
      POST_SOLICITUD,
      { id: 'weekend', label: 'No se opera fines de semana', checkable: true },
      SIN_NOTICIAS,
      { id: 'days_since_first_trade', label: '30 días desde la primera operación', checkable: true, params: { dias: 30 } },
      { id: 'min_trading_days', label: 'Al menos 5 días operados', checkable: true, params: { dias: 5 } },
      ...PROHIBIDAS_SIEMPRE,
    ],
  },
  {
    orionNames: ['ELITE TRADER'],
    label: 'Vex Elite',
    maxDailyLossPct: 3,
    maxTotalLossPct: 6,
    // T&C 3.4: el reparto va por nivel de escalado (50–70%), no por período.
    profitSplitByPeriod: [50, 60, 70],
    rules: [
      { id: 'min_duration', label: 'Cada operación abierta al menos 5 minutos', checkable: true, params: { minutos: 5 } },
      CONCENTRACION,
      GRID,
      MARTINGALA,
      POST_SOLICITUD,
      { id: 'days_since_first_trade', label: '14 días desde la primera operación', checkable: true, params: { dias: 14 } },
      ...PROHIBIDAS_SIEMPRE,
    ],
  },
  {
    // ── X12 ES LA EXCEPCIÓN, Y ES DELIBERADA ───────────────────────────────
    // El programa se vende como "elimina casi todas las restricciones": no hay
    // consistencia de lotes, ni regla de 5/2 minutos, y grid, martingala y
    // hedging están PERMITIDOS (T&C 1.2). Aplicarle las reglas de los demás
    // sería inventar infracciones que el cliente compró el derecho a no tener.
    orionNames: ['LEVERAGE X12', 'Leverage x12'],
    label: 'Accounts X12',
    maxDailyLossPct: 10,
    maxTotalLossPct: 10,
    // T&C 1.6: 1º 80% · 2º 90% · 3º 100%
    profitSplitByPeriod: [80, 90, 100],
    rules: [
      POST_SOLICITUD,
      { id: 'min_trading_days', label: '3 días operados en el período', checkable: true, params: { dias: 3 } },
      // Grid, martingala y hedging quedan fuera A PROPÓSITO: están permitidos
      // en este programa (T&C 1.2). Lo que sigue prohibido es lo de T&C 1.3 y
      // 1.5: arbitraje de latencia, sistemas de ticks/HFT, datos diferidos y
      // delegar la cuenta. O sea, PROHIBIDAS_SIEMPRE entero.
      ...PROHIBIDAS_SIEMPRE,
    ],
  },
];

/**
 * Reglamento del programa de un retiro.
 *
 * Devuelve `null` cuando el nombre no está en el registro, y el llamador tiene
 * que tratarlo como "no se puede revisar" en vez de caer a un reglamento por
 * defecto: aplicarle a un programa desconocido las reglas de otro produce
 * infracciones inventadas, que es peor que no revisar.
 */
export function rulesForProgram(orionName: string | null | undefined): ProgramRules | null {
  if (!orionName) return null;
  const limpio = orionName.trim().toUpperCase();
  return (
    PROGRAM_RULES.find((p) => p.orionNames.some((n) => limpio.startsWith(n.toUpperCase()))) ?? null
  );
}

/** Cuántas violaciones deniegan el retiro. T&C 14 y 3.6. */
export const VIOLATION_OUTCOME = {
  /** Hasta 3 operaciones pueden deducirse por consistencia y tiempo mínimo. */
  deductibleTrades: 3,
  /** 3 violaciones: denegado, pero se permite un período nuevo. */
  deniedWithNewPeriod: 3,
  /** 4 o más: denegado y sin período nuevo. */
  deniedNoNewPeriod: 4,
} as const;
