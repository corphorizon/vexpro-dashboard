// ─────────────────────────────────────────────────────────────────────────────
// ⚠ DEPRECADO (2026-08-31, auditoría de finanzas) — CAMINO MUERTO
//
// Este endpoint REST de Orion NO EXISTE para ningún inquilino: `api_credentials`
// no tiene una sola fila `provider='orion_crm'`. Sin credencial, la función cae
// a su generador de datos falsos, y eso alimentaba la sección «Prop Trading
// Firm» del informe —incluida la tabla «Productos vendidos»— con datos
// inventados bajo un título real.
//
// El informe ya NO lo usa: sale de `crm_monthly_totals`, métricas
// `propfirm_sales` y `propfirm_withdrawals` (src/lib/reports/crm-mirror.ts).
// Agosto 2026: ventas $11.981,70 · retiros $2.819,04.
//
// Queda en el repo porque `integrations-sync.ts` todavía lo llama, y ahí está
// guardado detrás de `isOrionCrmConfigured()`, así que hoy nunca se ejecuta. Se
// borra el día que se confirme que ningún inquilino va a configurar el REST.
// NO agregar consumidores nuevos: la fuente correcta es el espejo.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Orion CRM — Prop Trading Firm metrics for a range + month context.
//
// Feeds the "Prop Trading Firm" section of /finanzas/reportes with:
//   · Purchases of products (name, quantity, amount) inside the range
//   · Total sales (range + month)
//   · Retiros Prop Firm (count + amount) inside the range
//   · P&L prop firm = total_sales − prop_withdrawals  (range + month +
//     previous month so the UI can render comparisons without extra calls)
//
// Month + previous month numbers come from the same endpoint so the Report
// UI can compute "% this month vs prev" without a second round-trip.
// ─────────────────────────────────────────────────────────────────────────────

import { proxiedFetch } from '../proxy';
import {
  resolveOrionCrmConfig,
  orionHeaders,
  isMockFallbackEnabled,
} from './auth';

const ENDPOINT_PROP = '/v1/prop-trading'; // POST { from, to }

export interface OrionPropTradingProduct {
  name: string;
  quantity: number;
  amount: number;
}

export interface OrionCrmPropTrading {
  products: OrionPropTradingProduct[];
  total_sales_range: number;
  total_sales_month: number;
  prop_withdrawals_range: number;
  prop_withdrawals_count_range: number;
  pnl_range: number;
  pnl_month: number;
  pnl_prev_month: number;
  connected: boolean;
  isMock: boolean;
  errorMessage: string | null;
}

const EMPTY: OrionCrmPropTrading = {
  products: [],
  total_sales_range: 0,
  total_sales_month: 0,
  prop_withdrawals_range: 0,
  prop_withdrawals_count_range: 0,
  pnl_range: 0,
  pnl_month: 0,
  pnl_prev_month: 0,
  connected: false,
  isMock: false,
  errorMessage: null,
};

function mockPropTrading(from: string, to: string): OrionCrmPropTrading {
  const seed = parseInt(from.replace(/-/g, '').slice(0, 8), 10) || 20260401;
  const daysInRange = Math.max(
    1,
    Math.round(
      (new Date(to).getTime() - new Date(from).getTime()) / (1000 * 60 * 60 * 24),
    ) + 1,
  );

  // Catalog-ish. Each product has its own seed offset so quantities
  // progress plausibly with the range length.
  const products: OrionPropTradingProduct[] = [
    { name: 'Challenge $10K',  quantity: 2 + (seed % 5) * daysInRange, amount: (2 + (seed % 5) * daysInRange) * 89 },
    { name: 'Challenge $25K',  quantity: 1 + (seed % 4) * daysInRange, amount: (1 + (seed % 4) * daysInRange) * 189 },
    { name: 'Challenge $50K',  quantity: 1 + (seed % 3) * daysInRange, amount: (1 + (seed % 3) * daysInRange) * 299 },
    { name: 'Challenge $100K', quantity: Math.floor((seed % 7) * daysInRange / 2), amount: Math.floor((seed % 7) * daysInRange / 2) * 579 },
    { name: 'Challenge $200K', quantity: Math.floor((seed % 5) * daysInRange / 3), amount: Math.floor((seed % 5) * daysInRange / 3) * 1099 },
  ];

  const total_sales_range = products.reduce((s, p) => s + p.amount, 0);
  const total_sales_month = Math.round(total_sales_range * (30 / Math.max(1, daysInRange)));
  const prop_withdrawals_range = Math.round(total_sales_range * 0.35);
  const prop_withdrawals_count_range = Math.max(1, Math.round(daysInRange * 0.8));
  const pnl_range = total_sales_range - prop_withdrawals_range;
  const pnl_month = total_sales_month - Math.round(total_sales_month * 0.35);

  return {
    products,
    total_sales_range,
    total_sales_month,
    prop_withdrawals_range,
    prop_withdrawals_count_range,
    pnl_range,
    pnl_month,
    pnl_prev_month: Math.round(pnl_month * (0.82 + (seed % 30) / 100)),
    connected: false,
    isMock: true,
    errorMessage: null,
  };
}

export async function fetchOrionCrmPropTrading(
  companyId: string | null | undefined,
  from: string,
  to: string,
): Promise<OrionCrmPropTrading> {
  const config = await resolveOrionCrmConfig(companyId ?? null);

  if (!config) {
    return isMockFallbackEnabled() ? mockPropTrading(from, to) : EMPTY;
  }

  try {
    const res = await proxiedFetch(`${config.baseUrl}${ENDPOINT_PROP}`, {
      method: 'POST',
      headers: orionHeaders(config),
      body: JSON.stringify({ from, to }),
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) {
      console.warn(`[orion-crm/prop-trading] ${res.status} ${res.statusText}`);
      return isMockFallbackEnabled()
        ? mockPropTrading(from, to)
        : { ...EMPTY, errorMessage: `HTTP ${res.status}` };
    }

    const json = (await res.json()) as Partial<OrionCrmPropTrading>;
    return {
      products: Array.isArray(json.products)
        ? json.products.map((p) => ({
            name: String(p.name ?? ''),
            quantity: Number(p.quantity) || 0,
            amount: Number(p.amount) || 0,
          }))
        : [],
      total_sales_range: Number(json.total_sales_range) || 0,
      total_sales_month: Number(json.total_sales_month) || 0,
      prop_withdrawals_range: Number(json.prop_withdrawals_range) || 0,
      prop_withdrawals_count_range: Number(json.prop_withdrawals_count_range) || 0,
      pnl_range: Number(json.pnl_range) || 0,
      pnl_month: Number(json.pnl_month) || 0,
      pnl_prev_month: Number(json.pnl_prev_month) || 0,
      connected: true,
      isMock: false,
      errorMessage: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.warn('[orion-crm/prop-trading] fetch failed:', msg);
    return isMockFallbackEnabled()
      ? mockPropTrading(from, to)
      : { ...EMPTY, errorMessage: msg };
  }
}
