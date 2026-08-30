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

// ─────────────────────────────────────────────────────────────────────────────
// LA MISMA PREGUNTA, DEL LADO DEL CRM — Y NO SE RESPONDE IGUAL
//
// `esGrupoDemo` sirve para el `Group` de MT5 (`demo\Broker\Synthetics`). Las
// tablas del CRM guardan otra cosa: `crm_trading_accounts.group_name` es un
// nombre corto —`SYNTHETICS`, `CENT`, `STP_Bonus1`— que NO distingue demo de
// real. La cuenta 149426 es `demo\Broker\Synthetics` en MT5 y `SYNTHETICS` a
// secas en el CRM.
//
// Filtrar el `group_name` del CRM con la regla de MT5 no da error: devuelve
// `false` para TODAS y deja pasar las demo enteras. Es exactamente el fallo que
// este repo persigue —un resultado plausible y equivocado— y ya se cometió una
// vez, el 2026-08-29.
//
// Lo que el CRM sí trae es `is_live`. Contrastado contra el `Group` de MT5 el
// 2026-08-30: 370 cuentas, CERO desacuerdos (36 con `is_live=false` eran demo,
// 334 con `is_live=true` eran reales).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Si una cuenta del CRM es demo.
 *
 * `is_live` en `null` devuelve `false`, igual que un grupo desconocido: "no
 * sabemos" no es "es demo", y excluir por las dudas escondería cuentas reales.
 */
export function esCuentaDemoCrm(cuenta: { is_live?: boolean | null }): boolean {
  return cuenta.is_live === false;
}
