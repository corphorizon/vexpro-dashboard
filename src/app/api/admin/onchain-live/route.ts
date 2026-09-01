// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/onchain-live
//
// Saldo EN VIVO de los canales con direcciones on-chain (la Trust Wallet de
// Vex Pro y cualquier ubicación propia con `onchain_wallets`).
//
// ── POR QUÉ EXISTE ─────────────────────────────────────────────────────────
// Hasta hoy estos canales se leían UNA vez al día, en el cron de medianoche, y
// /balances mostraba esa foto durante 24 h. Kevin (2026-09-01): «la trust
// wallet no está sincronizada en vex». No estaba desincronizada: estaba vieja.
// Medido ese día: el snapshot de las 00:01 UTC decía 80.539,70 USDT en Tron y
// doce horas después la cadena tenía 14.807,54 — habían salido 65.732 después
// de la foto. La pantalla mostraba $81.110,76 con $15.307,53 reales.
//
// Los otros canales de API (Coinsbuy, UniPayment, FairPay, Pay-Pros) ya se
// refrescaban en vivo; el on-chain quedó fuera porque su clave de canal es un
// dato (`wallet_externa` o cualquier `custom_*`), no una constante del
// registro. Por eso este endpoint resuelve las direcciones leyendo
// `channel_configs.onchain_wallets`, igual que hace el cron.
//
// Un canal que no se pueda leer NO devuelve 0: sale en `unavailable` y la
// pantalla cae al libro/snapshot avisando que el dato está degradado.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { fetchLiveChannelBalances } from '@/lib/api-integrations/live-balances';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { modules: ['balances'] });
    if (auth instanceof NextResponse) return auth;

    const { byChannel, unavailable } = await fetchLiveChannelBalances(auth.companyId, {
      onlyOnchain: true,
    });

    return NextResponse.json({
      success: true,
      balances: Object.fromEntries(byChannel),
      unavailable,
      readAt: new Date().toISOString(),
    });
  } catch (err) {
    return apiError('admin/onchain-live', err, { status: 500 });
  }
}
