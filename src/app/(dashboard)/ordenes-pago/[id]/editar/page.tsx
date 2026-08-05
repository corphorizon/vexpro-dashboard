'use client';

// Edición de una orden — reutiliza el mismo formulario del alta. Solo aplica a
// draft/rejected (isEditable): si la orden ya está aprobada, la corrección se
// hace anulando y emitiendo una nueva, así que acá se devuelve al detalle.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, FileText } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { PaymentOrderForm } from '@/components/payment-orders/payment-order-form';
import { useI18n } from '@/lib/i18n';
import { isEditable, type PaymentOrder } from '@/lib/payment-orders/types';
import { getPaymentOrder } from '@/lib/payment-orders/api';

export default function EditarOrdenPagoPage() {
  const { t } = useI18n();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const router = useRouter();

  const [order, setOrder] = useState<PaymentOrder | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    getPaymentOrder(id)
      .then((row) => {
        if (!alive) return;
        // Una orden congelada no se edita: se vuelve al detalle sin dejar
        // rastro en el historial de navegación.
        if (row && !isEditable(row.status)) router.replace(`/ordenes-pago/${id}`);
        else setOrder(row ?? null);
      })
      .catch(() => {
        if (alive) setOrder(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id, router]);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (!order) {
    return (
      <Card>
        <EmptyState
          icon={FileText}
          title={t('payOrders.notFoundTitle')}
          description={t('payOrders.notFoundDesc')}
          action={
            <Link href="/ordenes-pago">
              <Button variant="primary">{t('payOrders.backToList')}</Button>
            </Link>
          }
        />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/ordenes-pago/${order.id}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        {t('payOrders.backToOrder')}
      </Link>

      <PageHeader
        title={t('payOrders.editTitle', { number: order.order_number })}
        subtitle={t('payOrders.editSubtitle')}
        icon={FileText}
      />

      <PaymentOrderForm mode="edit" order={order} />
    </div>
  );
}
