// ─────────────────────────────────────────────────────────────────────────────
// De dónde salió el dinero que hay en la billetera de cada cliente.
//
// ── POR QUÉ IMPORTA, Y POR QUÉ NO ES LO QUE PARECE ─────────────────────────
// "Retiró más de lo que depositó" NO predice el rechazo. Medido sobre 7.587
// retiros decididos: quien retira sobre todo su ganancia de trading rechaza al
// 2,79% y quien retira comisiones IB al 2,28%, los dos POR DEBAJO de la base
// de 3,18%. Un cliente que gana y retira es un cliente, no un problema.
//
// Lo que sí predice es de DÓNDE vino ese dinero. Medido en la ventana de la
// calibración vigente (6 meses, n=9.828, base 4,95%):
//
//     sin P2P recibido        7.723 casos    3,90%
//     P2P menor al retiro       575 casos    8,35%
//     P2P >= el retiro        1.119 casos   11,62%
//     personal del broker       411 casos    1,70%
//
// Monótona y con volumen: dinero que entró por transferencia de otro usuario y
// sale como retiro es la señal más fuerte de todo el módulo.
//
// ── EL PERSONAL DEL BROKER ─────────────────────────────────────────────────
// Los correos @vexprofx.com y @mail.vexprofx.com son BDM, heads y sales
// managers (Kevin, 2026-08-25). Cobran comisiones, así que retiran sin haber
// depositado por definición. Rechazan al 1,70%: son el grupo MÁS limpio, y
// compararles depósitos contra retiros no significa nada.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { withOrionMongo } from '@/lib/api-integrations/orion-mongo/client';
import { round2 } from '@/lib/utils';

/** Los ÚNICOS campos que se piden. La proyección es la aduana. */
export const ORION_TRANSFER_FIELDS = ['userId', 'concept', 'walletTransferType', 'netAmount'] as const;

/**
 * Cómo se agrupan los 26 conceptos de `wallettransfers` en las categorías que
 * le importan al analista. Los nombres salen de la base, no de una suposición.
 */
export const CONCEPT_GROUPS: Record<string, string> = {
  IB_REWARDS_BROKER: 'ib',
  IB_PROP_FIRM_REWARD: 'ib',
  'IB_REWARDS_BROKER ADJUSTMENT': 'ib',
  IB_REWARDS_BROKER_ADJUSTMENT: 'ib',
  SOCIAL_PERFORMANCE_FEE: 'social',
  SOCIAL_PERFORMANCE_FEE_SHARE: 'social',
  SOCIAL_SUBSCRIPTION_SHARE: 'social',
  PERFORMANCE_FEE_REVERSAL: 'social',
  PERFORMANCE_FEE_REVERSAL_ADJUSTMENT: 'social',
  PROP_FIRM_WITHDRAW: 'propfirm',
  // Dinero que vuelve DE una cuenta de trading a la billetera: es la ganancia
  // (o lo que quede) de operar.
  TRANSFER_FUNDS: 'trading',
  WALLET_TRANSFER: 'trading',
  TRANSFER_P2P: 'p2p',
  DEPOSIT: 'deposit',
};

/** Dominios del personal del broker. Ver la cabecera. */
const STAFF_DOMAINS = ['@vexprofx.com', '@mail.vexprofx.com'];

export function isBrokerStaff(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  return STAFF_DOMAINS.some((d) => e.endsWith(d));
}

export interface WalletSourcesResult {
  users: number;
  upserted: number;
  withP2p: number;
  elapsedMs: number;
  warnings: string[];
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const SIZE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await page(from, from + SIZE - 1);
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    out.push(...batch);
    if (batch.length < SIZE) return out;
  }
}

export async function syncWalletSources(
  admin: SupabaseClient,
  companyId: string,
): Promise<WalletSourcesResult> {
  const started = Date.now();
  const warnings: string[] = [];

  const agg = await withOrionMongo(companyId, async ({ db }) =>
    db
      .collection('wallettransfers')
      .aggregate(
        [
          {
            $project: Object.fromEntries(ORION_TRANSFER_FIELDS.map((f) => [f, 1])) as Record<string, 1>,
          },
          {
            $group: {
              _id: { u: '$userId', c: '$concept', t: '$walletTransferType' },
              monto: { $sum: '$netAmount' },
            },
          },
        ],
        { allowDiskUse: false, maxTimeMS: 180_000 },
      )
      .toArray(),
  );

  type Row = { in_ib: number; in_social: number; in_propfirm: number; in_trading: number; in_p2p: number; in_deposit: number; in_other: number; out_p2p: number };
  const vacio = (): Row => ({ in_ib: 0, in_social: 0, in_propfirm: 0, in_trading: 0, in_p2p: 0, in_deposit: 0, in_other: 0, out_p2p: 0 });
  const porUsuario = new Map<string, Row>();

  for (const a of agg) {
    const id = a._id as { u?: unknown; c?: unknown; t?: unknown };
    const uid = id.u ? String(id.u) : '';
    if (!uid) continue;
    const concepto = String(id.c ?? '');
    const dir = String(id.t ?? '');
    const monto = Number(a.monto) || 0;
    const cur = porUsuario.get(uid) ?? vacio();

    if (dir === 'OUT') {
      // De las salidas sólo interesa el P2P: mandar dinero a otro usuario es
      // la otra mitad del patrón que la entrada por P2P señala.
      if (concepto === 'TRANSFER_P2P') cur.out_p2p += monto;
      porUsuario.set(uid, cur);
      continue;
    }
    if (dir !== 'IN') continue;

    const grupo = CONCEPT_GROUPS[concepto];
    switch (grupo) {
      case 'ib': cur.in_ib += monto; break;
      case 'social': cur.in_social += monto; break;
      case 'propfirm': cur.in_propfirm += monto; break;
      case 'trading': cur.in_trading += monto; break;
      case 'p2p': cur.in_p2p += monto; break;
      case 'deposit': cur.in_deposit += monto; break;
      // Un concepto nuevo cae acá en vez de desaparecer. Si `in_other` crece,
      // es que el broker agregó un flujo que no estamos clasificando.
      default: cur.in_other += monto; break;
    }
    porUsuario.set(uid, cur);
  }

  // Sólo se guardan los clientes que tenemos espejados: una fila sin perfil no
  // se puede mostrar ni cruzar con nada.
  const perfiles = await fetchAllRows<{ user_external_id: string; email: string | null }>((from, to) =>
    admin
      .from('crm_user_snapshots')
      .select('user_external_id, email')
      .eq('company_id', companyId)
      .order('user_external_id', { ascending: true })
      .range(from, to),
  );

  const now = new Date().toISOString();
  const payload = perfiles.map((p) => {
    const v = porUsuario.get(p.user_external_id) ?? vacio();
    return {
      company_id: companyId,
      user_external_id: p.user_external_id,
      email: p.email ? p.email.trim().toLowerCase() : null,
      in_ib: round2(v.in_ib),
      in_social: round2(v.in_social),
      in_propfirm: round2(v.in_propfirm),
      in_trading: round2(v.in_trading),
      in_p2p: round2(v.in_p2p),
      in_deposit: round2(v.in_deposit),
      in_other: round2(v.in_other),
      out_p2p: round2(v.out_p2p),
      synced_at: now,
    };
  });

  let upserted = 0;
  for (const part of chunk(payload, 500)) {
    const { error } = await admin
      .from('crm_wallet_sources')
      .upsert(part, { onConflict: 'company_id,user_external_id' });
    if (error) throw new Error(`crm_wallet_sources: ${error.message}`);
    upserted += part.length;
  }

  const sinPerfil = porUsuario.size - payload.filter((p) => porUsuario.has(p.user_external_id)).length;
  if (sinPerfil > 0) {
    warnings.push(`${sinPerfil} usuario(s) con movimientos de billetera no tienen perfil espejado.`);
  }
  const otros = payload.filter((p) => p.in_other > 0).length;
  if (otros > 0) {
    warnings.push(`${otros} cliente(s) tienen dinero en conceptos SIN clasificar: revisar CONCEPT_GROUPS.`);
  }

  return {
    users: payload.length,
    upserted,
    withP2p: payload.filter((p) => p.in_p2p > 0).length,
    elapsedMs: Date.now() - started,
    warnings,
  };
}
