// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/hedge-fund/payments
//
// TRES bloques de plata que se parecen y NO son lo mismo. Van separados y
// rotulados a propósito: mezclarlos daría un total que no significa nada.
//
//   (a) RENDIMIENTOS pagados a clientes — corridas (`hedgefundpayouts`) y los
//       asientos PAYOUT del libro que acreditaron. Es dinero que SALE del
//       fondo hacia el saldo del cliente.
//   (b) COMISIONES de red — lo que cobran los patrocinadores. Es otro dinero,
//       de otro bolsillo y con otra base de cálculo.
//   (c) CAPITAL devuelto y solicitudes de retiro — asientos TERMINATION y la
//       cola de `hedgefundwithdrawalrequests`. Es la devolución del principal,
//       no un rendimiento.
//
// ── LOS REVERSOS SE VEN ────────────────────────────────────────────────────
// En las comisiones, un importe negativo es un REVERSO. No se clampea ni se
// esconde: se cuenta aparte y el neto es `pagadas − reversadas`. Es la regla #1
// de §2.1, la que ya hizo pagar de más una vez.
//
// ── LOS TOTALES POR MES ────────────────────────────────────────────────────
// El mes se toma en UTC de la fecha del hecho (`finished_at` del payout,
// `created_at` del asiento, `paid_at` de la comisión con respaldo en su
// `created_at`). Convertir a hora local movería un pago del día 1 al mes
// anterior según dónde corriera el proceso — el mismo problema que la regla G4.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { HF_LEDGER_PAYOUT, monthKeyUtc, totalCommissions } from '@/lib/hedge-fund/aggregate';
import { mirrorIsStale, readHedgeFundMirror } from '@/lib/hedge-fund/server';

export const dynamic = 'force-dynamic';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** El asiento del libro que DEVUELVE capital al cliente. */
const HF_LEDGER_TERMINATION = 'TERMINATION';

interface MonthTotal {
  ym: string;
  amount: number;
  count: number;
}

/**
 * Totales por mes. Una fila sin fecha utilizable NO se mete en un mes
 * inventado: se cuenta aparte, porque un importe colgado de un mes equivocado
 * es peor que un importe que se sabe sin fecha.
 */
function porMes(
  filas: Array<{ fecha: string | null; monto: number | null }>,
): { months: MonthTotal[]; withoutDate: number; withoutDateAmount: number } {
  const mapa = new Map<string, MonthTotal>();
  let withoutDate = 0;
  let withoutDateAmount = 0;
  for (const f of filas) {
    const monto = f.monto ?? 0;
    const ym = f.fecha ? monthKeyUtc(f.fecha) : null;
    if (!ym) {
      withoutDate++;
      withoutDateAmount += monto;
      continue;
    }
    const acc = mapa.get(ym) ?? { ym, amount: 0, count: 0 };
    acc.amount += monto;
    acc.count++;
    mapa.set(ym, acc);
  }
  return {
    months: [...mapa.values()]
      .map((m) => ({ ...m, amount: round2(m.amount) }))
      .sort((a, b) => b.ym.localeCompare(a.ym)),
    withoutDate,
    withoutDateAmount: round2(withoutDateAmount),
  };
}

export async function GET(request: NextRequest) {
  const auth = await verifyAdminAuth(request, { modules: ['hedge_fund'] });
  if (auth instanceof NextResponse) return auth;

  try {
    const admin = createAdminClient();
    const mirror = await readHedgeFundMirror(admin, auth.companyId, {
      ledger: true, payouts: true, commissions: true, withdrawalRequests: true,
    });

    const asientosPayout = mirror.ledger.filter((e) => e.type === HF_LEDGER_PAYOUT);
    const asientosTerminacion = mirror.ledger.filter((e) => e.type === HF_LEDGER_TERMINATION);

    // Los tipos de asiento que NO son ninguno de los dos anteriores. Se
    // informan con su nombre en vez de descartarse: un tipo nuevo del CRM tiene
    // que aparecer, no desaparecer de los tres bloques sin dejar rastro.
    const otrosTipos = [
      ...new Set(
        mirror.ledger
          .filter((e) => e.type !== HF_LEDGER_PAYOUT && e.type !== HF_LEDGER_TERMINATION)
          .map((e) => e.type ?? '(sin tipo)'),
      ),
    ].sort();

    return NextResponse.json({
      success: true,

      // (a) Rendimientos pagados a clientes
      returns: {
        runs: mirror.payouts
          .map((p) => ({
            payoutId: p.payout_id,
            fundKey: p.fund_key,
            program: p.program,
            percent: p.percent,
            status: p.status,
            accountsAffected: p.accounts_affected,
            totalCredited: p.total_credited,
            currency: p.currency,
            executedBy: p.executed_by,
            at: p.finished_at ?? p.started_at,
          }))
          .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')),
        entries: asientosPayout
          .map((e) => ({
            entryId: e.entry_id,
            investmentId: e.investment_id,
            userExternalId: e.user_external_id,
            fundKey: e.fund_key,
            amount: e.amount,
            currency: e.currency,
            payoutId: e.payout_id,
            description: e.description,
            at: e.source_created_at,
          }))
          .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')),
        total: round2(asientosPayout.reduce((s, e) => s + (e.amount ?? 0), 0)),
        byMonth: porMes(asientosPayout.map((e) => ({ fecha: e.source_created_at, monto: e.amount }))),
      },

      // (b) Comisiones de red, con los reversos a la vista
      commissions: {
        rows: mirror.commissions
          .map((c) => ({
            commissionId: c.commission_id,
            type: c.type,
            beneficiary: c.beneficiary_username ?? c.beneficiary_user_external_id,
            source: c.source_username ?? c.source_user_external_id,
            investmentId: c.investment_id,
            fundKey: c.fund_key,
            level: c.level,
            percent: c.percent,
            baseAmount: c.base_amount,
            amount: c.amount,
            currency: c.currency,
            ym: c.ym,
            status: c.status,
            at: c.paid_at ?? c.source_created_at,
          }))
          .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')),
        totals: totalCommissions(mirror.commissions),
        byMonth: porMes(
          mirror.commissions.map((c) => ({ fecha: c.paid_at ?? c.source_created_at, monto: c.amount })),
        ),
      },

      // (c) Capital devuelto y solicitudes de retiro
      capital: {
        requests: mirror.withdrawalRequests
          .map((w) => ({
            requestId: w.request_id,
            investmentId: w.investment_id,
            userExternalId: w.user_external_id,
            fundKey: w.fund_key,
            status: w.status,
            type: w.type,
            amount: w.amount,
            currency: w.currency,
            at: w.requested_at ?? w.source_created_at,
            processedAt: w.processed_at,
          }))
          .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')),
        terminations: asientosTerminacion
          .map((e) => ({
            entryId: e.entry_id,
            investmentId: e.investment_id,
            userExternalId: e.user_external_id,
            fundKey: e.fund_key,
            amount: e.amount,
            currency: e.currency,
            description: e.description,
            at: e.source_created_at,
          }))
          .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')),
        // Con SIGNO: una terminación resta y tiene que verse restando.
        total: round2(asientosTerminacion.reduce((s, e) => s + (e.amount ?? 0), 0)),
        byMonth: porMes(
          asientosTerminacion.map((e) => ({ fecha: e.source_created_at, monto: e.amount })),
        ),
      },

      /** Tipos de asiento que no caen en ninguno de los tres bloques. */
      otherLedgerTypes: otrosTipos,
      excluded: mirror.excluded,
      lastSyncedAt: mirror.lastSyncedAt,
      stale: mirrorIsStale(mirror.lastSyncedAt),
    });
  } catch (err) {
    return apiError('admin/hedge-fund/payments', err, { status: 500 });
  }
}
