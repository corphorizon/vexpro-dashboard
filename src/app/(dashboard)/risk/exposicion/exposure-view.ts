// ─────────────────────────────────────────────────────────────────────────────
// exposure-view — lo que /risk/exposicion decide sin dibujar, puro para test
// («Libro mayor», 2026-10-12).
//
//   · `marginRows`: la tabla de margen junta las dos listas que arma el server
//     (`critical` < 100 %, `watch` 100–200 %, risk-query.ts) y cada fila
//     recuerda de CUÁL vino. Antes el badge se decidía en la pantalla con
//     `(margin_level ?? 0) < 100`: un nivel null se pintaba «0%» en rojo —
//     «no lo sabemos» leído como «está liquidada» (reglas §1.3). Ahora el
//     color sale de la lista (la que decidió el server con su corte) y el
//     texto de un null es «—».
//   · `shareWidth`: el ancho de la barra de participación (spec §5.3, 64×6)
//     acotado a 0–100; un share no finito no dibuja barra.
//   · `marginLevelText`: «87.35 %» con 2 decimales, como antes — redondear a
//     entero mostraría «100 %» para un 99,6 que está en la lista crítica.
//     null → «—».
//
// DESCARTADO: <DistributionBar> para la concentración por símbolo. Su leyenda
// y sus `title` formatean el valor como DINERO (`formatMoney`), y lo único
// comparable entre familias acá es el CONTEO de posiciones (el flotante mezcla
// centavos con dólares, G3). Una barra que dijera «EURUSD: $412.00» por 412
// posiciones mentiría. Se usa la columna de participación de FinTable.
// ─────────────────────────────────────────────────────────────────────────────

import type { MarginRow } from '@/lib/mt5-sync/risk-query';
import { formatNumber } from '@/lib/utils';

export type MarginList = 'critical' | 'watch';
export type TaggedMarginRow = MarginRow & { list: MarginList };

export function marginRows(critical: MarginRow[] | null | undefined, watch: MarginRow[] | null | undefined): TaggedMarginRow[] {
  return [
    ...(critical ?? []).map((m) => ({ ...m, list: 'critical' as const })),
    ...(watch ?? []).map((m) => ({ ...m, list: 'watch' as const })),
  ];
}

export function shareWidth(share: number | null | undefined): number | null {
  if (typeof share !== 'number' || !Number.isFinite(share)) return null;
  return Math.max(0, Math.min(100, share));
}

export function marginLevelText(level: number | null | undefined): string {
  if (typeof level !== 'number' || !Number.isFinite(level)) return '—';
  return `${formatNumber(level)} %`;
}
