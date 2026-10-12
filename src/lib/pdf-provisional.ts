// ─────────────────────────────────────────────────────────────────────────────
// PDF de un período ABIERTO = PROVISIONAL.
//
// POR QUÉ (Kevin, 2026-10-12): los PDF de Ago-26 y Sep-26 que se mandaron a
// los socios se generaron con el mes abierto (1/9 y 5/10). El Broker P&L del
// CRM se reescribe hasta 7 días después de cada día (daily-pnl-sync.ts:
// ventana completa de 7 días, purgas de Orion), así que el número del PDF y
// el de la pantalla se separaron: Sep +294,60; Ago, un recálculo entero de
// los días 1–26. Un PDF de mes abierto tiene que decir que puede cambiar, en
// el documento mismo — el aviso de la pantalla no viaja con el archivo.
// ─────────────────────────────────────────────────────────────────────────────

export const PROVISIONAL_WATERMARK = 'PROVISIONAL';

export const PROVISIONAL_NOTE =
  'PROVISIONAL — el período sigue abierto. El Broker P&L y la Prop Firm salen del CRM, que recalcula cada día ' +
  'hasta 7 días después; estos números pueden cambiar hasta que el mes se cierre.';

/** `Distribucion_Socios_Sep_26.pdf` → `Distribucion_Socios_Sep_26_PROVISIONAL.pdf`. */
export function provisionalFileName(fileName: string, provisional: boolean): string {
  if (!provisional) return fileName;
  return fileName.replace(/(\.pdf)?$/i, '_PROVISIONAL.pdf');
}

/** Rótulo de un mes en el historial: los abiertos llevan «(provisional)». */
export function provisionalPeriodLabel(label: string, isClosed: boolean | null | undefined): string {
  return isClosed ? label : `${label} (provisional)`;
}
