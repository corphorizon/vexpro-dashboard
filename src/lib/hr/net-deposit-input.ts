// ─────────────────────────────────────────────────────────────────────────────
// EL INSUMO DEL MOTOR DE COMISIONES: de dónde sale `netDepositCurrent`.
//
// Este archivo NO calcula comisiones. La fórmula vive —y sigue viviendo sola—
// en src/lib/commission-calculator.ts, que no se toca: división = net/2, base =
// división + acumulado, comisión = base × %, sin clamp, con el acumulado
// intacto cuando el ND es 0. Acá se decide UNA cosa: qué número entra como
// `netDepositCurrent`.
//
// ── El porqué ──────────────────────────────────────────────────────────────
// Hasta agosto 2026 ese número se tecleaba a mano en `commercial_monthly_
// results.net_deposit_current`, uno por persona y por mes, mirando el panel del
// CRM. Desde las migraciones 113/114/115 la RPC `hr_net_deposit_by_profile`
// reproduce ese mismo trabajo (sube la cadena de sponsors cliente por cliente)
// y cuadra contra el panel de Orion. Kevin, 2026-08-31: el automático manda; lo
// cargado a mano es un OVERRIDE explícito y la pantalla lo tiene que decir.
//
// ── LA SEMÁNTICA, medida contra julio 2026 (el mes con manual completo) ─────
// El rollup atribuye por ESTRUCTURA: `own` es lo que producen los clientes que
// cuelgan directamente de esa persona, `total` = own + subárbol. Lo que el
// motor espera NO es siempre el mismo campo — depende de en qué renglón está
// esa persona en /comisiones:
//
//   · MIEMBRO de un grupo (BDM, BDM GLOBAL, o un HEAD que aparece bajo su
//     head) → `net_deposit_current` de esa fila = TOTAL de su estructura.
//     Julio 2026, manual vs `total` del rollup:
//       Sebastián Eduardo González  27.062   vs  27.062,79
//       Víctor Joel Del Ángel      −15.712   vs −15.712,80
//       Diego Cordero Jiménez      −10.366   vs −10.366,93
//       José David Rivera            8.194   vs   8.194,04
//       Javier Vergara               5.441   vs   5.441,26
//       Roberto Aruani              −2.661   vs  −2.661,42
//     (Un BDM sin equipo tiene `own === total`, así que la regla es una sola.)
//
//   · EL HEAD EN SU PROPIO GRUPO → su ND personal = `own`, que es exactamente
//     la «línea de ajuste» que Daniela calcula de memoria (ver la cabecera de
//     net-deposit.ts). En la base ese número vive en `net_deposit_accumulated`
//     de la fila del head en su propio grupo. Julio 2026, ese campo vs `own`:
//       Nicolás Santamaría   −2.702  vs  −2.701,51
//       Diego Cordero        −4.119  vs  −4.119,95
//       Martín Noval         15.844  vs  15.843,92
//       Ricardo Osuna          −535  vs    −535,00
//       Víctor Joel Del Ángel  −509  vs    −508,34
//       Luka Angeles        −11.228  vs −11.228,65  ← el ajuste documentado
//     Y el head SIN padre (Hugo Ortiz) lo lleva en `net_deposit_current` de su
//     propia fila: −3.489, contra `own` −4.691 (el −3.489 es el número citado
//     en la migración 097 con las llaves viejas de monto).
//
// Por eso `scope`: 'structure' (miembro) → total, 'own' (el head mirándose a sí
// mismo) → own. Confundirlos es el bug caro: darle a Luka su `own` (−11.228)
// donde el motor espera su estructura (496.374) le borra medio millón de base.
//
// ── EL CORTE TEMPORAL ──────────────────────────────────────────────────────
// Mismo precedente que `BROKER_PNL_AUTO_DESDE` (broker-pnl.ts:201): automático
// desde AGOSTO 2026, y todo lo anterior queda como estaba. Acá además coincide
// con el estado real de la base: en Vex Pro los períodos 2025-10 … 2026-07
// están CERRADOS y sólo 2026-08 está abierto. Las dos reglas —cerrado y
// anterior al corte— apuntan al mismo lado, y se aplican las dos porque son
// independientes: un período puede cerrarse tarde (a julio-26 le pasó en el
// broker P&L) y un tenant nuevo puede no cerrar nunca.
//
// Lo que NO se hace y por qué: no se reprocesa el histórico. La cadena de
// comisiones es secuencial (el acumulado y la deuda se arrastran), así que
// cambiarle el insumo a un mes viejo mueve TODOS los meses siguientes y la
// plata ya pagada. Si algún día hay que hacerlo, es una migración de datos con
// su propia decisión, no un efecto colateral de esta función.
//
// ── GUARDAR FIJA EL MES (y eso es deliberado) ──────────────────────────────
// Cuando alguien aprieta Guardar en /comisiones, el número que había en el
// input —venga del CRM o no— se escribe en `net_deposit_current`. A partir de
// ahí ese mes se lee como OVERRIDE y el rótulo dice «manual», con el automático
// al lado como referencia. No es un efecto colateral que haya que tapar: es la
// definición de override. Guardar es el acto por el que una persona fija lo que
// se le va a pagar a otra, y si el CRM se mueve después (un depósito que se
// concilia tarde) lo pagado no puede cambiar solo. Quien quiera volver al
// automático borra el campo y vuelve a guardar.
//
// ── null ≠ 0 ───────────────────────────────────────────────────────────────
// `value: null` es "no lo sabemos" y la pantalla muestra «sin datos», nunca $0.
// El motor necesita un número igual (el ND=0 tiene un significado propio: no
// paga nada pero CONSERVA el acumulado, commission-calculator.ts:46-64), así
// que la traducción a número está aparte y con nombre: `netParaElMotor()`.
// ─────────────────────────────────────────────────────────────────────────────

import { flattenRollup, type RollupNode } from './net-deposit';

/**
 * De dónde salió el número.
 *
 * · `crm`    — el rollup automático del mes.
 * · `manual` — hay un override cargado a mano y ese manda.
 * · `frozen` — período cerrado o anterior al corte: manda lo guardado, sin
 *              mirar el CRM. Se distingue de `manual` a propósito: uno es una
 *              decisión de este mes, el otro es historia que no se toca.
 * · `none`   — no hay ni uno ni otro. `value` es `null`.
 */
export type NetDepositSource = 'crm' | 'manual' | 'frozen' | 'none';

/** En qué renglón está la persona. Ver «LA SEMÁNTICA» arriba. */
export type NetDepositScope = 'own' | 'structure';

export interface NetDepositPeriodLike {
  year: number;
  month: number;
  is_closed?: boolean | null;
}

/** `own`/`total` del rollup, por perfil. */
export type CrmNetIndex = ReadonlyMap<string, { own: number; total: number }>;

export interface ResolvedNetDeposit {
  /** El número a mostrar. `null` = SIN DATOS; la pantalla no muestra $0. */
  value: number | null;
  source: NetDepositSource;
  /** El automático del mes, para mostrarlo al lado del override. `null` = no se pudo calcular. */
  crm: number | null;
  /** Lo cargado a mano, tal cual. `null` = no hay fila / no se leyó. */
  manual: number | null;
}

/**
 * Corte del automático: AGOSTO 2026 en adelante. Mismo criterio y misma forma
 * que `BROKER_PNL_AUTO_DESDE`; ver el bloque «EL CORTE TEMPORAL» arriba.
 */
export const HR_NET_AUTO_DESDE = { year: 2026, month: 8 } as const;

export function antesDelCorteHrNet(period: NetDepositPeriodLike): boolean {
  return (
    period.year * 100 + period.month <
    HR_NET_AUTO_DESDE.year * 100 + HR_NET_AUTO_DESDE.month
  );
}

/**
 * El árbol del rollup como índice O(1) por perfil.
 *
 * Un perfil que no aparece en el árbol NO está acá, y el resolver lo trata como
 * "el CRM no sabe de esta persona" (→ `crm: null`), no como cero: el árbol se
 * arma con TODOS los perfiles, así que faltar es una anomalía, no un mes flojo.
 */
export function indexarNetDelCrm(tree: readonly RollupNode[]): Map<string, { own: number; total: number }> {
  const out = new Map<string, { own: number; total: number }>();
  for (const { node } of flattenRollup(tree as RollupNode[])) {
    out.set(node.profileId, { own: node.own, total: node.total });
  }
  return out;
}

/**
 * ¿Ese manual es un override de verdad?
 *
 * `0` NO cuenta. El input de /comisiones arranca en 0 y guarda 0 sin que nadie
 * teclee nada: tratar ese 0 como "lo cargaron a mano" apagaría el automático
 * para media empresa en silencio, que es el modo de falla de §1.2. `null`
 * tampoco: es "no hay fila". Un negativo SÍ es un override (los ND negativos
 * son reales y frecuentes: retiros > depósitos).
 */
export function esOverrideManual(manual: number | null | undefined): boolean {
  return manual !== null && manual !== undefined && manual !== 0;
}

/**
 * EL insumo `netDepositCurrent` de una persona en un mes, con su procedencia.
 *
 * Es el registro único de esta decisión: /comisiones y /rrhh la consumen igual,
 * así que no puede haber dos pantallas mostrando distinto insumo para el mismo
 * mes y la misma persona.
 */
export function resolveNetDepositInput(params: {
  profileId: string;
  period: NetDepositPeriodLike;
  scope: NetDepositScope;
  /** El índice del rollup. `null` = no se pudo leer (slice caído, o mes congelado que ni se pidió). */
  crm: CrmNetIndex | null;
  /** Lo cargado a mano para esa persona en ese mes. `null` = no hay fila. */
  manual: number | null | undefined;
}): ResolvedNetDeposit {
  const { profileId, period, scope, crm, manual } = params;

  const nodo = crm?.get(profileId);
  const auto = nodo ? (scope === 'own' ? nodo.own : nodo.total) : null;
  const man = manual === undefined ? null : manual;

  // Regla 1 — historia congelada. Ni se mira el CRM: el número que se pagó es
  // el que quedó guardado.
  if (period.is_closed || antesDelCorteHrNet(period)) {
    return {
      value: man,
      source: man === null ? 'none' : 'frozen',
      crm: auto,
      manual: man,
    };
  }

  // Regla 2 — override explícito. Quien cargó a mano ese mes, manda.
  if (esOverrideManual(man)) {
    return { value: man, source: 'manual', crm: auto, manual: man };
  }

  // Regla 3 — el automático.
  if (auto !== null) {
    return { value: auto, source: 'crm', crm: auto, manual: man };
  }

  // Regla 4 — no hay nada. `null`, no 0.
  return { value: null, source: 'none', crm: null, manual: man };
}

/**
 * El número que entra al motor.
 *
 * SIN DATOS entra como 0 y eso es correcto, no un parche: `calculateCommission`
 * trata el 0 como "no se paga nada este mes pero el acumulado se conserva
 * intacto" (commission-calculator.ts:46-64), que es exactamente lo que
 * corresponde cuando no sabemos cuánto produjo. Lo que NO se puede hacer es
 * mostrar ese 0 en pantalla como si fuera un dato: para eso está `source`.
 */
export function netParaElMotor(r: ResolvedNetDeposit): number {
  return r.value ?? 0;
}
