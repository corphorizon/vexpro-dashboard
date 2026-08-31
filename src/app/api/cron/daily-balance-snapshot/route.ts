import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchPinnedWallets } from '@/lib/pinned-wallets';
import { fetchCoinsbuyWallets } from '@/lib/api-integrations/coinsbuy/wallets';
import { fetchUnipaymentBalances } from '@/lib/api-integrations/unipayment/balances';
import { fetchFairpayBalances } from '@/lib/api-integrations/fairpay/balances';
import { fetchPayprosBalance } from '@/lib/api-integrations/paypros/balance';
import { syncChannelLedgerDay, type LedgerSyncResult } from '@/lib/channel-ledger-sync';
import { previousDay } from '@/lib/channel-ledger';
import { notify, dailyKey } from '@/lib/notifications/notify';
import { fetchOnchainTotal } from '@/lib/api-integrations/onchain/usdt-balance';
import { syncOnchainTransfers } from '@/lib/api-integrations/onchain/transfers';
import { fetchNativePrices, type NativePriceMap } from '@/lib/api-integrations/onchain/prices';
import { parseOnchainWallets } from '@/lib/cash-locations';
import { API_CHANNELS } from '@/lib/api-channels';

// ─────────────────────────────────────────────────────────────────────────────
// Canales automáticos "simples": uno leído, un total, un asiento.
//
// La lista sale del REGISTRO (`API_CHANNELS`, src/lib/api-channels.ts) menos
// Coinsbuy, que tiene reglas propias (snapshots por wallet fijada + la guarda
// de "la API no devolvió una wallet fijada") y se queda escrito a mano arriba.
// Antes eran TRES bloques try/catch con la misma forma copiada; cada uno sabía
// del canal cosas que el resto del código no, y de ahí salieron las cinco
// listas divergentes del ítem 14 (2026-08-31, auditoría de finanzas).
// ─────────────────────────────────────────────────────────────────────────────
const SIMPLE_LEDGER_CHANNELS = API_CHANNELS.filter((c) => c.key !== 'coinsbuy');

interface SimpleChannelRead {
  /** `null` = el proveedor no devolvió ninguna cuenta: no se asienta nada. */
  total: number | null;
  error?: string;
  /** Sin credenciales para este tenant: no es una falla que valga avisar. */
  notConfigured?: boolean;
  /** Legado de FairPay: el endpoint de saldo todavía no está cableado. */
  endpointMissing?: boolean;
}

/**
 * Lee el saldo del canal y lo normaliza a una sola forma. Cada proveedor
 * devuelve una shape distinta (array de cuentas, número suelto), y esa
 * traducción es lo ÚNICO específico del canal que queda en el cron.
 */
async function readSimpleChannelBalance(
  key: string,
  companyId: string,
): Promise<SimpleChannelRead> {
  if (key === 'fairpay') {
    const fp = await fetchFairpayBalances(companyId);
    if (fp.error) {
      return {
        total: null,
        error: fp.error,
        notConfigured: fp.notConfigured,
        endpointMissing: fp.endpointMissing,
      };
    }
    if (fp.balances.length === 0) return { total: null };
    return { total: fp.balances.reduce((s, b) => s + (b.availableBalance ?? 0), 0) };
  }

  if (key === 'unipayment') {
    const up = await fetchUnipaymentBalances(companyId);
    if (up.error) return { total: null, error: up.error, notConfigured: up.notConfigured };
    return {
      total: (up.balances ?? []).reduce(
        (s, b: { availableBalance?: number }) => s + (b.availableBalance ?? 0),
        0,
      ),
    };
  }

  if (key === 'paypros') {
    // Los depósitos/retiros entran por webhook (push), pero el SALDO sale de
    // GET v2/getBalance. `fetchPayprosBalance` resuelve las credenciales del
    // tenant: sin fila en api_credentials devuelve `notConfigured` y no llama
    // a nada (mismo contrato que UniPayment).
    const pp = await fetchPayprosBalance(companyId);
    if (pp.error || pp.balance === null) {
      return {
        total: null,
        error: pp.error ?? 'Pay-Pros no devolvió balance',
        notConfigured: pp.notConfigured,
      };
    }
    return { total: pp.balance };
  }

  // Un canal automático nuevo sin lector acá NO se asienta en silencio: se
  // reporta como falla y el aviso lo dice con el nombre del canal. El test de
  // `api-channels.test.ts` lo agarra antes, pero la red va igual.
  return { total: null, error: `Canal automático sin lector de saldo en el cron: ${key}` };
}

// The channel_balances table has RLS enabled; writes from the cron can't
// pass through the normal `supabase` client (no cookie → no user). This
// helper uses the service-role admin client directly.
async function adminUpsertChannelBalance(
  admin: ReturnType<typeof createAdminClient>,
  companyId: string,
  snapshotDate: string,
  channelKey: string,
  amount: number,
  source: 'manual' | 'api' | 'derived',
  /**
   * Desglose auditable del saldo (migración 085). Hoy lo usa la wallet
   * on-chain para guardar cuánto había en cada red y en cada activo, y a qué
   * precio se valuó el gas — sin esto, "$17.116" es un número sin forma de
   * reconstruirlo tres meses después.
   */
  meta?: Record<string, unknown> | null,
) {
  // ignoreDuplicates: la PRIMERA escritura del día gana. El snapshot con
  // fecha D es "el cierre de D−1" y es un hecho histórico: re-correr el cron
  // (o fijar una wallet a media tarde, que dispara un re-snapshot) NO debe
  // pisarlo con una lectura intradía. Auditoría 2026-08-06: la fila de ese
  // día fue sobreescrita a las 15:42 al fijarse la wallet 1705 y el "cierre
  // del 05" quedó inflado en ~$11.700 hasta que se restauró a mano.
  const { error } = await admin
    .from('channel_balances')
    .upsert(
      {
        company_id: companyId,
        snapshot_date: snapshotDate,
        channel_key: channelKey,
        amount,
        source,
        ...(meta ? { meta } : {}),
      },
      { onConflict: 'company_id,snapshot_date,channel_key', ignoreDuplicates: true },
    );
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// GET /api/cron/daily-balance-snapshot
//
// Vercel Cron hits this every day at 00:00 UTC (see vercel.json). It captures
// "how the previous day closed" for every company by upserting one row per
// (company, channel) into channel_balances with snapshot_date = today (UTC).
//
// Rationale: liquidez/inversiones can be reconstructed from movements, but
// Coinsbuy / UniPayment balances are point-in-time readings of the external
// API — without a snapshot we can't look up "what was my balance on Apr 5".
//
// Auth: Vercel sends `Authorization: Bearer <CRON_SECRET>` automatically
// when CRON_SECRET env var is set. Requests without that header are 401.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');

  if (!expected) {
    // Fail closed — never run without an explicit secret.
    console.error('[cron/daily-balance-snapshot] CRON_SECRET env var not set');
    return NextResponse.json(
      { success: false, error: 'CRON_SECRET not configured' },
      { status: 500 },
    );
  }

  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 },
    );
  }

  const admin = createAdminClient();

  // Snapshot date = today in UTC. This captures the end of the previous
  // day when the cron runs at 00:00 UTC, since nothing has changed yet.
  // Users querying "show me 2026-04-18" will get the row written at the
  // very start of 2026-04-19 (≡ end of 2026-04-18).
  const today = new Date().toISOString().slice(0, 10);

  // El snapshot escrito hoy a las 00:00 UTC ES el cierre de ayer, así que los
  // asientos del libro se fechan ayer. Fecharlos hoy correría el libro un día
  // y "saldo al 5 de agosto" mostraría cómo cerró el 4.
  const ledgerDate = previousDay(today);

  const { data: companies, error: listError } = await admin
    .from('companies')
    .select('id, name');

  if (listError || !companies) {
    return NextResponse.json(
      { success: false, error: listError?.message ?? 'No companies' },
      { status: 500 },
    );
  }

  // Precio del gas (TRX/BNB/ETH): UNA lectura para toda la corrida.
  //
  // El precio no depende del inquilino, así que pedirlo dentro del bucle sería
  // una llamada por empresa a un endpoint público con cuota por minuto. Si
  // falla, las wallets con gas despreciable siguen asentándose (lo cuentan
  // como 0) y las que tengan gas relevante fallan cerradas — la decisión vive
  // en fetchOnchainTotal, acá solo se transporta el dato.
  let nativePrices: NativePriceMap = {};
  let nativePriceAt: string | null = null;
  let nativePriceError: string | null = null;
  {
    const p = await fetchNativePrices();
    if (p.error !== undefined) nativePriceError = p.error;
    else {
      nativePrices = p.prices;
      nativePriceAt = p.at;
    }
  }

  // Parallel per-tenant snapshot.
  //
  // Old code iterated companies sequentially with two awaits per iteration,
  // so total time grew linearly: ~3s × N companies. At 20 tenants that was
  // already ~60s and approached Vercel Pro's 300s function-timeout cliff.
  //
  // Promise.all over the whole list fans out per-tenant work concurrently.
  // Each tenant still runs Coinsbuy + UniPayment sequentially (they share
  // DNS resolution work and IPv4-first side effect setup, so parallelising
  // within a tenant offered marginal gain and risked rate-limiting the
  // same global account today).
  //
  // Every tenant's work is wrapped in its own try/catch so one API blip
  // doesn't take down the whole run — each tenant reports its own errors
  // in the `results` array.
  const snapshotOneCompany = async (company: { id: string; name: string }) => {
    const entry: Record<string, unknown> = {
      company_id: company.id,
      company_name: company.name,
    };

    // Asientos del libro por canal. Se acumulan acá y se reportan en la
    // respuesta del cron para poder auditar el ajuste de cada día.
    const ledger: LedgerSyncResult[] = [];

    // Canales que quedaron sin asentar hoy (snapshot no escrito o asiento
    // abortado). Se avisan al final, ya con el libro procesado.
    const failures: Array<{ channel: string; date: string; reason: string }> = [];

    // ── Coinsbuy ──
    // Pass company.id so the fetcher picks up per-tenant credentials from
    // api_credentials (falling back to env when that tenant hasn't uploaded
    // its own). Same resolution the interactive endpoints use.
    //
    // We write TWO kinds of snapshot so the UI + email match the /balances
    // page granularity:
    //   1. Aggregate row `coinsbuy` with the sum of the PINNED wallets only
    //      (not all wallets returned by the API — the page also scopes to
    //      the pinned set). Keeps backwards compat for readers that only
    //      care about the total.
    //   2. One row per pinned wallet with channel_key `coinsbuy:<wallet_id>`
    //      and the individual balance. The report builder reads these and
    //      expands the `coinsbuy` channel into per-wallet rows.
    try {
      const cb = await fetchCoinsbuyWallets(company.id);
      if (cb.error) {
        entry.coinsbuy_error = cb.error;
        if (!cb.notConfigured) {
          failures.push({ channel: 'coinsbuy', date: ledgerDate, reason: cb.error });
        }
      } else {
        // Load pinned wallet selection for this tenant. BALANCE → TODAS las
        // pineadas, operativas e internas (migración 084): el snapshot diario
        // es el saldo de la empresa, y la wallet de ahorro o la de egresos
        // también tienen plata adentro.
        const pins = await fetchPinnedWallets(company.id);
        const wallets = cb.wallets ?? [];

        // Si la API respondió 200 pero le falta alguna wallet fijada
        // (respuesta parcial, wallet en mantenimiento, permisos del token),
        // el `?? 0` de abajo la convertiría en un retiro ficticio por su
        // saldo completo. Mejor no escribir nada de Coinsbuy hoy y avisar.
        const missing = pins.filter((p) => !wallets.some((w) => w.id === p.wallet_id));
        if (pins.length > 0 && missing.length > 0) {
          entry.coinsbuy_error =
            `La API no devolvió ${missing.length} wallet(s) fijada(s): ` +
            missing.map((m) => m.wallet_label || m.wallet_id).join(', ') +
            '. Snapshot y libro de hoy omitidos para no asentar un saldo falso.';
          throw new Error(entry.coinsbuy_error as string);
        }

        // Per-wallet snapshots (only for pinned ones).
        let pinnedTotal = 0;
        const perWallet: Record<string, number> = {};
        for (const p of pins) {
          const w = wallets.find((x) => x.id === p.wallet_id);
          const amt = w?.balanceConfirmed ?? 0;
          pinnedTotal += amt;
          perWallet[p.wallet_id] = amt;
          await adminUpsertChannelBalance(admin, 
            company.id,
            today,
            `coinsbuy:${p.wallet_id}`,
            amt,
            'api',
          );
        }

        // Aggregate row. If no wallets are pinned, fall back to the sum of
        // ALL wallets so tenants that haven't configured pinning still get
        // a number in the report.
        const totalForAggregate =
          pins.length > 0
            ? pinnedTotal
            : wallets.reduce((s, w) => s + (w.balanceConfirmed || 0), 0);
        await adminUpsertChannelBalance(admin, company.id, today, 'coinsbuy', totalForAggregate, 'api');
        entry.coinsbuy = totalForAggregate;
        entry.coinsbuy_pinned_wallets = perWallet;

        ledger.push(
          await syncChannelLedgerDay(admin, company.id, 'coinsbuy', ledgerDate, totalForAggregate),
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown error';
      entry.coinsbuy_error = reason;
      failures.push({ channel: 'coinsbuy', date: ledgerDate, reason });
    }

    // ── FairPay / UniPayment / Pay-Pros ──────────────────────────────────
    //
    // Los tres canales automáticos "simples" (uno leído, un total, un asiento)
    // se recorren desde el REGISTRO (`API_CHANNELS`, src/lib/api-channels.ts) y
    // no como tres bloques copiados. Eran tres `try/catch` con la misma forma y
    // la misma decisión escrita tres veces, y es donde se coló el desvío del
    // ítem 14: cada uno sabía cosas del canal que el resto del código no.
    //
    // Coinsbuy queda ARRIBA y a mano a propósito: es el único con reglas
    // propias que no caben en el bucle —snapshots por wallet fijada, la guarda
    // de "la API no devolvió una wallet fijada"—, y meterlo a la fuerza acá
    // habría exigido un registro lleno de excepciones. Un canal con reglas
    // propias explícito es mejor que un bucle con banderas.
    //
    // Las ubicaciones on-chain también quedan aparte: no tienen clave fija.
    for (const def of SIMPLE_LEDGER_CHANNELS) {
      try {
        const read = await readSimpleChannelBalance(def.key, company.id);
        if (read.error !== undefined) {
          entry[`${def.key}_error`] = read.error;
          if (!read.notConfigured) {
            failures.push({ channel: def.key, date: ledgerDate, reason: read.error });
          }
          if (read.endpointMissing) {
            // Endpoint todavía desconocido — capturar a Sentry una sola vez
            // por día por tenant para que el operador lo vea sin spamearse.
            try {
              const Sentry = await import('@sentry/nextjs');
              Sentry.captureMessage('FairPay balance endpoint not yet wired', {
                level: 'warning',
                tags: { area: 'cron.daily-balance', provider: def.key },
                extra: { companyId: company.id },
              });
            } catch { /* sentry optional */ }
          }
          continue;
        }
        if (read.total === null) continue; // sin cuentas devueltas: no se asienta nada

        await adminUpsertChannelBalance(admin, company.id, today, def.key, read.total, 'api');
        entry[def.key] = read.total;

        // `noMovementFeed` sale del registro: FairPay es el único canal
        // automático sin extracto y su día se asienta con UNA línea,
        // «Variación del saldo». Ver la cabecera de channel-ledger.ts y la
        // migración 108, que saca la rama 'fairpay' de
        // get_channel_day_movements para que ni siquiera llegue hasta acá.
        ledger.push(
          await syncChannelLedgerDay(admin, company.id, def.key, ledgerDate, read.total, {
            noMovementFeed: def.noMovementFeed === true,
          }),
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Unknown error';
        entry[`${def.key}_error`] = reason;
        failures.push({ channel: def.key, date: ledgerDate, reason });
      }
    }


    // ── Ubicaciones on-chain (migración 085) ──
    //
    // A diferencia de los canales de arriba, acá no hay una lista fija: son las
    // filas de `channel_configs` que tengan direcciones cargadas, sean built-in
    // (`wallet_externa` = la Trust Wallet de Vex Pro) o propias (`custom_*`).
    // Solo las VISIBLES: una ubicación archivada no suma al total, así que
    // gastar cuota de la cadena en leerla no tiene sentido.
    //
    // Orden importante: PRIMERO el historial de transferencias y DESPUÉS el
    // saldo + el asiento. Así, cuando el libro pregunta por los movimientos del
    // día, las transferencias de ese día ya están en api_transactions y el
    // ajuste queda solo con lo que de verdad no cuadra (fees de gas, variación
    // del precio del gas, redes sin historial).
    try {
      const { data: onchainRows, error: onchainErr } = await admin
        .from('channel_configs')
        .select('channel_key, custom_label, onchain_wallets')
        .eq('company_id', company.id)
        .eq('is_visible', true)
        .not('onchain_wallets', 'is', null);

      if (onchainErr) throw new Error(onchainErr.message);

      const onchainErrors: string[] = [];
      const onchainTotals: Record<string, number> = {};

      for (const row of onchainRows ?? []) {
        const key = String(row.channel_key);
        const label = (row.custom_label as string | null) || key;
        const wallets = parseOnchainWallets(row.onchain_wallets);
        // `not('onchain_wallets','is',null)` deja pasar `[]` y filas con basura:
        // el parser tolerante decide si de verdad hay algo que consultar.
        if (wallets.length === 0) continue;

        try {
          // 1) Historial. Un fallo acá NO frena el saldo: el libro sigue
          //    cerrando contra la cadena y lo no explicado cae en el ajuste.
          const transfers = await syncOnchainTransfers(admin, company.id, key, wallets);
          for (const t of transfers) {
            // `historyUnavailable` es una limitación conocida (BSC/ETH sin API
            // key de explorador), no una falla: se informa y no se notifica.
            if (t.error && !t.historyUnavailable) {
              onchainErrors.push(`${label} (${t.network}) historial: ${t.error}`);
            }
          }

          // 2) Saldo total: USDT + gas valuado, en todas sus redes.
          const res = await fetchOnchainTotal(wallets, {
            prices: nativePrices,
            priceAt: nativePriceAt,
          });
          if (res.error !== undefined) {
            onchainErrors.push(`${label}: ${res.error}`);
            failures.push({ channel: key, date: ledgerDate, reason: res.error });
            continue;
          }

          await adminUpsertChannelBalance(admin, company.id, today, key, res.total, 'api', {
            kind: 'onchain',
            total: res.total,
            priceAt: res.priceAt,
            readAt: new Date().toISOString(),
            networks: res.breakdown,
          });
          onchainTotals[key] = res.total;
          entry[`onchain_${key}`] = res.breakdown;

          ledger.push(
            await syncChannelLedgerDay(admin, company.id, key, ledgerDate, res.total, {
              onchain: true,
            }),
          );
        } catch (err) {
          const reason = err instanceof Error ? err.message : 'Unknown error';
          onchainErrors.push(`${label}: ${reason}`);
          failures.push({ channel: key, date: ledgerDate, reason });
        }
      }

      if (Object.keys(onchainTotals).length > 0) entry.onchain = onchainTotals;
      if (onchainErrors.length > 0) entry.onchain_errors = onchainErrors;
    } catch (err) {
      // Un problema leyendo channel_configs no puede tumbar el resto del
      // snapshot de la empresa: se informa y se sigue.
      entry.onchain_errors = [err instanceof Error ? err.message : 'Unknown error'];
    }

    if (ledger.length > 0) entry.ledger = ledger;

    // El asiento abortado por MAX_ADJUSTMENT llega hasta acá como `l.error`:
    // es el caso del 2026-08-07 (Coinsbuy, transferencia interna de $35.000)
    // que solo dejaba rastro en Sentry.
    //
    // ⚠ Y AVISAR NO ALCANZABA (corrección 2026-08-31, auditoría de finanzas).
    // Este aviso funcionó exactamente como estaba escrito y NO sirvió: entre el
    // 21 y el 31/08 Coinsbuy generó ONCE notificaciones `ledger.not_posted`
    // idénticas, una por noche, mientras el libro seguía congelado con
    // $91.756,14 de brecha. Un aviso que se repite once veces sin que nada
    // cambie deja de ser un aviso y pasa a ser ruido. El arreglo no estaba acá
    // sino en el guard, que ahora se destraba solo — ver RECOVERY_AFTER_DAYS en
    // src/lib/channel-ledger-sync.ts y el aviso `ledger.regularized` de abajo.
    for (const l of ledger) {
      if (l.error) failures.push({ channel: l.channel_key, date: l.entry_date, reason: l.error });
    }

    // El libro se destrabó solo: el saldo del canal ya es correcto, pero el
    // tramo quedó en UNA línea sin desglose. Es un aviso distinto del de "no
    // se asentó" —éste dice que SÍ se asentó y qué le falta— y por eso tiene
    // dedupe propio: si los dos compartieran clave, el que llegara segundo se
    // descartaría y nadie se enteraría de la regularización.
    for (const l of ledger) {
      if (!l.forced) continue;
      await notify(admin, {
        companyId: company.id,
        type: 'ledger.regularized',
        params: {
          channel: l.channel_key,
          date: l.entry_date,
          days: l.daysCovered ?? 1,
          amount: (l.adjustment ?? 0).toFixed(2),
        },
        link: `/balances/libro/${encodeURIComponent(l.channel_key)}`,
        dedupeKey: dailyKey(`ledger-regularized:${company.id}:${l.channel_key}`),
      });
    }

    // Un aviso por canal y por día: el dedupe deja pasar el primer motivo y
    // descarta los siguientes del mismo canal.
    for (const f of failures) {
      await notify(admin, {
        companyId: company.id,
        type: 'ledger.not_posted',
        params: { channel: f.channel, date: f.date, reason: f.reason },
        link: '/balances',
        dedupeKey: dailyKey(`ledger:${company.id}:${f.channel}`),
      });
    }

    return entry;
  };

  const results = await Promise.all(companies.map(snapshotOneCompany));

  // El libro por canal es contabilidad: un error acá no puede viajar dentro
  // de un 200. Auditoría 2026-08-06: el asiento falló todas las noches en
  // silencio porque el error quedaba en results[].ledger[] y nadie lo leía.
  const ledgerErrors = results.flatMap((r) => {
    const ledger = (r as { ledger?: LedgerSyncResult[] }).ledger ?? [];
    return ledger.filter((l) => l.error).map((l) => `${l.channel_key} ${l.entry_date}: ${l.error}`);
  });

  if (ledgerErrors.length > 0) {
    try {
      const Sentry = await import('@sentry/nextjs');
      Sentry.captureMessage('Libro por canal: asiento diario con errores', {
        level: 'error',
        tags: { area: 'cron.daily-balance', kind: 'ledger' },
        extra: { errors: ledgerErrors },
      });
    } catch { /* sentry opcional */ }

    return NextResponse.json(
      {
        success: false,
        snapshot_date: today,
        ledger_date: ledgerDate,
        companies_processed: results.length,
        ledger_errors: ledgerErrors,
        results,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    snapshot_date: today,
    ledger_date: ledgerDate,
    companies_processed: results.length,
    native_price_at: nativePriceAt,
    ...(nativePriceError ? { native_price_error: nativePriceError } : {}),
    results,
  });
}
