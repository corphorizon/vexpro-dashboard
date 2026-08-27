// ─────────────────────────────────────────────────────────────────────────────
// La producción IB del mes rollada por la MISMA estructura comercial que el net
// deposit: lotes pagados, comisión, PNL atribuido, cantidad de pagos por lotes y
// el desglose forex / sintéticos.
//
// Kevin, 2026-08-27: «Me gustaría tener el dato por estructura del PNL de cada
// BDM, de la cantidad de pagos por lotes y lotes movidos que se pagaron (basado
// en el crm, ya que tiene ciertas reglas para pagar), discriminar por activos de
// forex y activos sintéticos».
//
// EL ÁRBOL NO SE VUELVE A ARMAR: se llama a `buildForest` de net-deposit.ts, que
// es la única implementación del bosque por `head_id` del repo. Dos recorridos
// distintos de la misma jerarquía terminan siendo dos organigramas distintos en
// dos pantallas, y nadie se entera hasta que los totales no cierran.
//
// ── SIN DATO NO ES CERO ────────────────────────────────────────────────────
// `forexLots` y compañía son `number | null`. NULL significa "ese mes no está
// cubierto por el espejo de símbolos" (`ibrewards` se purga a los quince días,
// así que los meses anteriores a que el espejo empezara a correr NO TIENEN
// desglose y nunca lo van a tener). Cero significa "no operó sintéticos".
// Confundirlos haría que un head al que le falta el dato aparezca como si su
// gente no hubiera tocado un sintético en todo el mes.
//
// Al rollar hacia arriba: si NINGÚN nodo de una rama tiene desglose, el padre
// también queda en null. Si alguno lo tiene, el padre suma lo que hay y la
// pantalla lo marca como parcial — un total que mezcla ramas con y sin dato
// mentiría por defecto.
//
// ── EL PNL ES POR PERFIL, NO ES EL PNL DE LA EMPRESA ──────────────────────
// El `pnl` que devuelve el CRM es la ganancia del TRADER en las operaciones por
// las que ese IB cobró, y `ibrewards` la repite una vez por cada nivel de IB.
// Medido el 2026-08-25: la suma cruda da 1.942.516,76 y deduplicando por
// operación son 393.366,44 sobre 166.512 operaciones — 4,9 niveles de promedio.
//
// A nivel de PERFIL comercial no hay repetición (cada cliente cuelga de un único
// comercial, la cadena de sponsors corta en el más cercano), así que la columna
// es legítima por BDM y sumable dentro de una estructura. Lo que NO es es el PNL
// de la empresa, y la pantalla la rotula como "PNL atribuido" por eso.
//
// Todo en USD (`currency: 'USD'` en el 100% de las filas de las dos colecciones
// de origen, verificado). Los lotes son ESTÁNDAR: las cuentas cent ya vienen
// convertidas ÷100 en el origen.
// ─────────────────────────────────────────────────────────────────────────────

import { buildForest, type RollupProfile } from './net-deposit';

/** Lo que produce un perfil (o una estructura entera) en un mes. */
export type IbProduction = {
  /** Lotes estándar pagados. */
  lots: number;
  /** Comisión IB pagada, USD. */
  commission: number;
  /** PNL de las operaciones por las que se cobró, USD. Ver cabecera. */
  pnl: number;
  /** Cantidad de pagos por lotes (una fila de premio por operación y nivel). */
  rewards: number;
  /** IB distintos con actividad. */
  ibs: number;
  /** null = el mes no está cubierto por el espejo de símbolos. */
  forexLots: number | null;
  forexCommission: number | null;
  syntheticLots: number | null;
  syntheticCommission: number | null;
};

export type IbProductionNode = {
  profileId: string;
  name: string;
  role: string;
  headId: string | null;
  /** Lo de los IB que cuelgan DIRECTAMENTE de esta persona. */
  own: IbProduction;
  /** La suma de los `total` de sus miembros directos. */
  team: IbProduction;
  /** own + team: lo que esta estructura aporta hacia arriba. */
  total: IbProduction;
  children: IbProductionNode[];
};

export const EMPTY_PRODUCTION: IbProduction = {
  lots: 0, commission: 0, pnl: 0, rewards: 0, ibs: 0,
  forexLots: null, forexCommission: null, syntheticLots: null, syntheticCommission: null,
};

export function emptyProduction(): IbProduction {
  return { ...EMPTY_PRODUCTION };
}

/**
 * Suma dos partes NULABLES.
 *
 * null + null = null (sigue sin haber dato). null + n = n, y n + null = n: si
 * una rama tiene desglose y la otra no, el padre muestra lo que se sabe. La
 * alternativa —contagiar el null hacia arriba— dejaría en "sin dato" a toda una
 * estructura porque a un solo BDM le falta un mes, que es peor: se pierde
 * información que sí existe. La pantalla avisa que el mes es parcial.
 */
function addNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

export function addProduction(a: IbProduction, b: IbProduction): IbProduction {
  return {
    lots: a.lots + b.lots,
    commission: a.commission + b.commission,
    pnl: a.pnl + b.pnl,
    rewards: a.rewards + b.rewards,
    ibs: a.ibs + b.ibs,
    forexLots: addNullable(a.forexLots, b.forexLots),
    forexCommission: addNullable(a.forexCommission, b.forexCommission),
    syntheticLots: addNullable(a.syntheticLots, b.syntheticLots),
    syntheticCommission: addNullable(a.syntheticCommission, b.syntheticCommission),
  };
}

/**
 * Arma la estructura con la producción de cada uno.
 *
 * `byProfile` viene del RPC `hr_ib_production_by_profile` y NO trae a todos: un
 * perfil sin IB con actividad simplemente no aparece y vale cero — cero de
 * verdad, porque de ese perfil sí sabemos que no produjo. Lo que no se sabe es
 * el DESGLOSE, y eso es lo que viaja como null.
 *
 * Se ordena por comisión y no por lotes: es la plata que la empresa pagó, y
 * ordenar por lotes pondría arriba a quien mueve volumen sintético barato por
 * encima de quien mueve oro.
 */
export function buildIbProductionRollup(
  profiles: RollupProfile[],
  byProfile: Map<string, IbProduction>,
): IbProductionNode[] {
  return buildForest<IbProduction, IbProductionNode>(
    profiles,
    (p, own, team, total, children) => ({
      profileId: p.id,
      name: p.name,
      role: p.role,
      headId: p.head_id,
      own,
      team,
      total,
      children,
    }),
    (p) => byProfile.get(p.id) ?? emptyProduction(),
    addProduction,
    emptyProduction,
    (n) => n.total.commission,
  );
}

/** ¿Esta estructura movió algo? Sirve para no listar 126 filas en cero. */
export function hasProduction(n: IbProductionNode): boolean {
  return n.total.rewards > 0 || n.total.lots !== 0 || n.total.commission !== 0;
}
