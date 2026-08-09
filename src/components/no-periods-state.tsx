'use client';

// ─────────────────────────────────────────────────────────────────────────────
// "Todavía no hay períodos" — el estado que faltaba.
//
// Cinco pantallas (resumen, egresos, movimientos, balances y el inicio)
// mostraban un esqueleto de carga cuando `getPeriodSummary` devolvía null. En
// una empresa con datos eso dura un instante; en una recién creada, que no
// tiene NINGÚN período, dura para siempre: la pantalla queda "cargando" sin
// que nada esté cargando. Kevin lo vio al estrenar Exura Prime.
//
// La diferencia entre "esperá" y "no hay nada todavía" no es cosmética: la
// primera no ofrece salida y la segunda dice exactamente qué hacer.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { CalendarPlus } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

export function NoPeriodsState() {
  const { t } = useI18n();
  return (
    <EmptyState
      icon={CalendarPlus}
      title={t('noPeriods.title')}
      description={t('noPeriods.description')}
      action={
        <Link href="/periodos">
          <Button variant="primary">
            <CalendarPlus className="w-4 h-4" />
            {t('noPeriods.action')}
          </Button>
        </Link>
      }
    />
  );
}
