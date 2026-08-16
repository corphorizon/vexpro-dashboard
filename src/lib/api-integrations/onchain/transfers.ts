// ─────────────────────────────────────────────────────────────────────────────
// Historial de transferencias USDT de una wallet propia (migración 085).
//
// EL PROBLEMA QUE RESUELVE
// Con solo el saldo diario, el libro del canal explica el día entero con UNA
// línea de "Ajuste de conciliación": el 17/08 la Trust Wallet baja $561 y el
// libro dice "ajuste −561" sin decir a quién se le pagó. Kevin pidió "que vaya
// poniendo las transacciones en el libro contable": con el historial, el día se
// asienta como Depósitos / Retiros reales y el ajuste queda para lo que de
// verdad no cuadra (fees de red, redondeos, transferencias que el explorador
// todavía no indexó).
//
// POR QUÉ SE PERSISTE EN `api_transactions` Y NO DIRECTO EN EL LIBRO
// Se evaluaron las dos:
//   (a) escribir un asiento por transferencia en channel_ledger_entries, y
//   (b) persistir en api_transactions y dejar que el sync diario arme el libro.
// Gana (b) por lejos. El libro está modelado por (día, categoría) y tiene un
// índice único parcial `(company, canal, fecha, categoría) WHERE source='api'`
// más una RPC `replace_channel_ledger_day` que BORRA y reescribe el día: una
// fila por transferencia rompería el índice y pelearía con esa RPC en cada
// pasada del cron. Con (b) no se toca una línea de channel-ledger-sync.ts —
// solo se le enseña a `get_channel_day_movements` a mirar el provider nuevo,
// igual que se hizo con Pay-Pros en la migración 082— y el libro sale solo,
// con el mismo cierre exacto contra el saldo real que ya está probado.
//
// ESTAS TRANSFERENCIAS NO SON DE CLIENTES
// Es tesorería propia: mueve plata entre wallets de la empresa y paga gastos.
// Se persisten con `provider='onchain-usdt'` e `internal=true`, y ninguno de
// los caminos de Net Deposit las mira: loadPersistedTotals ignora todo provider
// que no esté en su mapa, get_period_totals_by_month y reports/data.ts listan
// los providers aceptados uno por uno, y persisted-movements consulta por slug.
// Hay un test que lo fija (onchain/transfers.test.ts).
//
// COBERTURA POR RED
//   · Tron/TRC20 → historial COMPLETO por la API pública de TronGrid.
//   · BSC y Ethereum → historial SOLO si hay BSCSCAN_API_KEY / ETHERSCAN_API_KEY.
//     Sin key no hay endpoint público de historial: quedaría eth_getLogs sobre
//     el evento Transfer, que obliga a paginar por rangos de bloques y a
//     guardar un cursor de bloque (los RPC públicos cortan en 5-10k bloques por
//     llamada). No se implementó todavía; sin key esas redes aportan SOLO su
//     saldo diario y su movimiento cae en el ajuste. Hoy eso es irrelevante en
//     números —la wallet de Vex Pro tiene $0,0014 en BEP20 y $0 en ERC20 contra
//     $17.051 en TRC20— así que no vale la complejidad hasta que haga falta.
// ─────────────────────────────────────────────────────────────────────────────

import type { createAdminClient } from '@/lib/supabase/admin';
import { ONCHAIN_NETWORK_LABELS, type OnchainNetwork, type OnchainWallet } from '@/lib/cash-locations';
import {
  ONCHAIN_ASSETS,
  ONCHAIN_TIMEOUT_MS,
  rawToAmount,
  tronHeaders,
  truncateRaw,
} from './usdt-balance';

type Admin = ReturnType<typeof createAdminClient>;

/** Provider con el que viven estas filas en api_transactions. */
export const ONCHAIN_PROVIDER = 'onchain-usdt';

/** El sentido va en `status`, como en Pay-Pros: la RPC lo lee para separar. */
export const ONCHAIN_STATUS = { in: 'received', out: 'sent' } as const;

/** Primera corrida: cuánto historial traer hacia atrás. */
export const INITIAL_WINDOW_DAYS = 35;

/** Solape sobre el cursor: un bloque puede indexarse tarde. */
const OVERLAP_HOURS = 6;

/** Tope de páginas por red y por corrida — evita un bucle infinito. */
const MAX_PAGES = 10;
const PAGE_SIZE = 200;

export interface OnchainTransfer {
  network: OnchainNetwork;
  /** Hash de la transacción. */
  hash: string;
  from: string;
  to: string;
  /** Unidades crudas del contrato, como string. */
  raw: string;
  /** Monto en USDT. */
  amount: number;
  /** Momento del bloque, en ISO UTC. */
  at: string;
  direction: 'in' | 'out';
  /**
   * Identidad ÚNICA de la transferencia. Un mismo hash puede mover el token
   * varias veces (varios eventos Transfer) y puede aparecer como entrada y como
   * salida a la vez si la wallet se manda plata a sí misma: el hash solo no
   * alcanza como clave.
   */
  externalId: string;
}

export interface TransferFetchResult {
  transfers: OnchainTransfer[];
  /** La red no tiene historial disponible (falta API key). No es una falla. */
  unsupported?: boolean;
  error?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function toBigInt(value: unknown): bigint | null {
  try {
    const text = String(value ?? '').trim();
    if (!/^\d+$/.test(text)) return null;
    return BigInt(text);
  } catch {
    return null;
  }
}

// ── Tron / TRC20 ────────────────────────────────────────────────────────────

/**
 * Normaliza la respuesta de TronGrid `/v1/accounts/{addr}/transactions/trc20`.
 * Cada elemento trae {transaction_id, from, to, value (crudo), block_timestamp
 * en MILISEGUNDOS, token_info}. El sentido lo decide contra QUÉ dirección se
 * consultó: `to === addr` entra, `from === addr` sale.
 */
export function parseTronTransfers(
  json: unknown,
  address: string,
): { transfers: OnchainTransfer[]; fingerprint: string | null } {
  const transfers: OnchainTransfer[] = [];
  if (!isRecord(json) || !Array.isArray(json.data)) return { transfers, fingerprint: null };

  const decimals = ONCHAIN_ASSETS.tron.decimals;
  for (const item of json.data) {
    if (!isRecord(item)) continue;
    const hash = typeof item.transaction_id === 'string' ? item.transaction_id : '';
    const from = typeof item.from === 'string' ? item.from : '';
    const to = typeof item.to === 'string' ? item.to : '';
    const raw = toBigInt(item.value);
    const ts = Number(item.block_timestamp);
    if (!hash || raw === null || !Number.isFinite(ts)) continue;

    // Un contrato distinto al de USDT no debería llegar (se filtra en la query)
    // pero si llega, mezclarlo sumaría otro token como si fueran dólares.
    const info = isRecord(item.token_info) ? item.token_info : null;
    const contract = info && typeof info.address === 'string' ? info.address : null;
    if (contract && contract !== ONCHAIN_ASSETS.tron.contract) continue;

    const direction: 'in' | 'out' = to === address ? 'in' : from === address ? 'out' : 'in';
    // Ni entra ni sale de esta wallet: no es asunto de este canal.
    if (to !== address && from !== address) continue;

    transfers.push({
      network: 'tron',
      hash,
      from,
      to,
      raw: raw.toString(),
      amount: rawToAmount(raw, decimals),
      at: new Date(ts).toISOString(),
      direction,
      externalId: `tron:${hash}:${direction}:${from}:${to}`,
    });
  }

  const meta = isRecord(json.meta) ? json.meta : null;
  const fingerprint = meta && typeof meta.fingerprint === 'string' ? meta.fingerprint : null;
  return { transfers, fingerprint };
}

async function fetchTronTransfers(
  address: string,
  sinceMs: number,
): Promise<TransferFetchResult> {
  const out: OnchainTransfer[] = [];
  let fingerprint: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`https://api.trongrid.io/v1/accounts/${address}/transactions/trc20`);
    url.searchParams.set('contract_address', ONCHAIN_ASSETS.tron.contract);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('min_timestamp', String(sinceMs));
    url.searchParams.set('order_by', 'block_timestamp,asc');
    if (fingerprint) url.searchParams.set('fingerprint', fingerprint);

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: tronHeaders(),
      signal: AbortSignal.timeout(ONCHAIN_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      return { transfers: out, error: `TronGrid trc20 ${res.status}: ${truncateRaw(text, 200)}` };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { transfers: out, error: `TronGrid trc20 respondió algo que no es JSON: ${truncateRaw(text)}` };
    }

    const parsed = parseTronTransfers(json, address);
    out.push(...parsed.transfers);
    // Sin fingerprint nuevo o con página incompleta, no hay más para traer.
    if (!parsed.fingerprint || parsed.transfers.length === 0) break;
    fingerprint = parsed.fingerprint;
  }

  return { transfers: out };
}

// ── EVM (BSC / Ethereum) por explorador ─────────────────────────────────────

/** Explorador y key por red. Sin key no hay historial (ver cabecera). */
function explorerFor(network: 'bsc' | 'ethereum'): { base: string; key: string } | null {
  const key =
    network === 'bsc'
      ? process.env.BSCSCAN_API_KEY?.trim()
      : process.env.ETHERSCAN_API_KEY?.trim();
  if (!key) return null;
  const base =
    network === 'bsc'
      ? process.env.BSCSCAN_API_URL?.trim() || 'https://api.bscscan.com/api'
      : process.env.ETHERSCAN_API_URL?.trim() || 'https://api.etherscan.io/api';
  return { base, key };
}

/**
 * Normaliza `module=account&action=tokentx` de BscScan/Etherscan. Devuelve
 * {hash, from, to, value crudo, timeStamp en SEGUNDOS, logIndex}. Todo llega
 * como string y las direcciones en minúsculas.
 */
export function parseExplorerTransfers(
  json: unknown,
  network: 'bsc' | 'ethereum',
  address: string,
): { transfers: OnchainTransfer[]; error?: string } {
  if (!isRecord(json)) return { transfers: [], error: 'Respuesta del explorador no reconocida' };

  // status '0' con result 'No transactions found' es una respuesta VÁLIDA de
  // "no hay nada": tratarla como error apagaría el sync de una wallet nueva.
  if (json.status === '0' && !Array.isArray(json.result)) {
    const msg = typeof json.result === 'string' ? json.result : String(json.message ?? '');
    if (/no transactions found/i.test(msg)) return { transfers: [] };
    return { transfers: [], error: `Explorador ${network}: ${truncateRaw(msg, 200)}` };
  }
  if (!Array.isArray(json.result)) {
    return { transfers: [], error: `Explorador ${network}: ${truncateRaw(json, 200)}` };
  }

  const asset = ONCHAIN_ASSETS[network];
  const wanted = asset.contract.toLowerCase();
  const me = address.toLowerCase();
  const transfers: OnchainTransfer[] = [];

  for (const item of json.result) {
    if (!isRecord(item)) continue;
    const contract = String(item.contractAddress ?? '').toLowerCase();
    if (contract && contract !== wanted) continue;
    const hash = String(item.hash ?? '');
    const from = String(item.from ?? '').toLowerCase();
    const to = String(item.to ?? '').toLowerCase();
    const raw = toBigInt(item.value);
    const seconds = Number(item.timeStamp);
    if (!hash || raw === null || !Number.isFinite(seconds)) continue;
    if (to !== me && from !== me) continue;

    const direction: 'in' | 'out' = to === me ? 'in' : 'out';
    const logIndex = String(item.logIndex ?? '0');
    transfers.push({
      network,
      hash,
      from,
      to,
      raw: raw.toString(),
      // Los decimales SALEN del catálogo por red: ERC20 usa 6 y BEP20 usa 18.
      amount: rawToAmount(raw, asset.decimals),
      at: new Date(seconds * 1000).toISOString(),
      direction,
      externalId: `${network}:${hash}:${logIndex}:${direction}`,
    });
  }

  return { transfers };
}

async function fetchEvmTransfers(
  network: 'bsc' | 'ethereum',
  address: string,
  sinceMs: number,
): Promise<TransferFetchResult> {
  const explorer = explorerFor(network);
  if (!explorer) {
    return {
      transfers: [],
      unsupported: true,
      error:
        `Sin ${network === 'bsc' ? 'BSCSCAN_API_KEY' : 'ETHERSCAN_API_KEY'} no hay historial ` +
        `de ${ONCHAIN_NETWORK_LABELS[network]}: esa red aporta solo su saldo diario.`,
    };
  }

  const url = new URL(explorer.base);
  url.searchParams.set('module', 'account');
  url.searchParams.set('action', 'tokentx');
  url.searchParams.set('contractaddress', ONCHAIN_ASSETS[network].contract);
  url.searchParams.set('address', address);
  url.searchParams.set('sort', 'asc');
  url.searchParams.set('page', '1');
  url.searchParams.set('offset', String(PAGE_SIZE));
  url.searchParams.set('apikey', explorer.key);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(ONCHAIN_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    return { transfers: [], error: `Explorador ${network} ${res.status}: ${truncateRaw(text, 200)}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { transfers: [], error: `Explorador ${network} respondió algo que no es JSON: ${truncateRaw(text)}` };
  }

  const parsed = parseExplorerTransfers(json, network, address);
  if (parsed.error) return { transfers: [], error: parsed.error };
  // El explorador no filtra por fecha en esta acción: se recorta acá para no
  // reescribir años de historia en cada corrida.
  return { transfers: parsed.transfers.filter((t) => Date.parse(t.at) >= sinceMs) };
}

/** Historial de UNA dirección desde `sinceMs`. Nunca lanza. */
export async function fetchOnchainTransfers(
  network: OnchainNetwork,
  address: string,
  sinceMs: number,
): Promise<TransferFetchResult> {
  try {
    return network === 'tron'
      ? await fetchTronTransfers(address, sinceMs)
      : await fetchEvmTransfers(network, address, sinceMs);
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { transfers: [], error: `Timeout leyendo el historial de ${network}.` };
    }
    return {
      transfers: [],
      error: err instanceof Error ? err.message : `Error desconocido leyendo el historial de ${network}`,
    };
  }
}

// ── Persistencia ────────────────────────────────────────────────────────────

/**
 * Desde cuándo pedir el historial de (canal, red).
 *
 * EL CURSOR NO ES UNA TABLA NUEVA: es el dato que ya está. Se toma la
 * transferencia más reciente guardada para ese canal y esa red y se retrocede
 * unas horas de solape, porque un explorador puede indexar un bloque tarde.
 * Una tabla `onchain_sync_cursors` sería una segunda copia del mismo hecho, con
 * su propio riesgo de quedar desincronizada — el modo de falla número uno de
 * este repo. Sin filas previas se arranca con la ventana inicial.
 */
export async function resolveSince(
  admin: Admin,
  companyId: string,
  channelKey: string,
  network: OnchainNetwork,
  now: number = Date.now(),
): Promise<number> {
  const initial = now - INITIAL_WINDOW_DAYS * 24 * 3600_000;
  const { data } = await admin
    .from('api_transactions')
    .select('transaction_date')
    .eq('company_id', companyId)
    .eq('provider', ONCHAIN_PROVIDER)
    .eq('wallet_id', channelKey)
    .eq('wallet_label', network)
    .order('transaction_date', { ascending: false })
    .limit(1);

  const last = data?.[0]?.transaction_date;
  if (!last) return initial;
  const lastMs = Date.parse(String(last));
  if (!Number.isFinite(lastMs)) return initial;
  return Math.max(initial, lastMs - OVERLAP_HOURS * 3600_000);
}

/** Fila de api_transactions para una transferencia on-chain. */
export function toApiTransactionRow(
  companyId: string,
  channelKey: string,
  transfer: OnchainTransfer,
): Record<string, unknown> {
  return {
    company_id: companyId,
    provider: ONCHAIN_PROVIDER,
    external_id: transfer.externalId,
    amount: transfer.amount,
    fee: null,
    currency: 'USDT',
    // El sentido va en el status, igual que Pay-Pros: la RPC del libro separa
    // depósitos de retiros mirando esta columna.
    status: transfer.direction === 'in' ? ONCHAIN_STATUS.in : ONCHAIN_STATUS.out,
    transaction_date: transfer.at,
    // `wallet_id` = la CLAVE DEL CANAL, no una wallet de Coinsbuy. Es lo que
    // deja que la RPC agrupe por canal sin inventar una tabla de mapeo, y lo
    // que hace que esto funcione igual en `wallet_externa` que en un custom_*.
    wallet_id: channelKey,
    wallet_label: transfer.network,
    // Tesorería propia: NUNCA es un depósito ni un retiro de clientes. Es un
    // segundo cinturón además del filtro por provider.
    internal: true,
    raw: transfer as unknown as Record<string, unknown>,
    synced_at: new Date().toISOString(),
  };
}

export interface OnchainSyncResult {
  channel_key: string;
  network: OnchainNetwork;
  inserted: number;
  /** La red no tiene historial disponible: solo aporta saldo. */
  historyUnavailable?: boolean;
  error?: string;
}

/**
 * Trae y guarda el historial de una ubicación (todas sus redes).
 *
 * Idempotente por el índice único (company_id, provider, external_id): volver a
 * correr el mismo día reescribe las mismas filas en vez de duplicarlas, que es
 * lo que permite el solape del cursor.
 *
 * Un fallo de historial NO invalida el saldo: el libro sigue cerrando contra el
 * saldo real y lo que no se pudo explicar cae en el ajuste, que es exactamente
 * el comportamiento anterior a esta función.
 */
export async function syncOnchainTransfers(
  admin: Admin,
  companyId: string,
  channelKey: string,
  wallets: OnchainWallet[],
): Promise<OnchainSyncResult[]> {
  const results: OnchainSyncResult[] = [];

  for (const w of wallets) {
    const since = await resolveSince(admin, companyId, channelKey, w.network);
    const fetched = await fetchOnchainTransfers(w.network, w.address, since);

    if (fetched.unsupported) {
      results.push({
        channel_key: channelKey,
        network: w.network,
        inserted: 0,
        historyUnavailable: true,
        error: fetched.error,
      });
      continue;
    }
    if (fetched.error) {
      results.push({ channel_key: channelKey, network: w.network, inserted: 0, error: fetched.error });
      continue;
    }
    if (fetched.transfers.length === 0) {
      results.push({ channel_key: channelKey, network: w.network, inserted: 0 });
      continue;
    }

    const rows = fetched.transfers.map((t) => toApiTransactionRow(companyId, channelKey, t));
    const { error } = await admin
      .from('api_transactions')
      .upsert(rows, { onConflict: 'company_id,provider,external_id' });

    results.push({
      channel_key: channelKey,
      network: w.network,
      inserted: error ? 0 : rows.length,
      error: error?.message,
    });
  }

  return results;
}
