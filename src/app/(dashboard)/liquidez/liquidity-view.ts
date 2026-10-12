// ─────────────────────────────────────────────────────────────────────────────
// Decisiones puras de /liquidez y /liquidez/conciliacion (rediseño «Libro
// mayor», 2026-10-12). Viven acá para testearlas sin montar la pantalla.
//
// · `attributionGap`: el desglose por cuenta MT contra el saldo total. ANTES
//   la pantalla comparaba lo atribuido (saldo de SIEMPRE, por cuenta) contra el
//   saldo al cierre del MES FILTRADO: con «Mar» elegido decía «faltan $X por
//   atribuir» cuando no faltaba nada — sólo estaba mirando otra fecha. Ahora la
//   comparación es siempre contra el saldo de todo el histórico.
// · `splitCheck`: dividir no puede crear ni perder plata. La pantalla compara
//   el original (A) contra la suma de las partes (B) mientras se escribe; el
//   endpoint y la RPC lo vuelven a validar.
// ─────────────────────────────────────────────────────────────────────────────

/** Medio centavo: la tolerancia que ya usaban la pantalla y el endpoint. */
export const CENT_TOLERANCE = 0.01;

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface AttributionGap {
  /** Total − atribuido. Positivo = falta atribuir; negativo = se atribuyó de más. null = no hay total. */
  gap: number | null;
  /** Cuadra al centavo. false también cuando no hay total contra qué comparar. */
  matches: boolean;
}

export function attributionGap(attributed: number, total: number | null): AttributionGap {
  if (total === null || !Number.isFinite(total)) return { gap: null, matches: false };
  const gap = round2(total - attributed);
  return { gap, matches: Math.abs(gap) < CENT_TOLERANCE };
}

/** Saldo por cuenta con movimientos, ordenado de mayor a menor. Las cuentas en cero no aportan nada a la vista. */
export function accountBalanceRows<A extends { id: string }>(
  accounts: A[],
  balancesByAccount: Record<string, number>,
): Array<A & { balance: number }> {
  return accounts
    .filter((a) => typeof balancesByAccount[a.id] === 'number' && Math.abs(balancesByAccount[a.id]) > 0.005)
    .map((a) => ({ ...a, balance: balancesByAccount[a.id] }))
    .sort((a, b) => b.balance - a.balance);
}

export interface SplitPartInput {
  deposit: string;
  withdrawal: string;
}

export interface SplitCheck {
  /** Suma de las partes (B). */
  dep: number;
  wit: number;
  /** Partes − original. Positivo = sobra; negativo = falta. */
  diffDep: number;
  diffWit: number;
  ok: boolean;
}

/** Un campo vacío es 0 (todavía no se escribió); uno no numérico también — el OK lo frena igual. */
function partAmount(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function splitCheck(
  parts: SplitPartInput[],
  original: { deposit: number; withdrawal: number },
): SplitCheck {
  const dep = round2(parts.reduce((s, p) => s + partAmount(p.deposit), 0));
  const wit = round2(parts.reduce((s, p) => s + partAmount(p.withdrawal), 0));
  const diffDep = round2(dep - original.deposit);
  const diffWit = round2(wit - original.withdrawal);
  return {
    dep,
    wit,
    diffDep,
    diffWit,
    ok: Math.abs(diffDep) < CENT_TOLERANCE && Math.abs(diffWit) < CENT_TOLERANCE,
  };
}
