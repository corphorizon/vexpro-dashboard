// ─────────────────────────────────────────────────────────────────────────────
// Tipos de movimiento de inversión (migración 062).
//
// Antes todo se distinguía leyendo el concepto en texto libre, así que
// "Retiros" mezclaba devolución de capital con cobro de ganancias. Con el tipo
// explícito se separan las dos preguntas que importan:
//   · ¿cuánto capital tengo colocado?   → aportes − devoluciones
//   · ¿cuánto gané y cuánto ya cobré?    → devengado − distribuido
//
// Registro único, como modules.ts y roles.ts: la lista de tipos vive acá y la
// consumen el formulario, la pantalla y cualquier reporte.
// ─────────────────────────────────────────────────────────────────────────────

export const INVESTMENT_MOVEMENT_TYPES = [
  'capital_in',
  'capital_out',
  'profit_accrued',
  'profit_paid',
  'mixed',
] as const;

export type InvestmentMovementType = (typeof INVESTMENT_MOVEMENT_TYPES)[number];

export interface MovementTypeDef {
  key: InvestmentMovementType;
  labelEs: string;
  /** Columna de importe que corresponde a este tipo. */
  field: 'deposit' | 'withdrawal' | 'profit';
  /** Cómo afecta al saldo del canal. */
  sign: 1 | -1 | 0;
  description: string;
}

export const MOVEMENT_TYPES: MovementTypeDef[] = [
  {
    key: 'capital_in',
    labelEs: 'Aporte de capital',
    field: 'deposit',
    sign: 1,
    description: 'Plata que entra a la inversión.',
  },
  {
    key: 'capital_out',
    labelEs: 'Devolución de capital',
    field: 'withdrawal',
    sign: -1,
    description: 'Retiro del capital invertido. NO es una ganancia cobrada.',
  },
  {
    key: 'profit_accrued',
    labelEs: 'Ganancia devengada',
    field: 'profit',
    sign: 1,
    description: 'Rendimiento generado, todavía sin cobrar.',
  },
  {
    key: 'profit_paid',
    labelEs: 'Ganancia distribuida',
    field: 'withdrawal',
    sign: -1,
    description: 'Ganancia que se cobró y salió de la inversión.',
  },
  {
    key: 'mixed',
    // Solo aparece en filas históricas; no se ofrece al cargar.
    labelEs: 'Mixto (a separar)',
    field: 'profit',
    sign: 0,
    description:
      'Fila vieja con ganancia y retiro en el mismo renglón. Hay que separarla en dos movimientos.',
  },
];

/** Los que se ofrecen al cargar. `mixed` queda afuera: es deuda histórica. */
export const SELECTABLE_MOVEMENT_TYPES = MOVEMENT_TYPES.filter((m) => m.key !== 'mixed');

export function movementTypeDef(key?: string | null): MovementTypeDef | null {
  if (!key) return null;
  return MOVEMENT_TYPES.find((m) => m.key === key) ?? null;
}

export function movementTypeLabel(key?: string | null): string {
  return movementTypeDef(key)?.labelEs ?? 'Sin clasificar';
}

interface AmountRow {
  deposit: number;
  withdrawal: number;
  profit: number;
  movement_type?: string | null;
}

/**
 * Deriva el tipo de una fila que no lo tiene, con la misma heurística del
 * backfill: el concepto desempata un retiro entre devolución de capital y
 * cobro de ganancias.
 */
export function inferMovementType(
  row: AmountRow & { concept?: string | null },
): InvestmentMovementType | null {
  if (row.movement_type) return row.movement_type as InvestmentMovementType;
  if (row.profit > 0 && row.withdrawal > 0) return 'mixed';
  if (row.deposit > 0) return 'capital_in';
  if (row.profit > 0) return 'profit_accrued';
  if (row.withdrawal > 0) {
    return /profit|ganancia|reparticion|repartición/i.test(row.concept ?? '')
      ? 'profit_paid'
      : 'capital_out';
  }
  return null;
}

export interface InvestmentTotals {
  /** Aportes − devoluciones: la plata que sigue colocada. */
  capitalPlaced: number;
  contributions: number;
  redemptions: number;
  /** Ganancia generada en total. */
  profitAccrued: number;
  /** Ganancia ya cobrada. */
  profitPaid: number;
  /** Devengada − distribuida: ganancia acumulada sin cobrar. */
  profitPending: number;
  /** Saldo del canal — coincide con Σ(aporte − retiro + ganancia). */
  balance: number;
  /** Filas que todavía arrastran el formato viejo. */
  mixedCount: number;
}

/**
 * Totales tipificados. El `balance` se calcula con la fórmula de siempre para
 * que NO pueda separarse del que muestran Balances y los reportes; los demás
 * números son los que la tipificación hace posibles.
 */
export function computeInvestmentTotals(
  rows: Array<AmountRow & { concept?: string | null }>,
): InvestmentTotals {
  let contributions = 0, redemptions = 0, profitAccrued = 0, profitPaid = 0, mixedCount = 0;
  let balance = 0;

  for (const r of rows) {
    balance += r.deposit - r.withdrawal + r.profit;
    const type = inferMovementType(r);

    if (type === 'mixed') {
      mixedCount += 1;
      // Una fila mixta es una ganancia devengada Y cobrada a la vez. Contarla
      // en los dos lados la deja neutra, que es lo que realmente representa.
      profitAccrued += r.profit;
      profitPaid += r.withdrawal;
      continue;
    }

    if (type === 'capital_in') contributions += r.deposit;
    else if (type === 'capital_out') redemptions += r.withdrawal;
    else if (type === 'profit_accrued') profitAccrued += r.profit;
    else if (type === 'profit_paid') profitPaid += r.withdrawal;
  }

  return {
    contributions,
    redemptions,
    capitalPlaced: contributions - redemptions,
    profitAccrued,
    profitPaid,
    profitPending: profitAccrued - profitPaid,
    balance,
    mixedCount,
  };
}
