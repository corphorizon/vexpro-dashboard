'use client';

import Link from 'next/link';
import { ArrowLeft, FileText } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { PaymentOrderForm } from '@/components/payment-orders/payment-order-form';
import { useI18n } from '@/lib/i18n';

export default function NuevaOrdenPagoPage() {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <Link
        href="/ordenes-pago"
        className="inline-flex items-center gap-1.5 text-[13px] text-text-2 hover:text-foreground"
      >
        <ArrowLeft aria-hidden className="size-4" />
        {t('payOrders.backToList')}
      </Link>

      <PageHeader title={t('payOrders.newTitle')} subtitle={t('payOrders.newSubtitle')} icon={FileText} />

      <PaymentOrderForm mode="create" />
    </div>
  );
}
