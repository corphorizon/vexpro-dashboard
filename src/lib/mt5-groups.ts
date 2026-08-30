// ─────────────────────────────────────────────────────────────────────────────
// Qué es una cuenta demo, en un solo lugar.
//
// La regla del repo es que el `Group` de MT5 empiece con `demo`. Estaba escrita
// a mano en varios archivos —`NOT LIKE 'demo%'` en `mt5-sync/pnl.ts` y
// `mt5-sync/exposure.ts`, `.startsWith('demo')` en `trading-activity.ts`— y las
// listas duplicadas que se desincronizan en silencio son el modo de falla
// número uno de este repo.
//
// Acá queda la versión compartida. Las copias viejas siguen en su lugar:
// migrarlas es un cambio aparte, en código que no es de este módulo.
//
// ── POR QUÉ IMPORTA ────────────────────────────────────────────────────────
// Medido el 2026-08-28 en Vex Pro: 2.290 cuentas demo, casi todas en
// `demo\Broker\Synthetics` (1.496). Analizarlas gasta presupuesto de consultas
// a MT5 en cuentas que nadie va a revisar, y ensucia la pantalla de retiros con
// diagnósticos de dinero que no existe.
// ─────────────────────────────────────────────────────────────────────────────

/** El prefijo que marca un grupo de demo en MT5. */
const PREFIJO_DEMO = 'demo';

/**
 * Si el grupo es de una cuenta demo.
 *
 * Un grupo `null` o vacío devuelve `false`: "no sabemos el grupo" no es "es
 * demo", y excluir por las dudas escondería cuentas reales sin dejar rastro.
 * Quien necesite tratar el desconocido distinto tiene que decidirlo aparte.
 */
export function esGrupoDemo(grupo: string | null | undefined): boolean {
  if (!grupo) return false;
  return grupo.trim().toLowerCase().startsWith(PREFIJO_DEMO);
}

/** El fragmento SQL equivalente, para las consultas que filtran en el motor. */
export const SQL_NO_DEMO = "`Group` NOT LIKE 'demo%'";
