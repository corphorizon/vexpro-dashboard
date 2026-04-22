// ─────────────────────────────────────────────────────────────────────────────
// Channel configuration resolver for "Balances por Canal".
//
// Built-in channels are hardcoded here (7 of them). They can be toggled
// (hidden from the Balances card + Reports) and, for manual ones, renamed.
// Custom channels (is_custom=true, channel_key prefixed `custom_`) are
// created by admins from the modal and can be fully edited + deleted.
//
// This module is import-safe from both client and server — it does not
// touch Supabase directly. Loading/persistence happens via the
// /api/admin/channel-configs endpoint on the client, and via a direct
// admin-client call in server-side code (reports/cron).
// ─────────────────────────────────────────────────────────────────────────────

export type ChannelType = 'api' | 'manual' | 'auto';

export interface BuiltinChannel {
  key: string;
  defaultLabel: string;
  type: ChannelType;
  description: string;
  /** Built-in channels can never be deleted and their `type` is fixed. */
  isBuiltin: true;
}

// Hardcoded 7 built-ins — these match the original CHANNELS array in
// src/app/(dashboard)/balances/page.tsx. Keep the keys stable: they're used
// as the primary key in channel_balances + channel_configs.
export const BUILTIN_CHANNELS: BuiltinChannel[] = [
  { key: 'coinsbuy',       defaultLabel: 'Coinsbuy',                   type: 'auto',   description: 'Wallets pinneadas — balance en tiempo real desde la API', isBuiltin: true },
  { key: 'unipayment',     defaultLabel: 'UniPayment',                 type: 'auto',   description: 'My Wallet — balance en tiempo real desde la API',         isBuiltin: true },
  { key: 'fairpay',        defaultLabel: 'FairPay',                    type: 'manual', description: 'Ingreso manual',                                           isBuiltin: true },
  { key: 'wallet_externa', defaultLabel: 'Wallet Externa',             type: 'manual', description: 'Ingreso manual',                                           isBuiltin: true },
  { key: 'otros',          defaultLabel: 'Otros',                      type: 'manual', description: 'Ingreso manual',                                           isBuiltin: true },
  { key: 'inversiones',    defaultLabel: 'Balance Actual Inversiones', type: 'auto',   description: 'Automático desde módulo Inversiones',                      isBuiltin: true },
  { key: 'liquidez',       defaultLabel: 'Balance Actual Liquidez',    type: 'auto',   description: 'Automático desde módulo Liquidez',                         isBuiltin: true },
];

const BUILTIN_KEYS = new Set(BUILTIN_CHANNELS.map((c) => c.key));
const BUILTIN_ORDER: Record<string, number> = Object.fromEntries(
  BUILTIN_CHANNELS.map((c, i) => [c.key, i]),
);

/** DB row shape for channel_configs. */
export interface ChannelConfigRow {
  id?: string;
  company_id?: string;
  channel_key: string;
  custom_label: string | null;
  channel_type: ChannelType;
  is_visible: boolean;
  is_custom: boolean;
  sort_order: number;
}

/**
 * Resolved channel — built-in or custom, already merged with its DB row.
 * Consumers render this directly; the UI doesn't need to know which is which
 * except to disable the rename/delete controls for built-ins.
 */
export interface ResolvedChannel {
  key: string;
  label: string;
  type: ChannelType;
  description: string;
  isVisible: boolean;
  isBuiltin: boolean;
  isCustom: boolean;
  sortOrder: number;
}

/**
 * Merge the 7 built-ins with whatever's in channel_configs for this company.
 * Built-ins missing a DB row default to `{is_visible: true, custom_label: null}`.
 * Custom channels (channel_key not in BUILTIN_KEYS) come straight from DB.
 *
 * Result is sorted by (sort_order asc, built-in original order, alpha). The
 * caller can re-sort if it wants a different order.
 */
export function resolveChannels(rows: ChannelConfigRow[]): ResolvedChannel[] {
  const rowByKey = new Map(rows.map((r) => [r.channel_key, r]));
  const out: ResolvedChannel[] = [];

  // 1. Built-ins, merged with any overrides.
  for (const c of BUILTIN_CHANNELS) {
    const row = rowByKey.get(c.key);
    out.push({
      key: c.key,
      label: row?.custom_label?.trim() || c.defaultLabel,
      type: c.type,
      description: c.description,
      isVisible: row?.is_visible ?? true,
      isBuiltin: true,
      isCustom: false,
      sortOrder: row?.sort_order ?? BUILTIN_ORDER[c.key] ?? 100,
    });
  }

  // 2. Custom channels — anything in the DB that isn't a built-in key.
  for (const row of rows) {
    if (BUILTIN_KEYS.has(row.channel_key)) continue;
    out.push({
      key: row.channel_key,
      label: row.custom_label?.trim() || row.channel_key,
      type: row.channel_type,
      description: 'Canal personalizado (ingreso manual)',
      isVisible: row.is_visible,
      isBuiltin: false,
      isCustom: true,
      sortOrder: row.sort_order,
    });
  }

  out.sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.label.localeCompare(b.label);
  });

  return out;
}

/** Generate a stable channel key for a new custom channel. */
export function newCustomChannelKey(): string {
  // crypto.randomUUID is available on all supported runtimes (Node 18+,
  // modern browsers).
  return `custom_${globalThis.crypto.randomUUID()}`;
}
