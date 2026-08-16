// ─────────────────────────────────────────────────────────────────────────────
// Precio spot de los activos nativos de gas (migración 085).
//
// POR QUÉ HAY QUE COTIZAR ALGO
// El USDT se cuenta 1:1 — cotizarlo sería agregarle ruido a un dólar. Pero la
// wallet también guarda un poco de TRX / BNB / ETH "para validar
// transacciones", y eso ES plata de la empresa: hoy son ~$73 en TRX y ~$5 en
// BNB. Para sumarlos al balance hay que pasarlos a dólares, y para eso hace
// falta un precio.
//
// CoinGecko público alcanza: una llamada por corrida del cron, sin key
// (COINGECKO_API_KEY es opcional y solo sube la cuota). El resultado se cachea
// EN MEMORIA por unos minutos para que una corrida con 20 empresas haga UNA
// sola llamada y no 20 — el precio del gas no se mueve entre empresa y empresa.
//
// FAIL-CLOSED: si no hay precio, quien llama decide. Este módulo nunca inventa
// un valor ni devuelve 0 — un 0 inventado se vería como plata que desapareció.
// ─────────────────────────────────────────────────────────────────────────────

export const NATIVE_SYMBOLS = ['TRX', 'BNB', 'ETH'] as const;
export type NativeSymbol = (typeof NATIVE_SYMBOLS)[number];

/** Cómo se llama cada activo en CoinGecko. */
export const COINGECKO_IDS: Record<NativeSymbol, string> = {
  TRX: 'tron',
  BNB: 'binancecoin',
  ETH: 'ethereum',
};

export type NativePriceMap = Partial<Record<NativeSymbol, number>>;

export interface NativePrices {
  prices: NativePriceMap;
  /** Cuándo se leyó el precio — queda guardado con el snapshot para auditar. */
  at: string;
}

const TIMEOUT_MS = 10_000;
/** Ventana del caché en memoria: cubre una corrida entera del cron. */
const CACHE_MS = 5 * 60_000;

let cache: { value: NativePrices; expires: number } | null = null;

/** Solo para los tests: borra el caché entre casos. */
export function resetNativePriceCache(): void {
  cache = null;
}

function parsePrices(json: unknown): NativePriceMap {
  const out: NativePriceMap = {};
  if (!json || typeof json !== 'object') return out;
  const record = json as Record<string, unknown>;
  for (const symbol of NATIVE_SYMBOLS) {
    const entry = record[COINGECKO_IDS[symbol]];
    if (!entry || typeof entry !== 'object') continue;
    const usd = (entry as Record<string, unknown>).usd;
    const n = typeof usd === 'number' ? usd : Number(usd);
    if (Number.isFinite(n) && n > 0) out[symbol] = n;
  }
  return out;
}

/**
 * Precio USD de TRX / BNB / ETH. Nunca lanza: si falla devuelve `{error}` y el
 * caller decide si eso bloquea el canal (saldo nativo relevante) o no (saldo
 * nativo despreciable).
 */
export async function fetchNativePrices(): Promise<
  { prices: NativePriceMap; at: string; error?: undefined } | { error: string; prices?: undefined; at?: undefined }
> {
  if (cache && cache.expires > Date.now()) return cache.value;

  const url = new URL('https://api.coingecko.com/api/v3/simple/price');
  url.searchParams.set('ids', NATIVE_SYMBOLS.map((s) => COINGECKO_IDS[s]).join(','));
  url.searchParams.set('vs_currencies', 'usd');

  const headers: Record<string, string> = { Accept: 'application/json' };
  const key = process.env.COINGECKO_API_KEY?.trim();
  if (key) headers['x-cg-demo-api-key'] = key;

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      return { error: `CoinGecko ${res.status} ${res.statusText}: ${text.slice(0, 200)}` };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { error: `CoinGecko respondió algo que no es JSON: ${text.slice(0, 200)}` };
    }
    const prices = parsePrices(json);
    if (Object.keys(prices).length === 0) {
      return { error: `CoinGecko no devolvió ningún precio reconocible: ${text.slice(0, 200)}` };
    }
    const value: NativePrices = { prices, at: new Date().toISOString() };
    cache = { value, expires: Date.now() + CACHE_MS };
    return value;
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { error: 'Timeout consultando el precio del gas en CoinGecko.' };
    }
    return { error: err instanceof Error ? err.message : 'Error desconocido consultando CoinGecko' };
  }
}
