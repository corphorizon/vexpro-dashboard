// ─────────────────────────────────────────────────────────────────────────────
// El Net Deposit tiene UN valor — migración 109, auditoría de finanzas, ítem 11.
//
// `get_period_totals_by_month` (que alimenta /balances, el gráfico de
// /resumen-general y /finanzas/consolidado) no descontaba las exclusiones
// manuales del admin, y `computeProviderTotals` —que alimenta /movimientos— sí.
// El mismo mes daba dos Net Deposit distintos, y el de /balances es el que
// alimenta la cadena de distribución a socios.
//
// Se prueba el TEXTO de la migración (regla G11 del manual: «un test contra la
// base pasaría igual el día que el filtro se rompa; cero filas y cero
// exclusiones se ven idénticos»), más la aritmética de la convergencia con los
// números REALES medidos en producción.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeDerivedNetDeposit } from './broker-logic';
import { ACCEPTED_STATUS } from './api-integrations/totals';

const sql = readFileSync(
  join(process.cwd(), 'supabase', 'migration-109-net-deposit-excluidas.sql'),
  'utf8',
);

describe('migración 109 — la RPC aprende las exclusiones manuales', () => {
  it('reemplaza la RPC, no crea una segunda', () => {
    expect(sql).toMatch(/create or replace function public\.get_period_totals_by_month/);
    expect(sql).not.toMatch(/create function public\.get_period_totals/);
  });

  it('excluye por la clave ÚNICA (company_id, provider, external_id)', () => {
    const clause = sql.slice(sql.indexOf('not exists'), sql.indexOf('group by month'));
    expect(clause).toMatch(/from public\.excluded_transactions x/);
    expect(clause).toMatch(/x\.company_id\s*=\s*t\.company_id/);
    expect(clause).toMatch(/x\.provider\s*=\s*t\.provider/);
    expect(clause).toMatch(/x\.external_id\s*=\s*t\.external_id/);
  });

  it('es un semi-join, no un left join que pueda duplicar importes', () => {
    expect(sql).toMatch(/and not exists \(/);
    expect(sql).not.toMatch(/left join public\.excluded_transactions/);
  });

  it('el filtro va en el WHERE, así vale para depósitos Y para retiros', () => {
    // Si estuviera sólo dentro de uno de los dos FILTER de abajo, la mitad de
    // las exclusiones seguiría contando. Mayo 2026 tiene de las dos clases.
    expect(sql.indexOf('not exists')).toBeLessThan(sql.indexOf('filter ('));
  });

  it('conserva los filtros que ya estaban (status, wallets, internas)', () => {
    // El cuerpo es el de la migración 108 más el `not exists`. Perder
    // cualquiera de estos filtros sería un bug nuevo escondido en el arreglo.
    for (const [slug, status] of Object.entries(ACCEPTED_STATUS)) {
      expect(sql).toContain(`t.provider = '${slug}'`);
      expect(sql).toContain(`'${status}'`);
    }
    expect(sql).toMatch(/coalesce\(t\.internal, false\) = false/);
    expect(sql).toMatch(/t\.wallet_id = any\(p\.ids\)/);
    expect(sql).toMatch(/role = 'operating'/);
    expect(sql).toMatch(/'payout_paid'/);
  });

  it('no toca los grants (076/077/078: sólo el service role)', () => {
    expect(sql).not.toMatch(/grant execute on function public\.get_period_totals_by_month/);
  });
});

describe('convergencia del Net Deposit (medida en producción, 2026-08-31)', () => {
  // Ensayo BEGIN/ROLLBACK contra producción, empresa Vex Pro. Las columnas
  // `antes` son lo que la RPC devuelve HOY; `despues`, con la migración 109
  // aplicada dentro de la transacción. `esperado` es el Net Deposit que
  // /movimientos ya mostraba, que es el correcto.
  const meses = [
    { mes: '2026-05', antes: { d: 578_611.10, r: 565_548.00 }, despues: { d: 538_811.10, r: 479_920.59 }, divergencia: 45_827.41 },
    { mes: '2026-06', antes: { d: 1_021_282.59, r: 663_215.95 }, despues: { d: 1_021_282.59, r: 556_815.53 }, divergencia: 106_400.42 },
    { mes: '2026-07', antes: { d: 1_433_020.85, r: 1_081_717.70 }, despues: { d: 1_433_020.85, r: 914_079.18 }, divergencia: 167_638.52 },
  ];

  it.each(meses)('$mes: la diferencia era exactamente lo excluido', ({ antes, despues, divergencia }) => {
    const ndAntes = antes.d - antes.r;
    const ndDespues = despues.d - despues.r;
    expect(ndDespues - ndAntes).toBeCloseTo(divergencia, 2);
  });

  it('los tres meses sumaban $319.866,35 de diferencia', () => {
    const total = meses.reduce((s, m) => s + m.divergencia, 0);
    expect(total).toBeCloseTo(319_866.35, 2);
  });

  it('julio: /balances pasa de $351.303,15 a los $518.941,67 de /movimientos', () => {
    // Los dos lados usan la MISMA fórmula (computeDerivedNetDeposit); lo único
    // que difería era el componente de API que le entraba. Sin términos
    // manuales (julio no tiene depósitos manuales ni broker manual cargado),
    // el ND es el componente de API puro.
    const sinManual = { manualDepositsTotal: 0, manualBroker: 0 };
    const { antes, despues } = meses[2];

    const balancesAntes = computeDerivedNetDeposit({
      apiDeposits: antes.d,
      apiWithdrawals: antes.r,
      ...sinManual,
    });
    const balancesDespues = computeDerivedNetDeposit({
      apiDeposits: despues.d,
      apiWithdrawals: despues.r,
      ...sinManual,
    });

    expect(balancesAntes.netDeposit).toBeCloseTo(351_303.15, 2);
    expect(balancesDespues.netDeposit).toBeCloseTo(518_941.67, 2);
    expect(balancesDespues.netDeposit - balancesAntes.netDeposit).toBeCloseTo(167_638.52, 2);
  });
});
