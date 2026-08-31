import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchLiveChannelBalances } from '@/lib/api-integrations/live-balances';
import { apiError } from '@/lib/api-error';
import { resolveChannels, type ChannelConfigRow } from '@/lib/channel-configs';
import { pickChannelAmount, type ReportChannelSource } from '@/lib/reports/balances-by-channel';
import { isLiquid, normalizeLocationType, type LocationType } from '@/lib/cash-locations';

// ---------------------------------------------------------------------------
// GET /api/balances/total-consolidado
//
// Returns the same big number /balances shows at the bottom — Σ of every
// VISIBLE channel as it stands RIGHT NOW. Computed server-side so the home
// card doesn't have to repeat the logic and so we get fresh API values
// without waiting for the daily cron.
//
// LA LISTA DE CANALES SALE DE channel_configs, NO DE UNA LISTA FIJA.
// Hasta 2026-08 este endpoint sumaba siete claves hardcodeadas (coinsbuy,
// unipayment, fairpay, wallet_externa, otros + liquidez + inversiones), así
// que NINGUNA ubicación personalizada (`custom_*`) entraba jamás en el total:
// Vex Pro tenía una wallet propia con ~$16.335 de saldo de libro y el "Total
// Consolidado" de la home mostraba menos que /balances por exactamente esa
// plata. Ahora se resuelven los canales igual que en la pantalla
// (resolveChannels + is_visible) y se lee el mismo saldo.
//
// Resolution rules (mirror /balances `getChannelValue`):
//   · canal automático con saldo en vivo → API del proveedor, AHORA
//   · resto      → LIBRO (channel_ledger_entries vía RPC), snapshot como
//                  respaldo para el canal que todavía no abrió libro
//   · liquidez   → running sum of liquidity_movements (deposit − withdrawal)
//   · inversiones → running sum of investments (deposit − withdrawal + profit)
//
// ── QUIÉN SE REFRESCA EN VIVO SALE DEL REGISTRO ────────────────────────────
// (2026-08-31, auditoría de finanzas, ítem 14)
// Hasta hoy eran DOS ramas escritas a mano: `ch.key === 'coinsbuy'` y
// `ch.key === 'unipayment'`. Los otros dos canales automáticos —FairPay y
// Pay-Pros, los dos con endpoint de saldo y los dos leídos por el cron cada
// noche— caían al libro. Medido ese día en Vex Pro: **Pay-Pros con $39.944
// mostraba el saldo de anoche y UniPayment con $21 se refrescaba**. La tarjeta
// dice «ahora mismo» y era mentira justo para el canal grande.
// Ahora la lista sale de `LIVE_BALANCE_CHANNELS` y los fetchers de
// `api-integrations/live-balances.ts`, con un test que cruza las dos.
//
// Un canal que no se pudo leer en vivo NO baja el total: cae a libro/snapshot
// y su clave viaja en `liveUnavailable` para que la pantalla pueda decirlo.
// `null` es "no lo sabemos", nunca 0 (§1.2 / §1.3 de las reglas).
//
// La elección libro-vs-snapshot NO se reimplementa acá: es `pickChannelAmount`
// de reports/balances-by-channel, la misma que usa el reporte. Tres copias de
// esa regla fue lo que hizo divergir las pantallas en la auditoría 2026-08.
//
// Each external API call has a 5s timeout. If one fails we fall back to its
// libro/snapshot so the total never silently drops to 0 because of a
// transient API blip. The response includes `breakdown` so the client can
// show "what counted" if it wants to.
//
// `total` incluye lo prestado, porque es lo que muestra /balances y los dos
// números tienen que coincidir. Para quien necesite la distinción, la
// respuesta trae además `liquid` (todo menos las ubicaciones `loan`) y `lent`
// — un préstamo es patrimonio, pero no es caja disponible mañana.
// ---------------------------------------------------------------------------

const API_TIMEOUT_MS = 5000;

export async function GET(request: NextRequest) {
  try {
    // Sigue en verifyAuth (cualquier rol) A PROPÓSITO: la tarjeta de total
    // consolidado es la home de TODOS los usuarios, socios incluidos. Lo que
    // faltaba era el módulo — ahora sin 'balances' (para el usuario o para la
    // empresa) esto es 403 en vez de una cifra consolidada servida a cualquiera.
    const auth = await verifyAuth(request, { modules: ['balances'] });
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const today = new Date().toISOString().slice(0, 10);

    // ── Parallel data pulls ──────────────────────────────────────────────
    const [
      configsRes,
      ledgerRes,
      asOfRes,
      liveRes,
      liquidityRes,
      investmentsRes,
    ] = await Promise.allSettled([
      admin
        .from('channel_configs')
        .select(
          'id, channel_key, custom_label, channel_type, is_visible, is_custom, sort_order, location_type',
        )
        .eq('company_id', auth.companyId)
        .order('sort_order', { ascending: true }),
      admin.rpc('get_channel_ledger_balances', {
        p_company_id: auth.companyId,
        p_asof: today,
      }),
      admin.rpc('channel_balances_as_of', { p_company_id: auth.companyId, p_date: today }),
      // Saldo en vivo de TODOS los canales automáticos del registro, en
      // paralelo y con timeout por canal. Coinsbuy scopea a las wallets
      // FIJADAS (todas, operativas e internas: la plata de la wallet de ahorro
      // o la de egresos sigue siendo plata de la empresa — migración 084);
      // esa regla vive dentro del fetcher, no acá.
      fetchLiveChannelBalances(auth.companyId, { timeoutMs: API_TIMEOUT_MS }),
      admin
        .from('liquidity_movements')
        .select('deposit, withdrawal')
        .eq('company_id', auth.companyId),
      admin
        .from('investments')
        .select('deposit, withdrawal, profit')
        .eq('company_id', auth.companyId),
    ]);

    // ── Canales de la empresa (built-ins + personalizados, solo visibles) ─
    const configRows: ChannelConfigRow[] =
      configsRes.status === 'fulfilled' && !configsRes.value.error
        ? ((configsRes.value.data ?? []) as ChannelConfigRow[])
        : [];
    const locationTypeByKey = new Map<string, LocationType>(
      configRows.map((r) => [r.channel_key, normalizeLocationType(r.location_type)]),
    );
    const visibleChannels = resolveChannels(configRows).filter((c) => c.isVisible);

    // ── Saldo del LIBRO por canal (fuente preferida) ─────────────────────
    const ledgerByKey = new Map<string, number>();
    if (ledgerRes.status === 'fulfilled' && !ledgerRes.value.error) {
      for (const r of (ledgerRes.value.data ?? []) as Array<{
        channel_key: string;
        balance: number | string;
      }>) {
        const n = Number(r.balance);
        if (Number.isFinite(n)) ledgerByKey.set(r.channel_key, n);
      }
    }

    // ── Channel snapshots (as-of today) — respaldo ───────────────────────
    type SnapRow = { channel_key: string; amount: number; source?: string };
    const snapshots: SnapRow[] =
      asOfRes.status === 'fulfilled' && !asOfRes.value.error
        ? (asOfRes.value.data ?? [])
        : [];
    const snapByKey = new Map(
      snapshots.map((s) => [
        s.channel_key,
        { amount: Number(s.amount || 0), source: s.source ?? 'manual' },
      ]),
    );

    // ── Saldo en vivo por canal automático ───────────────────────────────
    // Todo el que falle queda fuera del Map y su clave viaja en
    // `liveUnavailable`: el canal cae a libro/snapshot y la exclusión se
    // informa en vez de tragarse.
    const liveByChannel =
      liveRes.status === 'fulfilled' ? liveRes.value.byChannel : new Map<string, number>();
    const liveUnavailable =
      liveRes.status === 'fulfilled' ? liveRes.value.unavailable : [];

    // ── Liquidez running balance ─────────────────────────────────────────
    type LiqRow = { deposit: number | null; withdrawal: number | null };
    const liquidez =
      liquidityRes.status === 'fulfilled' && !liquidityRes.value.error
        ? ((liquidityRes.value.data as LiqRow[] | null) ?? []).reduce(
            (s, r) => s + (r.deposit ?? 0) - (r.withdrawal ?? 0),
            0,
          )
        : 0;

    // ── Inversiones running balance ──────────────────────────────────────
    type InvRow = { deposit: number | null; withdrawal: number | null; profit: number | null };
    const inversiones =
      investmentsRes.status === 'fulfilled' && !investmentsRes.value.error
        ? ((investmentsRes.value.data as InvRow[] | null) ?? []).reduce(
            (s, r) => s + (r.deposit ?? 0) - (r.withdrawal ?? 0) + (r.profit ?? 0),
            0,
          )
        : 0;

    // ── Un renglón por canal visible ─────────────────────────────────────
    const breakdown: Record<
      string,
      { amount: number; source: ReportChannelSource; label: string; liquid: boolean }
    > = {};
    let total = 0;
    let liquid = 0;
    let lent = 0;

    for (const ch of visibleChannels) {
      let amount: number;
      let source: ReportChannelSource;

      if (ch.key === 'liquidez') {
        amount = liquidez;
        source = 'computed';
      } else if (ch.key === 'inversiones') {
        amount = inversiones;
        source = 'computed';
      } else if (liveByChannel.has(ch.key)) {
        amount = liveByChannel.get(ch.key) as number;
        source = 'live';
      } else {
        const picked = pickChannelAmount({
          channelKey: ch.key,
          ledgerBalance: ledgerByKey.get(ch.key),
          snapshot: snapByKey.get(ch.key),
        });
        amount = picked.amount;
        source = picked.source;
      }

      // liquidez/inversiones no son ubicaciones físicas: no tienen fila en
      // channel_configs con tipo, y ninguna de las dos es un préstamo.
      const isLent = !isLiquid(locationTypeByKey.get(ch.key));
      total += amount;
      if (isLent) lent += amount;
      else liquid += amount;

      breakdown[ch.key] = { amount, source, label: ch.label, liquid: !isLent };
    }

    return NextResponse.json({
      success: true,
      total,
      liquid,
      lent,
      asOf: new Date().toISOString(),
      breakdown,
      /**
       * Canales automáticos que NO se pudieron leer en vivo y por lo tanto se
       * muestran con el saldo del libro/snapshot (dato viejo, pero verdadero).
       * Viaja hasta el cliente porque «$39.944 de ahora» y «$39.944 de anoche»
       * son afirmaciones distintas.
       */
      liveUnavailable,
    });
  } catch (err) {
    return apiError('balances/total-consolidado', err, { status: 500 });
  }
}
