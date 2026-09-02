// ─────────────────────────────────────────────────────────────────────────────
// Datos de PRUEBA del hedge fund — registro ÚNICO de exclusiones.
//
// ── POR QUÉ ESTE ARCHIVO EXISTE ────────────────────────────────────────────
// El censo del CRM del 2026-09-02 encontró, dentro de las 22 inversiones de AP
// Markets, un fondo de pruebas (`qa-tst`) y un usuario de pruebas
// (702d25d4-…, "Dev Sup"). Si entraran a las cifras, el capital bajo gestión y
// el pasivo con clientes saldrían inflados con plata que no existe: el fallo
// que no da error.
//
// La lista vive ACÁ y en ningún otro lado. Es la lección de
// `crm-sync/account-scope.ts`, donde las cuentas de prueba sin filtrar
// inflaron el PNL del día de 6.198 a 12.836, y la del §1.1 del repo: una
// segunda lista de exclusiones que se desincroniza deja una pantalla filtrando
// y otra no, con dos números distintos para la misma pregunta.
//
// ── LO QUE SE DESCARTÓ ─────────────────────────────────────────────────────
// El criterio inicial era «fondos TERMINATED cuyo nombre contenga TAQ». Se
// descartó por dos razones: (a) un fondo TERMINATED puede ser un fondo REAL
// que se cerró, y excluirlo borraría dinero de clientes reales del histórico;
// (b) buscar por substring en un nombre escrito a mano es un filtro que se
// rompe con un espacio. La exclusión es por LLAVE EXACTA y por nada más.
//
// ── LA REGLA QUE ACOMPAÑA A TODA EXCLUSIÓN ─────────────────────────────────
// Excluir sin contar es indistinguible de un cruce roto (§1.2). Por eso todo
// lo que se filtra con estas listas devuelve además un `excluded` con el
// conteo, y las pantallas dibujan «N excluidos (pruebas)» cuando N > 0.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fondos de prueba, por `fundKey` EXACTO.
 * `qa-tst` — AP Markets, status TERMINATED, censado el 2026-09-02.
 */
export const HEDGE_FUND_TEST_FUND_KEYS: readonly string[] = ['qa-tst'];

/**
 * Usuarios de prueba, por `userId` EXACTO de Orion (= `user_external_id` en
 * nuestro espejo).
 * `702d25d4-1b37-4528-a676-2b027f985d95` — "Dev Sup", AP Markets.
 */
export const HEDGE_FUND_TEST_USER_IDS: readonly string[] = [
  '702d25d4-1b37-4528-a676-2b027f985d95',
];

const FUND_SET: ReadonlySet<string> = new Set(HEDGE_FUND_TEST_FUND_KEYS);
const USER_SET: ReadonlySet<string> = new Set(HEDGE_FUND_TEST_USER_IDS);

export function isTestFundKey(fundKey: unknown): boolean {
  return typeof fundKey === 'string' && FUND_SET.has(fundKey);
}

export function isTestUserId(userId: unknown): boolean {
  return typeof userId === 'string' && USER_SET.has(userId);
}

/** Lo que se descartó, con nombre. Nunca `boolean`: hay que poder decir POR QUÉ. */
export type HedgeFundExclusionReason = 'test_fund' | 'test_user';

export function exclusionReason(row: {
  fund_key?: string | null;
  user_external_id?: string | null;
}): HedgeFundExclusionReason | null {
  if (isTestFundKey(row.fund_key)) return 'test_fund';
  if (isTestUserId(row.user_external_id)) return 'test_user';
  return null;
}

/**
 * Parte una lista en lo que entra a las cifras y lo que queda afuera CONTADO.
 *
 * Devuelve las dos cosas a propósito: el llamador no puede quedarse con
 * `kept` sin ver `excluded`, que es exactamente el descuido que la regla del
 * repo persigue.
 */
export function splitTestData<T extends { fund_key?: string | null; user_external_id?: string | null }>(
  rows: readonly T[],
): { kept: T[]; excluded: T[]; excludedCount: number; byReason: Record<HedgeFundExclusionReason, number> } {
  const kept: T[] = [];
  const excluded: T[] = [];
  const byReason: Record<HedgeFundExclusionReason, number> = { test_fund: 0, test_user: 0 };
  for (const row of rows) {
    const reason = exclusionReason(row);
    if (reason) {
      excluded.push(row);
      byReason[reason]++;
    } else {
      kept.push(row);
    }
  }
  return { kept, excluded, excludedCount: excluded.length, byReason };
}
