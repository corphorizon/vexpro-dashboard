// ─────────────────────────────────────────────────────────────────────────────
// partner-rows — filas del reparto y del historial de /socios, sin React
// (rediseño «Libro mayor», 2026-10-12).
//
// POR QUÉ:
//   · Reparto: la tabla vieja y la barra de participación vivían en dos
//     tarjetas distintas, con un color de paleta cruda por socio (`COLORS`,
//     seis hex) que no significaba nada (spec §2.1). El PDF de cierre ya tenía
//     la forma buena — socio, % con barra proporcional, monto, pie «100 % /
//     total» (`pdfPartnerTable` en pdf-export.ts) — y sus montos salen de
//     `partnerShareRows` (monthly-close-pdf-data.ts), que deja `null` cuando la
//     distribución no es definitiva. Acá se usa ESA función: la pantalla y el
//     papel no pueden decir montos distintos para el mismo socio.
//   · Historial: el cálculo vivía inline en el JSX, repetido tres veces
//     (filas, pie por socio, pie total), cada copia con su `?? 0`. Un mes que
//     no estaba en la cadena salía «$0.00» por socio — «no lo sabemos» leído
//     como «no cobró» (§1.3). Ahora un mes pendiente o ausente es null y no
//     suma, y el pie dice cuántos meses quedaron afuera.
//
// La fórmula NO cambia (monto del socio = montoDistribuir × %, con el %
// guardado del mes si existe; round2 por socio — BUG-02). El test fija los
// números contra los de la página vieja.
//
// DESCARTADO: que el pie del historial sume los montos por socio en vez del
// monto a distribuir del mes. Con % que no suman 100 los dos números difieren
// y la pantalla vieja mostraba el monto a distribuir; se mantiene (el banner
// de «los porcentajes suman X %» ya dice cuánto queda sin dueño).
// ─────────────────────────────────────────────────────────────────────────────

import { partnerShareRows } from '@/lib/monthly-close-pdf-data';
import { round2 } from '@/lib/utils';

// ─── Reparto ────────────────────────────────────────────────────────────────

export interface PartnerShareInputRow {
  id: string;
  name: string;
  email?: string | null;
  /** Fracción 0..1. */
  pct: number;
  amount: number;
}

export interface PartnerShareTableRow {
  key: string;
  partnerId: string;
  name: string;
  email: string | null;
  /** 0..100, para el texto. */
  sharePct: number;
  /** Ancho de la barra (0..100): el % recortado, como en el PDF. */
  barPct: number;
  /** null = la distribución no es definitiva (serie del CRM faltante). */
  amount: number | null;
}

export interface PartnerShareTable {
  rows: PartnerShareTableRow[];
  /** null si la distribución no es definitiva. */
  total: number | null;
  /** Suma de %, 0..100 (el pie la muestra tal cual: si no da 100, se ve). */
  totalPct: number;
}

export function partnerShareTable(
  partners: readonly PartnerShareInputRow[],
  distribucionConocida: boolean,
): PartnerShareTable {
  const { rows, total } = partnerShareRows(
    partners.map((p) => ({ name: p.name, pct: p.pct, amount: p.amount })),
    distribucionConocida,
  );
  return {
    rows: rows.map((r, i) => {
      const p = partners[i];
      const sharePct = r.pct * 100;
      return {
        key: p.id,
        partnerId: p.id,
        name: r.name,
        email: p.email ?? null,
        sharePct,
        barPct: Math.max(0, Math.min(100, sharePct)),
        amount: r.amount,
      };
    }),
    total,
    totalPct: round2(partners.reduce((s, p) => s + p.pct, 0) * 100),
  };
}

// ─── Historial ──────────────────────────────────────────────────────────────

export interface HistoryPeriod {
  id: string;
  label: string | null;
}

export interface HistoryChainEntry {
  montoDistribuir: number;
  deudaArrastradaEntrada: number;
  pendiente: boolean;
}

export interface HistoryRow {
  periodId: string;
  label: string;
  /** Monto por socio (clave = partnerId). null = mes sin dato definitivo. */
  amounts: Record<string, number | null>;
  /** Suma de los montos por socio del mes. null = mes sin dato definitivo. */
  total: number | null;
  /** Deuda arrastrada que entra al mes (> 0 se marca). null si no se sabe. */
  debtIn: number | null;
  /** El mes no suma: serie del CRM faltante (propia o heredada). */
  pending: boolean;
  /** El mes no está en la cadena: no se sabe nada de él. */
  missing: boolean;
}

export interface HistoryTable {
  rows: HistoryRow[];
  /** Total por socio, sólo meses definitivos. */
  partnerTotals: Record<string, number>;
  /** Σ monto a distribuir (> 0) de los meses definitivos. */
  grandTotal: number;
  /** Meses que no suman (pendientes o ausentes), para decirlo en el pie. */
  excluded: string[];
}

export function partnerHistory(input: {
  periods: readonly HistoryPeriod[];
  partners: ReadonlyArray<{ id: string; percentage: number }>;
  /** Filas guardadas de partner_distributions (sólo se lee el %). */
  saved: ReadonlyArray<{ period_id: string; partner_id: string; percentage: number }>;
  chainOf: (periodId: string) => HistoryChainEntry | null | undefined;
}): HistoryTable {
  const partnerTotals: Record<string, number> = Object.fromEntries(input.partners.map((p) => [p.id, 0]));
  let grand = 0;
  const excluded: string[] = [];

  const rows = input.periods.map((period): HistoryRow => {
    const label = period.label ?? '';
    const chain = input.chainOf(period.id);
    const missing = !chain;
    const pending = !!chain?.pendiente;
    if (!chain || chain.pendiente) {
      excluded.push(label);
      return {
        periodId: period.id,
        label,
        amounts: Object.fromEntries(input.partners.map((p) => [p.id, null])),
        total: null,
        debtIn: chain ? chain.deudaArrastradaEntrada : null,
        pending,
        missing,
      };
    }
    const md = chain.montoDistribuir;
    const amounts: Record<string, number | null> = {};
    let total = 0;
    for (const p of input.partners) {
      const s = input.saved.find((d) => d.period_id === period.id && d.partner_id === p.id);
      const pct = s?.percentage ?? p.percentage;
      const amount = md > 0 ? round2(md * pct) : 0;
      amounts[p.id] = amount;
      total += amount;
      partnerTotals[p.id] += amount;
    }
    if (md > 0) grand += md;
    return {
      periodId: period.id,
      label,
      amounts,
      total: round2(total),
      debtIn: chain.deudaArrastradaEntrada,
      pending: false,
      missing: false,
    };
  });

  for (const k of Object.keys(partnerTotals)) partnerTotals[k] = round2(partnerTotals[k]);
  return { rows, partnerTotals, grandTotal: round2(grand), excluded };
}
