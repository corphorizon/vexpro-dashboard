'use client';

import { AlertTriangle } from 'lucide-react';
import { useData } from '@/lib/data-context';

// ─────────────────────────────────────────────────────────────────────────────
// «Estos números están CORTOS» — el aviso que faltaba.
//
// POR QUÉ (2026-08-31, auditoría de finanzas, ítem 19)
// `/api/bootstrap` trae los egresos, los depósitos, los retiros, los resultados
// mensuales y las distribuciones con un `.limit(10_000)` cada uno. El techo
// existe por buenas razones —una empresa con varios años de historia no puede
// tirarle todo al navegador— pero NO avisaba: un tenant que lo superara recibía
// las primeras 10.000 filas y la pantalla sumaba ESAS. El resultado es un total
// menor que el real, plausible, y sin una sola señal de que falte algo.
//
// Es el §1.2 de las reglas del proyecto: *un recorte silencioso es
// indistinguible de «no hay más»*. Y en dinero, indistinguible de un mes flojo.
//
// Va en el shell del dashboard y no en una pantalla: el slice recortado puede
// alimentar cualquiera de ellas, y el aviso tiene que estar donde se mire el
// número, sea cual sea. No se puede cerrar a propósito — mientras los datos
// estén incompletos, el aviso es tan cierto como la primera vez.
// ─────────────────────────────────────────────────────────────────────────────

/** Nombre legible del slice. Lo que no esté acá se muestra con su clave. */
const SLICE_LABELS: Record<string, string> = {
  monthlyResults: 'resultados comerciales',
  deposits: 'depósitos',
  withdrawals: 'retiros',
  expenses: 'egresos',
  operatingIncome: 'ingresos operativos',
  brokerBalance: 'balance del bróker',
  financialStatus: 'estado financiero',
  partnerDistributions: 'distribuciones a socios',
  propFirmSales: 'ventas prop firm',
  p2pTransfers: 'transferencias P2P',
  liquidityMovements: 'movimientos de liquidez',
  investments: 'inversiones',
};

export function TruncatedDataBanner() {
  const { truncatedSlices } = useData();
  if (!truncatedSlices || truncatedSlices.length === 0) return null;

  const names = truncatedSlices.map((s) => SLICE_LABELS[s] ?? s).join(', ');

  return (
    <div
      role="alert"
      className="mx-4 mt-4 sm:mx-6 lg:mx-8 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        <strong className="font-semibold">Datos incompletos.</strong> Se alcanzó el
        máximo de filas que se pueden cargar de una vez en: {names}. Todo lo que se
        calcule a partir de esos datos está <strong>CORTO</strong> —es menor que lo
        real, nunca mayor—. Avisá al equipo técnico antes de usar estos números.
      </span>
    </div>
  );
}
