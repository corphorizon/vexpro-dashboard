'use client';

import { StatusBadge as LedgerStatusBadge } from '@/components/ui/status-badge';
import { STATUS_LABELS, type PaymentOrderStatus } from '@/lib/payment-orders/types';
import { useI18n } from '@/lib/i18n';

// ─────────────────────────────────────────────────────────────────────────────
// StatusBadge de una orden de pago — sólo la ETIQUETA; el color no se decide acá.
//
// POR QUÉ (2026-10-12, migración «Libro mayor» de Órdenes de pago): este
// archivo tenía su propio mapa `VARIANT` estado → variante del Badge legado, y
// `components/ui/status-kind.ts` nació con OTRO mapa para el mismo dominio
// («paymentOrder»). Dos listas del mismo dato son el modo de falla número uno
// del repo (reglas-del-proyecto.md §1.1): el día que alguien recolorea
// «anulada» en una, la otra sigue igual y el listado y el detalle se
// contradicen sin que nada falle. Ya divergían en intención: la spec pide
// anulada = bad y `VARIANT` decía neutral.
//
// Ahora: el color sale de `statusKind('paymentOrder', status)` (registro
// único) vía la primitiva de ui, y el texto de STATUS_LABELS (registro único
// de etiquetas, compartido con el PDF). `status-badge.test.ts` falla si vuelve
// a aparecer un mapa de colores en este archivo.
//
// DESCARTADO: borrar este wrapper y escribir `<StatusBadge domain=…
// label={STATUS_LABELS[locale][s]}>` en cada pantalla — cuatro copias del
// mismo par dominio+etiqueta; el wrapper deja el par en un solo lugar.
// ─────────────────────────────────────────────────────────────────────────────

export function StatusBadge({ status, className }: { status: PaymentOrderStatus; className?: string }) {
  const { locale } = useI18n();
  return (
    <LedgerStatusBadge
      domain="paymentOrder"
      status={status}
      label={STATUS_LABELS[locale][status] ?? status}
      className={className}
    />
  );
}

/** Etiqueta de estado sin badge (para tooltips, títulos de diálogo, …). */
export function useStatusLabel() {
  const { locale } = useI18n();
  return (status: PaymentOrderStatus) => STATUS_LABELS[locale][status] ?? status;
}
