import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchCoinsbuyWallets } from '@/lib/api-integrations/coinsbuy/wallets';
import { fetchUnipaymentBalances } from '@/lib/api-integrations/unipayment/balances';
import { fetchFairpayBalances } from '@/lib/api-integrations/fairpay/balances';
import { syncChannelLedgerDay, type LedgerSyncResult } from '@/lib/channel-ledger-sync';
import { previousDay } from '@/lib/channel-ledger';
import { notify, dailyKey } from '@/lib/notifications/notify';

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
        // Load pinned wallet selection for this tenant.
        const { data: pinned } = await admin
          .from('pinned_coinsbuy_wallets')
          .select('wallet_id, wallet_label')
          .eq('company_id', company.id);
        const pins = pinned ?? [];
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

    // ── FairPay ──
    // Activado 2026-06-06. `fetchFairpayBalances` es defensivo: si FairPay
    // no expone /api/v1/getBalance (404 / shape no reconocida) devuelve
    // `error` sin throw → registramos el error en entry.fairpay_error y
    // continuamos con el resto del snapshot.
    try {
      const fp = await fetchFairpayBalances(company.id);
      if (fp.error) {
        entry.fairpay_error = fp.error;
        if (!fp.notConfigured) {
          failures.push({ channel: 'fairpay', date: ledgerDate, reason: fp.error });
        }
        if (fp.endpointMissing) {
          // Endpoint todavía desconocido — capturar a Sentry una sola vez
          // por día por tenant para que el operador lo vea sin spamearse.
          try {
            const Sentry = await import('@sentry/nextjs');
            Sentry.captureMessage('FairPay balance endpoint not yet wired', {
              level: 'warning',
              tags: { area: 'cron.daily-balance', provider: 'fairpay' },
              extra: { companyId: company.id },
            });
          } catch { /* sentry optional */ }
        }
      } else if (fp.balances.length > 0) {
        const total = fp.balances.reduce(
          (s, b) => s + (b.availableBalance ?? 0),
          0,
        );
        await adminUpsertChannelBalance(admin, company.id, today, 'fairpay', total, 'api');
        entry.fairpay = total;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown error';
      entry.fairpay_error = reason;
      failures.push({ channel: 'fairpay', date: ledgerDate, reason });
    }

    // ── UniPayment ──
    try {
      const up = await fetchUnipaymentBalances(company.id);
      if (up.error) {
        entry.unipayment_error = up.error;
        if (!up.notConfigured) {
          failures.push({ channel: 'unipayment', date: ledgerDate, reason: up.error });
        }
      } else {
        const total = (up.balances ?? []).reduce(
          (s, b: { availableBalance?: number }) => s + (b.availableBalance ?? 0),
          0,
        );
        await adminUpsertChannelBalance(admin, company.id, today, 'unipayment', total, 'api');
        entry.unipayment = total;

        ledger.push(
          await syncChannelLedgerDay(admin, company.id, 'unipayment', ledgerDate, total),
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown error';
      entry.unipayment_error = reason;
      failures.push({ channel: 'unipayment', date: ledgerDate, reason });
    }

    if (ledger.length > 0) entry.ledger = ledger;

    // El asiento abortado por MAX_ADJUSTMENT llega hasta acá como
    // `l.error`: es el caso del 2026-08-07 (Coinsbuy, transferencia interna
    // de $35.000) que solo dejaba rastro en Sentry.
    for (const l of ledger) {
      if (l.error) failures.push({ channel: l.channel_key, date: l.entry_date, reason: l.error });
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
    results,
  });
}
