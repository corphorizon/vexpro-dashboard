// ─────────────────────────────────────────────────────────────────────────────
// Saldo de una wallet propia leído de la blockchain (migración 085).
//
// El archivo se llama usdt-balance porque el 99,9% del saldo es USDT, pero lee
// las DOS cosas que hay en la wallet: el token (USDT) y el activo NATIVO de
// cada cadena (TRX / BNB / ETH), que Kevin mantiene "para validar
// transacciones". El gas es poca plata pero es plata: ~$73 en TRX y ~$5 en BNB.
//
// POR QUÉ ACÁ Y NO COMO "PROVEEDOR"
// El resto de este directorio habla con pasarelas: hay credenciales, hay
// depósitos de clientes y hay una cuenta del otro lado. Una wallet de Trust
// Wallet no tiene nada de eso — es una dirección pública y un nodo que la lee.
// No hay secretos que resolver, así que tampoco hay `credentials.ts` ni
// `notConfigured`: si hay dirección se consulta, y si no, no existe.
//
// LO QUE SE CONSULTA
//   · Tron: el USDT se lee con balanceOf(address) del contrato
//     (POST /wallet/triggerconstantcontract) y el TRX con
//     GET /v1/accounts/{address} — DOS llamadas desde el 2026-09-04, ver el
//     bloque "Tron: USDT por el CONTRATO". Antes era una sola:
//     `data[0].trc20` (array de {contrato: saldo}, 6
//     decimales) y `data[0].balance`, el saldo nativo en sun (TRX × 1e6).
//     Con `TRONGRID_API_KEY` se manda el header 'TRON-PRO-API-KEY' y la cuota
//     sube; sin key funciona igual con cuota baja.
//   · BSC / Ethereum: JSON-RPC público, sin key. Dos llamadas: `eth_call` a
//     balanceOf(address) del contrato USDT y `eth_getBalance` para el nativo
//     (wei, 18 decimales).
//
// LOS DECIMALES NO SON LOS MISMOS EN CADA CADENA
// USDT usa 6 decimales en Tron y en Ethereum, pero 18 en BSC. Confundirlos no
// da un número "parecido": da un saldo un billón de veces mayor o menor. Por
// eso los decimales viajan pegados al contrato en ONCHAIN_ASSETS y nunca se
// escriben sueltos en el código que llama.
//
// LA MISMA DIRECCIÓN 0x EXISTE EN VARIAS CADENAS
// Una seed de Trust Wallet produce UNA dirección EVM válida tanto en BSC como
// en Ethereum, con saldos INDEPENDIENTES. Por eso la identidad de una wallet es
// el par (red, dirección) y nunca la dirección sola.
//
// PARSEO DEFENSIVO
// Estos endpoints son públicos y sin contrato de estabilidad. Todo lo que no se
// entienda devuelve `{error}` y el cron sigue con los demás canales. Pero "la
// cuenta no tiene USDT" NO es un error: es 0. Si eso devolviera error, una
// wallet vaciada dejaría de asentarse justo el día que se vació.
// ─────────────────────────────────────────────────────────────────────────────

import {
  isValidOnchainAddress,
  normalizeOnchainAddress,
  ONCHAIN_NETWORK_LABELS,
  type OnchainNetwork,
  type OnchainWallet,
} from '@/lib/cash-locations';
import type { NativePriceMap, NativeSymbol } from './prices';

/** El cron no puede colgarse por un nodo lento: 10 s y afuera. */
export const ONCHAIN_TIMEOUT_MS = 10_000;

const TRONGRID_URL = 'https://api.trongrid.io';

/**
 * RPC por cadena. Configurables por env porque los públicos se caen y cambian:
 * eth.llamarpc.com devolvió HTML en vez de JSON y cloudflare-eth.com respondió
 * error el 2026-08-17, así que el default de Ethereum es publicnode.
 */
export function evmRpcUrl(network: 'bsc' | 'ethereum'): string {
  if (network === 'bsc') {
    return process.env.BSC_RPC_URL?.trim() || 'https://bsc-dataseed.binance.org/';
  }
  return process.env.ETH_RPC_URL?.trim() || 'https://ethereum-rpc.publicnode.com';
}

/** Contrato oficial de USDT (Tether) en cada red, con SUS decimales. */
export const ONCHAIN_ASSETS: Record<
  OnchainNetwork,
  { contract: string; decimals: number; symbol: string }
> = {
  tron: { contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, symbol: 'USDT TRC20' },
  bsc: { contract: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, symbol: 'USDT BEP20' },
  ethereum: { contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, symbol: 'USDT ERC20' },
};

/** Activo nativo (gas) de cada cadena. */
export const NATIVE_ASSETS: Record<OnchainNetwork, { symbol: NativeSymbol; decimals: number }> = {
  tron: { symbol: 'TRX', decimals: 6 },
  bsc: { symbol: 'BNB', decimals: 18 },
  ethereum: { symbol: 'ETH', decimals: 18 },
};

/**
 * Saldo nativo por debajo del cual NO se bloquea el canal si falta el precio.
 *
 * El gas es una propina que existe para pagar fees; a cualquier precio
 * verosímil estos montos valen menos de ~$2. Si CoinGecko no contesta y la
 * wallet tiene esto o menos, se cuenta 0 y se sigue: parar el asiento de una
 * wallet de $17.000 por un TRX suelto sería peor que el error que evita. Por
 * encima de este umbral se falla cerrado y el canal no se asienta ese día.
 */
export const NEGLIGIBLE_NATIVE: Record<NativeSymbol, number> = {
  TRX: 10,
  BNB: 0.003,
  ETH: 0.0005,
};

export interface OnchainBalanceOk {
  /** Saldo en USDT, ya con los decimales aplicados. */
  balance: number;
  /** Saldo en unidades crudas del contrato, tal cual lo devolvió la cadena. */
  raw: string;
  /** Quién contestó — queda en el log del cron para auditar de dónde salió. */
  source: string;
}

export interface OnchainBalanceError {
  error: string;
}

export type OnchainBalanceResult = OnchainBalanceOk | OnchainBalanceError;

export const isOnchainError = (r: { error?: string }): r is OnchainBalanceError =>
  typeof r.error === 'string';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Unidades crudas → número decimal, pasando por string.
 *
 * `Number(raw) / 1e18` perdería precisión ANTES de dividir (un raw de 18
 * decimales supera 2^53 con cualquier saldo real). Se parte el entero de la
 * fracción con BigInt y recién ahí se convierte, que es exacto para cualquier
 * monto que pueda entrar en un balance.
 */
export function rawToAmount(raw: bigint, decimals: number): number {
  const negative = raw < BigInt(0);
  const abs = negative ? -raw : raw;
  const unit = BigInt(10) ** BigInt(decimals);
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(decimals, '0');
  const value = Number(`${whole}.${frac}`);
  return negative ? -value : value;
}

/** Recorta la respuesta cruda para que quepa en un mensaje de error. */
export function truncateRaw(value: unknown, max = 300): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ── Freno para TronGrid ─────────────────────────────────────────────────────
// Sin API key TronGrid admite 3 req/s y responde 429 «query server is
// suspended for 5 s» al pasarse (medido 2026-09-04 leyendo 3 wallets: la 2ª y
// la 3ª volvieron 429). Desde hoy Tron cuesta DOS llamadas por wallet
// (contrato + cuenta) y `fetchOnchainTotal` lee las redes en paralelo, así que
// sin freno el snapshot diario de Vex (2 wallets Tron) se pasa solo. Las
// llamadas a TronGrid se serializan con un espacio mínimo entre ellas; el 429
// que igual llegue sigue siendo error visible, nunca un 0.
// `TRONGRID_MIN_INTERVAL_MS` permite bajarlo a 0 en tests o con API key.
let tronGate: Promise<void> = Promise.resolve();
let tronLastCallAt = 0;
function tronMinIntervalMs(): number {
  const raw = process.env.TRONGRID_MIN_INTERVAL_MS;
  if (raw === undefined || raw === '') return process.env.TRONGRID_API_KEY?.trim() ? 120 : 400;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 400;
}
async function tronThrottled<T>(fn: () => Promise<T>): Promise<T> {
  const wait = tronGate.then(async () => {
    const gap = tronMinIntervalMs();
    const elapsed = Date.now() - tronLastCallAt;
    if (gap > 0 && elapsed < gap) await new Promise((r) => setTimeout(r, gap - elapsed));
    tronLastCallAt = Date.now();
  });
  tronGate = wait.catch(() => undefined);
  await wait;
  return fn();
}

/** Headers de TronGrid: la API key es opcional y solo sube la cuota. */
export function tronHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const apiKey = process.env.TRONGRID_API_KEY?.trim();
  if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey;
  return headers;
}

// ── Parseo ──────────────────────────────────────────────────────────────────

/**
 * Busca el saldo de USDT dentro de la respuesta de TronGrid.
 *
 * `data[0].trc20` es un ARRAY donde cada elemento es un objeto con UNA clave
 * (el contrato) y el saldo crudo como valor —normalmente string—. Una cuenta
 * sin USDT no trae esa clave en ninguno de sus elementos, y una cuenta que
 * nunca recibió nada devuelve `data: []`. Los dos casos son 0, no error.
 */
export function parseTronUsdtRaw(json: unknown): bigint | null {
  if (!isRecord(json)) return null;
  const data = json.data;
  if (!Array.isArray(data)) return null;
  if (data.length === 0) return BigInt(0); // cuenta inexistente o sin actividad
  const account = data[0];
  if (!isRecord(account)) return null;

  const trc20 = account.trc20;
  // Sin lista de tokens la cuenta existe pero no tiene ninguno: 0, no error.
  if (!Array.isArray(trc20)) return BigInt(0);

  const contract = ONCHAIN_ASSETS.tron.contract;
  for (const token of trc20) {
    if (!isRecord(token)) continue;
    const value = token[contract];
    if (value === undefined || value === null) continue;
    try {
      // El saldo llega como string decimal; BigInt('') tira, por eso el trim.
      const text = String(value).trim();
      if (!text) continue;
      return BigInt(text);
    } catch {
      return null; // había algo pero no es un entero: no inventar un número
    }
  }
  return BigInt(0); // tiene otros tokens, USDT no
}

/**
 * Saldo NATIVO (TRX) de la misma respuesta: `data[0].balance`, en sun.
 * Una cuenta sin actividad no trae `balance`: eso es 0, no un error.
 */
export function parseTronNativeRaw(json: unknown): bigint | null {
  if (!isRecord(json)) return null;
  const data = json.data;
  if (!Array.isArray(data)) return null;
  if (data.length === 0) return BigInt(0);
  const account = data[0];
  if (!isRecord(account)) return null;
  const balance = account.balance;
  if (balance === undefined || balance === null) return BigInt(0);
  try {
    const text = String(balance).trim();
    if (!text) return BigInt(0);
    return BigInt(text);
  } catch {
    return null;
  }
}

/** Calldata de `balanceOf(address)`: selector + dirección a 32 bytes. */
export function encodeBalanceOf(address: string): string {
  return `0x70a08231${address.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;
}

/** Hex de un RPC → unidades crudas. '0x' = el contrato no la conoce = 0. */
export function parseEvmHexBalance(result: unknown): bigint | null {
  if (typeof result !== 'string') return null;
  const hex = result.trim();
  if (!/^0x[0-9a-fA-F]*$/.test(hex)) return null;
  if (hex === '0x') return BigInt(0);
  return BigInt(hex);
}

// ── Llamadas ────────────────────────────────────────────────────────────────

/** GET de la cuenta Tron: una sola llamada sirve para USDT y para TRX. */
async function tronAccount(address: string): Promise<{ json: unknown } | { error: string }> {
  const res = await tronThrottled(() => fetch(`${TRONGRID_URL}/v1/accounts/${address}`, {
    method: 'GET',
    headers: tronHeaders(),
    signal: AbortSignal.timeout(ONCHAIN_TIMEOUT_MS),
  }));
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    return { error: `TronGrid ${res.status} ${res.statusText}: ${truncateRaw(text, 200)}` };
  }
  try {
    return { json: JSON.parse(text) };
  } catch {
    return { error: `TronGrid respondió algo que no es JSON: ${truncateRaw(text)}` };
  }
}

// ── Tron: USDT por el CONTRATO, no por la cuenta ────────────────────────────
//
// Hallazgo 2026-09-04 (Kevin: «REVISA BIEN, TIENE $29,945.53»). La wallet
// TMwSxJ…GaV es una cuenta GasFree de TronLink: recibe USDT sin haber sido
// activada nunca con TRX. Para `/v1/accounts/{addr}` esa cuenta NO EXISTE
// (`data: []`) aunque el contrato de USDT le tenga 29.938,57 asignados, y
// `parseTronUsdtRaw` lo traducía a 0. Un cero plausible y falso: el fallo que
// no da error. La verdad del saldo de un TRC20 la tiene el contrato; por eso
// el USDT se lee SIEMPRE con `balanceOf(address)` vía triggerconstantcontract
// (igual que en BSC/Ethereum) y `/v1/accounts` queda solo para el TRX, que sí
// vive en la cuenta (una cuenta sin activar no puede tener TRX: ahí el 0 es
// verdad).
//
// Descartado: "usar /v1/accounts y caer al contrato solo si data está vacío".
// Tapa este caso pero no el de una cuenta activada cuya lista `trc20` llegue
// incompleta o paginada; preguntar al contrato no depende de cómo TronGrid
// arme la vista de la cuenta.

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Base58check de Tron → los 20 bytes de la dirección en hex (sin el prefijo
 * 0x41, sin checksum). null si la cadena no decodifica a 25 bytes con prefijo
 * 0x41: no se adivina una dirección.
 */
export function tronBase58ToHex20(address: string): string | null {
  let n = BigInt(0);
  for (const ch of address) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    n = n * BigInt(58) + BigInt(idx);
  }
  let hex = n.toString(16);
  if (hex.length > 50) return null;
  hex = hex.padStart(50, '0'); // 25 bytes: 0x41 + 20 bytes + 4 bytes checksum
  if (!hex.startsWith('41')) return null;
  return hex.slice(2, 42);
}

/** `constant_result[0]` de triggerconstantcontract → unidades crudas. */
export function parseTronConstantResult(json: unknown): bigint | null {
  if (!isRecord(json)) return null;
  const result = json.constant_result;
  if (!Array.isArray(result) || typeof result[0] !== 'string') return null;
  const hex = result[0].trim();
  if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
  if (hex === '') return BigInt(0);
  return BigInt(`0x${hex}`);
}

/** balanceOf(address) del contrato USDT en Tron. */
async function tronUsdtBalanceOf(address: string): Promise<{ raw: bigint } | { error: string }> {
  const hex20 = tronBase58ToHex20(address);
  if (!hex20) return { error: 'Dirección Tron inválida: no decodifica como base58check con prefijo 0x41.' };
  const res = await tronThrottled(() => fetch(`${TRONGRID_URL}/wallet/triggerconstantcontract`, {
    method: 'POST',
    headers: { ...tronHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner_address: address,
      contract_address: ONCHAIN_ASSETS.tron.contract,
      function_selector: 'balanceOf(address)',
      parameter: hex20.padStart(64, '0'),
      visible: true,
    }),
    signal: AbortSignal.timeout(ONCHAIN_TIMEOUT_MS),
  }));
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    return { error: `TronGrid ${res.status} ${res.statusText}: ${truncateRaw(text, 200)}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: `TronGrid respondió algo que no es JSON: ${truncateRaw(text)}` };
  }
  const raw = parseTronConstantResult(json);
  if (raw === null) {
    return {
      error:
        'TronGrid respondió OK pero balanceOf(USDT) no trajo un resultado legible. ' +
        `Crudo: ${truncateRaw(json)}`,
    };
  }
  return { raw };
}

/** Una llamada JSON-RPC que devuelve un hex en `result`. */
async function evmRpcCall(
  network: 'bsc' | 'ethereum',
  method: string,
  params: unknown[],
): Promise<{ raw: bigint } | { error: string }> {
  const res = await fetch(evmRpcUrl(network), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(ONCHAIN_TIMEOUT_MS),
  });

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    return { error: `RPC ${network} ${res.status} ${res.statusText}: ${truncateRaw(text, 200)}` };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Caso real: eth.llamarpc.com devolvió HTML. Sin este chequeo, un
    // JSON.parse que tira dejaba el saldo en 0 sin que nadie se enterara.
    return { error: `RPC ${network} respondió algo que no es JSON: ${truncateRaw(text)}` };
  }

  // JSON-RPC devuelve los errores con HTTP 200 y `error` en el cuerpo.
  if (isRecord(json) && json.error) {
    return { error: `RPC ${network} error: ${truncateRaw(json.error, 200)}` };
  }

  const raw = parseEvmHexBalance(isRecord(json) ? json.result : undefined);
  if (raw === null) {
    return { error: `RPC ${network} (${method}) no devolvió un hex de saldo. Crudo: ${truncateRaw(json)}` };
  }
  return { raw };
}

/** Envuelve un fallo de red en un mensaje legible. Nunca relanza. */
function networkError(err: unknown, network: OnchainNetwork): OnchainBalanceError {
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { error: `Timeout consultando la red ${network} (${ONCHAIN_TIMEOUT_MS / 1000}s).` };
  }
  return {
    error: err instanceof Error ? err.message : `Error desconocido consultando la red ${network}`,
  };
}

function invalidAddressError(network: OnchainNetwork): OnchainBalanceError {
  return {
    error:
      network === 'tron'
        ? 'Dirección Tron inválida: tiene que empezar con T y medir 34 caracteres base58.'
        : network === 'bsc' || network === 'ethereum'
          ? `Dirección ${ONCHAIN_NETWORK_LABELS[network]} inválida: tiene que ser 0x seguido de 40 caracteres hexadecimales.`
          : `Red on-chain no soportada: ${String(network)}`,
  };
}

/**
 * Saldo USDT de UNA dirección pública. Nunca lanza: todo error viaja en el
 * resultado para que el cron pueda seguir con los demás canales.
 *
 * SIN REINTENTOS a propósito. El cron corre una vez por día y el snapshot del
 * día siguiente corrige cualquier lectura perdida; insistir contra un endpoint
 * público con cuota es la forma más rápida de quedar bloqueado y perder TODAS
 * las lecturas en vez de una.
 */
export async function fetchUsdtBalance(
  network: OnchainNetwork,
  address: string,
): Promise<OnchainBalanceResult> {
  const clean = normalizeOnchainAddress(network, address);
  if (!isValidOnchainAddress(network, clean)) return invalidAddressError(network);

  try {
    if (network === 'tron') {
      // Por el contrato, no por la cuenta: ver el bloque "Tron: USDT por el
      // CONTRATO" más arriba (cuentas GasFree sin activar).
      const call = await tronUsdtBalanceOf(clean);
      if ('error' in call) return call;
      return {
        balance: rawToAmount(call.raw, ONCHAIN_ASSETS.tron.decimals),
        raw: call.raw.toString(),
        source: 'trongrid',
      };
    }

    const asset = ONCHAIN_ASSETS[network];
    const call = await evmRpcCall(network, 'eth_call', [
      { to: asset.contract, data: encodeBalanceOf(clean) },
      'latest',
    ]);
    if ('error' in call) return call;
    return {
      balance: rawToAmount(call.raw, asset.decimals),
      raw: call.raw.toString(),
      source: network === 'bsc' ? 'bsc-rpc' : 'eth-rpc',
    };
  } catch (err) {
    return networkError(err, network);
  }
}

// ── Saldo completo de una red: token + gas ──────────────────────────────────

export interface NetworkBalanceOk {
  network: OnchainNetwork;
  address: string;
  /** USDT, contado 1:1 en dólares. */
  usdt: number;
  usdtRaw: string;
  native: { symbol: NativeSymbol; amount: number; raw: string };
  source: string;
  error?: undefined;
}

export type NetworkBalanceResult =
  | NetworkBalanceOk
  | { network: OnchainNetwork; address: string; error: string };

/**
 * Token + nativo de UNA dirección. En Tron sale de una sola llamada; en EVM son
 * dos (el nodo no expone las dos cosas juntas). Si falla cualquiera de las dos
 * el resultado entero es error: contar el USDT y dar el gas por 0 sería tapar
 * una lectura fallida con un número plausible.
 */
export async function fetchNetworkBalance(
  network: OnchainNetwork,
  address: string,
): Promise<NetworkBalanceResult> {
  const clean = normalizeOnchainAddress(network, address);
  if (!isValidOnchainAddress(network, clean)) {
    return { network, address, ...invalidAddressError(network) };
  }
  const nativeAsset = NATIVE_ASSETS[network];

  try {
    if (network === 'tron') {
      const usdtCall = await tronUsdtBalanceOf(clean);
      if ('error' in usdtCall) return { network, address: clean, error: usdtCall.error };
      const usdtRaw = usdtCall.raw;
      const account = await tronAccount(clean);
      if ('error' in account) return { network, address: clean, error: account.error };
      const nativeRaw = parseTronNativeRaw(account.json);
      if (nativeRaw === null) {
        return {
          network,
          address: clean,
          error: `TronGrid respondió OK pero no se pudo leer el saldo. Crudo: ${truncateRaw(account.json)}`,
        };
      }
      return {
        network,
        address: clean,
        usdt: rawToAmount(usdtRaw, ONCHAIN_ASSETS.tron.decimals),
        usdtRaw: usdtRaw.toString(),
        native: {
          symbol: nativeAsset.symbol,
          amount: rawToAmount(nativeRaw, nativeAsset.decimals),
          raw: nativeRaw.toString(),
        },
        source: 'trongrid',
      };
    }

    const asset = ONCHAIN_ASSETS[network];
    const call = await evmRpcCall(network, 'eth_call', [
      { to: asset.contract, data: encodeBalanceOf(clean) },
      'latest',
    ]);
    if ('error' in call) return { network, address: clean, error: call.error };

    const native = await evmRpcCall(network, 'eth_getBalance', [clean, 'latest']);
    if ('error' in native) return { network, address: clean, error: native.error };

    return {
      network,
      address: clean,
      usdt: rawToAmount(call.raw, asset.decimals),
      usdtRaw: call.raw.toString(),
      native: {
        symbol: nativeAsset.symbol,
        amount: rawToAmount(native.raw, nativeAsset.decimals),
        raw: native.raw.toString(),
      },
      source: network === 'bsc' ? 'bsc-rpc' : 'eth-rpc',
    };
  } catch (err) {
    return { network, address: clean, ...networkError(err, network) };
  }
}

// ── Total de una ubicación con varias redes ─────────────────────────────────

/** Lo que se guarda en `channel_balances.meta` para poder auditar el día. */
export interface OnchainNetworkBreakdown {
  network: OnchainNetwork;
  address: string;
  /** Dólares de USDT (1:1). */
  usdt: number;
  native: {
    symbol: NativeSymbol;
    amount: number;
    /** Precio spot usado. null = no había precio y el monto era despreciable. */
    priceUsd: number | null;
    valueUsd: number;
  };
  /** usdt + native.valueUsd */
  subtotal: number;
}

export type OnchainTotalResult =
  | {
      total: number;
      breakdown: OnchainNetworkBreakdown[];
      /** Cuándo se leyeron los precios del gas. */
      priceAt: string | null;
      error?: undefined;
    }
  | { total?: undefined; breakdown: OnchainNetworkBreakdown[]; priceAt?: null; error: string };

/**
 * Saldo TOTAL de una ubicación: la suma de USDT + gas valuado, en todas sus
 * redes.
 *
 * FAIL-CLOSED: si UNA sola red falla, no se devuelve el total de las demás. Un
 * total parcial es indistinguible de un total real y entraría al libro como un
 * "retiro" por el saldo de la red que no contestó — plata que se esfumaría de
 * los reportes por un timeout. Mejor no asentar nada hoy y reintentar mañana,
 * que es exactamente lo que hacen los canales de pasarela cuando su API
 * devuelve una respuesta incompleta.
 *
 * Los precios se pasan de afuera (`prices`) para que el cron los lea UNA vez
 * por corrida y no una vez por empresa.
 */
export async function fetchOnchainTotal(
  wallets: OnchainWallet[],
  opts: { prices?: NativePriceMap; priceAt?: string | null } = {},
): Promise<OnchainTotalResult> {
  if (wallets.length === 0) {
    return { breakdown: [], error: 'La ubicación no tiene direcciones on-chain configuradas' };
  }

  const prices = opts.prices ?? {};
  const breakdown: OnchainNetworkBreakdown[] = [];
  const failures: string[] = [];

  // Secuencial y no en paralelo: son endpoints públicos con cuota por IP, y
  // dispararlos juntos es la forma más rápida de comerse un 429 que tumba
  // todas las lecturas en vez de ninguna.
  for (const w of wallets) {
    const res = await fetchNetworkBalance(w.network, w.address);
    if (res.error !== undefined) {
      failures.push(`${ONCHAIN_NETWORK_LABELS[w.network]} — ${res.error}`);
      continue;
    }

    const price = prices[res.native.symbol];
    let priceUsd: number | null = null;
    let valueUsd = 0;
    if (res.native.amount > 0) {
      if (typeof price === 'number' && price > 0) {
        priceUsd = price;
        valueUsd = res.native.amount * price;
      } else if (res.native.amount <= NEGLIGIBLE_NATIVE[res.native.symbol]) {
        // Sin precio pero con polvo de gas: se cuenta 0 y se sigue.
        priceUsd = null;
      } else {
        failures.push(
          `${ONCHAIN_NETWORK_LABELS[w.network]} — sin precio para ${res.native.amount} ${res.native.symbol}: ` +
            'no se valúa el gas a ciegas.',
        );
        continue;
      }
    }

    breakdown.push({
      network: res.network,
      address: res.address,
      usdt: res.usdt,
      native: { symbol: res.native.symbol, amount: res.native.amount, priceUsd, valueUsd },
      subtotal: res.usdt + valueUsd,
    });
  }

  if (failures.length > 0) {
    return {
      breakdown,
      error:
        `No se pudo leer ${failures.length} de ${wallets.length} red(es): ${failures.join(' | ')}. ` +
        'No se asienta un total parcial.',
    };
  }

  const total = breakdown.reduce((sum, r) => sum + r.subtotal, 0);
  return { total, breakdown, priceAt: opts.priceAt ?? null };
}
