'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { moduleDisplayLabel } from '@/lib/modules';
import { getAccessibleNavEntries } from '@/lib/module-groups';
import { Panel } from '@/components/ui/panel';

// ─────────────────────────────────────────────────────────────────────────────
// QuickAccess — atajos de la home, filtrados a lo que el usuario puede ver y
// la empresa tiene prendido.
//
// Desde 2026-10-12 (Fase 4) NO tiene lista propia: son las entradas del
// registro único de navegación con `quickAccess: true` (src/lib/module-groups.ts).
// Antes era una tercera copia de la navegación con rótulos en castellano fijo
// (sin i18n) y un color de paleta cruda distinto por atajo: color sin
// significado, que la spec prohíbe (§2.1). El ícono va en `brand-ink` y el
// rótulo es el mismo que el del menú.
//
// «Libro mayor» (2026-10-12, T3 Home): de N tarjetas sueltas a UN `Panel` con
// una lista de filas (alto `h-row`, 44 px con puntero grueso), en dos columnas
// desde 640 px. Las tarjetas competían con los KPIs como si fueran números;
// una lista de enlaces se lee como lo que es: navegación.
// DESCARTADO: `FinTable` — no hay columnas ni montos; una tabla de un solo
// campo le haría anunciar «tabla, 1 columna» al lector de pantalla.
// ─────────────────────────────────────────────────────────────────────────────

export function QuickAccess({ heading }: { heading?: string }) {
  const { user } = useAuth();
  const { company } = useData();
  const { t } = useI18n();

  const visible = useMemo(
    () =>
      getAccessibleNavEntries(user, company?.active_modules, company?.business_model).filter(
        (e) => e.quickAccess,
      ),
    [user, company?.active_modules, company?.business_model],
  );

  if (visible.length === 0) return null;

  return (
    <Panel title={heading ?? t('home.quickAccess')} flush>
      {/* -mb-px: el borde inferior de la última fila se apoya sobre el del panel. */}
      <ul className="-mb-px grid grid-cols-1 sm:grid-cols-2">
        {visible.map((e) => (
          <li key={e.href} className="border-b border-border sm:odd:border-r">
            <Link
              href={e.href}
              className="flex min-h-row items-center gap-3 px-4 py-1.5 text-[13.5px] font-medium text-foreground hover:bg-row-hover"
            >
              <span className="rounded-ui-sm bg-brand-tint p-1.5 text-brand-ink" aria-hidden="true">
                <e.icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1 truncate">
                {moduleDisplayLabel(e.module, t(e.i18nKey), company)}
              </span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-text-3" strokeWidth={1.75} />
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
