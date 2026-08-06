'use client';

import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

// ─── Concepto de un egreso, con link a su orden de pago ─────────────────────
//
// Kevin (2026-08-06): "en egresos que los OP se vean como link, si les doy clic
// puedo ir a ellas". Un egreso creado al marcar pagada una orden guarda
// `payment_order_id`; acá se usa para linkear al detalle de esa orden.
//
// El concepto que genera `expenseConcept()` es "OP-2026-0001 · Beneficiario":
// se parte con la regex y SOLO el número de OP queda como link, el resto va
// como texto plano. Si alguien renombró el concepto y ya no matchea, se
// muestra igual un ícono chico linkeado — el acceso a la orden nunca se pierde.

const OP_PREFIX = /^(OP-\d{4}-\d+)\s*·\s*(.*)$/;

export function ExpenseConcept({
  concept,
  paymentOrderId,
  suffix,
}: {
  concept: string;
  /** id de la orden que originó el egreso; null/undefined = egreso manual. */
  paymentOrderId?: string | null;
  /** Contenido extra a la derecha (badges, etc.). */
  suffix?: React.ReactNode;
}) {
  const { t } = useI18n();

  if (!paymentOrderId) {
    return (
      <span className="inline-flex items-center gap-1.5">
        {concept}
        {suffix}
      </span>
    );
  }

  const href = `/ordenes-pago/${paymentOrderId}`;
  const match = OP_PREFIX.exec(concept);
  // El click no debe disparar handlers de la fila (edición / drag).
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  if (match) {
    const [, orderNumber, rest] = match;
    return (
      <span className="inline-flex items-center gap-1.5">
        <span>
          <Link
            href={href}
            onClick={stop}
            className="text-info hover:underline font-medium"
            title={t('expenses.viewOrderAria', { order: orderNumber })}
            aria-label={t('expenses.viewOrderAria', { order: orderNumber })}
          >
            {orderNumber}
          </Link>
          {rest ? <span> · {rest}</span> : null}
        </span>
        {suffix}
      </span>
    );
  }

  // Concepto renombrado: el número ya no está, pero el vínculo sigue existiendo.
  return (
    <span className="inline-flex items-center gap-1.5">
      {concept}
      <Link
        href={href}
        onClick={stop}
        className="text-info hover:underline inline-flex items-center"
        title={t('expenses.viewOrder')}
        aria-label={t('expenses.viewOrder')}
      >
        <ExternalLink className="w-3.5 h-3.5" />
      </Link>
      {suffix}
    </span>
  );
}
