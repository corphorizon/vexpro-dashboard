'use client';

// LNK-04: error boundary del segmento (dashboard). Captura errores de render
// dentro de la app (con providers/layout ya montados, a diferencia de
// global-error.tsx que reemplaza todo el <html>). Reporta a Sentry y ofrece
// reintentar sin recargar toda la página.
//
// «Libro mayor» (2026-10-12): era una tarjeta `rounded-2xl` con el botón
// `bg-[var(--color-primary)] text-white` (blanco fijo: con una marca clara,
// texto blanco sobre fondo claro) y textos fijos en español. Ahora: superficie
// `rounded-ui-lg` + `shadow-1`, ícono `neg` (esto SÍ es un error: el color
// significa), título 22/650, bajada `text-2`, la referencia de Sentry en mono
// 12 `text-3` copiable a mano, un único primario (Reintentar) y una salida
// secundaria al inicio. Bilingüe: el boundary vive DENTRO del layout, así que
// el I18nProvider está montado.
// DESCARTADO: mostrar `error.message` — puede traer datos internos; la
// referencia (`digest`) alcanza para encontrarlo en Sentry.

import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';
import { useEffect } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ActionButton, actionButtonClass } from '@/components/payment-orders/action-button';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useI18n();

  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-10">
      <div className="w-full max-w-[440px] rounded-ui-lg border border-border bg-card p-6 text-center shadow-1 sm:p-8">
        <span
          aria-hidden
          className="mx-auto flex size-10 items-center justify-center rounded-full bg-neg-bg text-neg"
        >
          <AlertTriangle className="size-[18px]" strokeWidth={1.75} />
        </span>
        <h1 className="mt-4 text-[20px] font-[650] leading-7 tracking-[-0.015em] text-foreground sm:text-[22px]">
          {t('lmAdm.error.title')}
        </h1>
        <p className="mt-2 text-[13.5px] leading-5 text-text-2">{t('lmAdm.error.body')}</p>
        {error.digest && (
          <p className="mt-3 text-[12px] text-text-3">
            {t('lmAdm.error.ref')}{' '}
            <span className="select-all font-mono break-all">{error.digest}</span>
          </p>
        )}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <ActionButton variant="primary" onClick={reset}>
            <RotateCcw aria-hidden className="size-[15px]" strokeWidth={1.75} />
            {t('lmAdm.retry')}
          </ActionButton>
          <Link href="/" className={actionButtonClass('secondary')}>
            {t('lmAdm.forbidden.home')}
          </Link>
        </div>
      </div>
    </div>
  );
}
