// ─────────────────────────────────────────────────────────────────────────────
// FÓRMULA CANÓNICA DE DISTRIBUCIÓN A SOCIOS (fuente única — BUG-01, 2026-07-12)
//
// Antes existían DOS implementaciones divergentes del "Monto a Distribuir":
//   · socios/page.tsx (periodChain)  → la que realmente reparte a socios
//   · data-context.tsx (computeSaldoChain) → la que ve /balances y /finanzas
// Diferían en 4 ejes (reserva, investmentProfits, resta de egresos, modelo de
// mes negativo), así que /balances mostraba un "Monto a Distribuir" inflado y
// un "Balance Disponible" incorrecto, contradiciendo a /socios para el mismo
// mes. Esta función es AHORA la única fuente; ambas pantallas la importan.
//
// Decisión de negocio (Kevin, 2026-07-12): investmentProfits SÍ entra en la
// base distribuible.
//
// Modelo (tipo "cuenta de ahorro", decidido por Kevin 2026-05-01):
//   ingresos      = broker_pnl + other + propFirmNetIncome + investmentProfits
//   egresos       = totalExpenses
//   saldo         = ingresos − egresos
//   · Mes NEGATIVO (saldo ≤ 0): no se distribuye (montoDistribuir = 0); la
//     reserva acumulada NO se drena; la pérdida + deuda previa se arrastran
//     como deuda al mes siguiente.
//   · Mes POSITIVO: primero se cubre la deuda arrastrada; del remanente,
//     reserva = remanente × reserve_pct (default 10%) y
//     montoDistribuir = remanente − reserva. La reserva crece monótona.
//
// La cadena es SECUENCIAL: procesá los períodos EN ORDEN cronológico y con el
// MISMO conjunto en ambos llamadores, o el arrastre (deuda/reserva) diverge.
// ─────────────────────────────────────────────────────────────────────────────

import { round2 } from './utils';

export interface PeriodDistInput {
  periodId: string;
  brokerPnl: number;
  other: number;
  propFirmNetIncome: number;
  investmentProfits: number;
  totalExpenses: number;
  /** Fracción 0..1. Default 0.10 si viene null/undefined. */
  reservePct: number | null | undefined;
}

export interface PeriodDistResult {
  ingresosNetos: number;
  egresosNetos: number;
  saldoAFavor: number; // ingresos − egresos (puede ser negativo)
  deudaArrastradaEntrada: number;
  reserveThisPeriod: number;
  reserveAccumulated: number;
  deudaArrastradaSalida: number;
  montoDistribuir: number;
}

export function computeDistributionChain(
  inputs: PeriodDistInput[],
): Map<string, PeriodDistResult> {
  const chain = new Map<string, PeriodDistResult>();
  let accReserve = 0;
  let carryDebt = 0; // deuda pendiente (número positivo)

  for (const p of inputs) {
    const ingresos = round2(
      p.brokerPnl + p.other + p.propFirmNetIncome + p.investmentProfits,
    );
    const egresos = round2(p.totalExpenses);
    const saldo = round2(ingresos - egresos);
    const reservePct = p.reservePct ?? 0.1;
    const debtIn = carryDebt;

    if (saldo <= 0) {
      // Mes negativo: la reserva no se drena; la pérdida se arrastra.
      carryDebt = round2(debtIn + Math.abs(saldo));
      chain.set(p.periodId, {
        ingresosNetos: ingresos,
        egresosNetos: egresos,
        saldoAFavor: saldo,
        deudaArrastradaEntrada: debtIn,
        reserveThisPeriod: 0,
        reserveAccumulated: accReserve,
        deudaArrastradaSalida: carryDebt,
        montoDistribuir: 0,
      });
    } else {
      // Mes positivo: cubrir deuda arrastrada primero.
      let available = saldo;
      if (carryDebt > 0) {
        if (available >= carryDebt) {
          available = round2(available - carryDebt);
          carryDebt = 0;
        } else {
          carryDebt = round2(carryDebt - available);
          available = 0;
        }
      }
      const reserve = available > 0 ? round2(available * reservePct) : 0;
      accReserve = round2(accReserve + reserve);
      const distributable = available > 0 ? round2(available - reserve) : 0;
      chain.set(p.periodId, {
        ingresosNetos: ingresos,
        egresosNetos: egresos,
        saldoAFavor: saldo,
        deudaArrastradaEntrada: debtIn,
        reserveThisPeriod: reserve,
        reserveAccumulated: accReserve,
        deudaArrastradaSalida: carryDebt,
        montoDistribuir: distributable,
      });
    }
  }

  return chain;
}
