// ─────────────────────────────────────────────────────────────────────────────
// REGISTRO ÚNICO: qué símbolo es sintético y qué símbolo es forex/CFD.
//
// Kevin lo pidió así: «discriminar por activos de forex y activos sintéticos».
// Esta es la ÚNICA lista de patrones del repo. Se exporta, se testea, y la
// clasificación se materializa en el espejo (`crm_ib_reward_symbol_daily`) para
// que ni la SQL ni la pantalla tengan que repetirla. Si mañana el bróker suma
// una familia nueva de sintéticos, se toca acá y en ningún otro lado.
//
// ── POR QUÉ POR NOMBRE Y NO POR GRUPO ──────────────────────────────────────
// `symbolCategory` viene NULL en las 11.829.132 filas de `ibrewards` (medido
// 2026-08-27), así que el origen no clasifica. El grupo de la cuenta
// (`groupName`) tampoco sirve: un sintético se opera igual desde una cuenta que
// NO es de grupo Synthetics. Medido sobre esos 11,8M de premios:
//
//     "Volatility 25 Index"   984 filas en grupo Synthetics ·  65.834 en otros
//     "Volatility 50 (1s)"    309 filas en grupo Synthetics ·  20.130 en otros
//     "SFX Vol 20"             11 filas en grupo Synthetics ·  43.492 en otros
//
// Clasificar por grupo mandaría el 97% de esos sintéticos al lado de forex.
//
// ── EL GRUPO SÍ SIRVE COMO SEGUNDA FUENTE, Y CIERRA PERFECTO ───────────────
// La implicación al revés sí vale: de los 168 símbolos distintos, TODOS los que
// alguna vez aparecen bajo un grupo `Synthetics*` pertenecen a una de las
// familias de abajo, y NINGÚN símbolo de forex/CFD (XAUUSD*, EURUSD*, NAS100*,
// US30*, SP500*, BTCUSD, ETHUSD, XAGUSD, GER40, JPN225…) aparece jamás bajo un
// grupo Synthetics. Cero contaminación cruzada en 168 símbolos. Esa es la
// validación de esta lista contra una fuente independiente del nombre.
//
// ── LA TRAMPA DE "FX Vol" ──────────────────────────────────────────────────
// "FX Vol 20/40/60/80/99" y "SFX Vol 20/40/60/80/99" llevan FX en el nombre y
// NO son forex: son índices de volatilidad sintéticos (48.428 y 43.503 premios
// respectivamente). Por eso la clasificación es por FAMILIA con anclaje al
// principio del nombre y no por "contiene FX" — una regla de subcadena los
// mandaría al lado equivocado, y de paso mandaría "FlipX" con ella.
// ─────────────────────────────────────────────────────────────────────────────

/** Las dos clases. No hay una tercera: lo que no es sintético, es forex/CFD. */
export const ASSET_CLASSES = ['forex', 'synthetic'] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

/**
 * Las familias de sintéticos, ancladas al comienzo del nombre.
 *
 * Las diez primeras salen del universo medido (168 símbolos, 11,8M premios,
 * ventana 2026-08-13 → 2026-08-27). Las últimas son familias hermanas del mismo
 * proveedor que hoy NO aparecen en los datos: se dejan puestas a propósito
 * porque el bróker habilita símbolos nuevos sin avisar, y el costo de tenerlas
 * de más es cero mientras que el de que falten es que un mes entero de lotes
 * sintéticos se cuente como forex.
 */
export const SYNTHETIC_SYMBOL_PATTERNS: readonly RegExp[] = [
  // Familias observadas, con los lotes que movieron en la ventana medida.
  /^Boom\b/i,               // 36.665 lotes
  /^Crash\b/i,              // 34.303 lotes
  /^Step\s+Index\b/i,       // 11.326 lotes
  /^Volatility\b/i,         //  7.372 lotes
  /^GainX\b/i,              //  9.583 lotes
  /^PainX\b/i,              //  9.273 lotes
  /^TrendX\b/i,             // 10.284 lotes
  /^SwitchX\b/i,            //  9.248 lotes
  /^FlipX\b/i,              //    957 lotes
  /^BreakX\b/i,             //      0,40 lotes
  /^Jump\b/i,               //    133 lotes
  /^DEX\b/i,                //     35 lotes (DEX 600/900/1500 UP|DOWN Index)
  /^S?FX\s+Vol\b/i,         //    711 lotes — ver "la trampa de FX Vol"
  // Familias hermanas todavía no vistas en los datos de Vex Pro.
  /^Range\s+Break\b/i,
  /^Drift\s+Switch\b/i,
  /^(Bear|Bull)\s+Market\b/i,
  /^Multi\s+Step\b/i,
];

/**
 * La clase de un símbolo. Un símbolo vacío o nulo cuenta como forex/CFD: es la
 * clase por defecto y la mayoritaria (16.987 de los 17.660 lotes de XAUUSD.
 * solos), y devolver null obligaría a cada llamador a inventar un tercer caso.
 */
export function classifyAssetClass(symbol: string | null | undefined): AssetClass {
  const s = (symbol ?? '').trim();
  if (!s) return 'forex';
  return SYNTHETIC_SYMBOL_PATTERNS.some((re) => re.test(s)) ? 'synthetic' : 'forex';
}

export function isAssetClass(v: unknown): v is AssetClass {
  return typeof v === 'string' && (ASSET_CLASSES as readonly string[]).includes(v);
}
