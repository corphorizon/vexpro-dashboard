'use client';

import { Badge } from '@/components/ui/badge';
import { STATUS_LABELS, type PaymentOrderStatus } from '@/lib/payment-orders/types';
import { useI18n } from '@/lib/i18n';

// ─────────────────────────────────────────────────────────────────────────────
// StatusBadge — un solo mapeo estado → variante para toda la tesorería.
//
// Badge solo tiene 4 variantes semánticas, y los 6 estados se colapsan así:
//   draft / cancelled → neutral  (sin valor económico: uno todavía no vale,
//                                 el otro ya dejó de valer)
//   pending           → warning  (bloquea a alguien: pide una decisión)
//   approved / paid   → success  (la orden ya autoriza la salida de fondos —
//                                 isAuthorized() en types.ts)
//   rejected          → danger
// La etiqueta (STATUS_LABELS) es la que desambigua aprobada vs. pagada.
// ─────────────────────────────────────────────────────────────────────────────

const VARIANT: Record<PaymentOrderStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  draft: 'neutral',
  pending: 'warning',
  approved: 'success',
  paid: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
};

export function StatusBadge({ status, className }: { status: PaymentOrderStatus; className?: string }) {
  const { locale } = useI18n();
  return (
    <Badge variant={VARIANT[status]} className={className}>
      {STATUS_LABELS[locale][status]}
    </Badge>
  );
}

/** Etiqueta de estado sin badge (para tooltips, títulos de diálogo, …). */
export function useStatusLabel() {
  const { locale } = useI18n();
  return (status: PaymentOrderStatus) => STATUS_LABELS[locale][status];
}
