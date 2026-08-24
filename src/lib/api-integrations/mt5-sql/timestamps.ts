// ─────────────────────────────────────────────────────────────────────────────
// Marcas de tiempo del SQL Export de MT5.
//
// `mt5_deals.Timestamp` NO es una fecha SQL: es una marca de Windows, en
// intervalos de 100 nanosegundos desde el 1/1/1601 UTC. Sin convertir se ve
// como un entero de 18 dígitos que no le dice nada a nadie.
//
// Vive acá y no en la ruta del sondeo porque un archivo `route.ts` de Next
// sólo debería exportar sus métodos HTTP, y porque esto va a hacer falta en
// cualquier lectura futura de deals.
// ─────────────────────────────────────────────────────────────────────────────

/** Intervalos de 100 ns entre el 1/1/1601 y el 1/1/1970. */
const EPOCH_1601_TO_1970 = BigInt('116444736000000000');
const TICKS_PER_MS = BigInt(10000);
const ZERO = BigInt(0);

/**
 * Convierte una marca de MT5 a ISO. Devuelve null cuando el valor no tiene la
 * forma esperada, para que el llamador muestre el crudo en vez de inventar una
 * fecha: un dato ausente es honesto, una fecha equivocada engaña.
 */
export function mt5TimestampToIso(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let n: bigint;
  try {
    n = typeof raw === 'bigint' ? raw : BigInt(String(raw).trim() || '0');
  } catch {
    return null;
  }
  if (n <= ZERO) return null;

  const ms = Number((n - EPOCH_1601_TO_1970) / TICKS_PER_MS);
  if (!Number.isFinite(ms)) return null;

  const d = new Date(ms);
  const year = d.getUTCFullYear();
  // Cordura: fuera de este rango el valor no era una marca de MT5.
  if (year < 2000 || year > 2100) return null;
  return d.toISOString();
}
