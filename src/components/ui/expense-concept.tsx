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
  description,
  suffix,
}: {
  concept: string;
  /** id de la orden que originó el egreso; null/undefined = egreso manual. */
  paymentOrderId?: string | null;
  /** Descripción de las líneas de la orden (payment_order_description):
   *  se muestra como subtítulo tenue para saber qué es el egreso sin abrir
   *  la OP (dueño, 2026-10-05). Solo aplica a egresos con orden. */
  description?: string | null;
  /** Contenido extra a la derecha (badges, etc.). */
  suffix?: React.ReactNode;
}) {
  const { t } = useI18n();

  // Subtítulo con la descripción de la orden, debajo de la línea principal.
  // `break-words` y no `truncate`: la descripción ES el dato que se pidió ver,
  // recortarla en silencio sería esconderlo de nuevo.
  const conDescripcion = (principal: React.ReactNode) =>
    description ? (
      <span className="flex flex-col min-w-0">
        {principal}
        <span className="text-xs text-muted-foreground break-words">{description}</span>
      </span>
    ) : (
      principal
    );

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
    return conDescripcion(
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
      </span>,
    );
  }

  // Concepto renombrado: el número ya no está, pero el vínculo sigue existiendo.
  return conDescripcion(
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
    </span>,
  );
}
