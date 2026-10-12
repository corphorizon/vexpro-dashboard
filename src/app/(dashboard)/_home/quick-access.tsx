'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { moduleDisplayLabel } from '@/lib/modules';
import { getAccessibleNavEntries } from '@/lib/module-groups';

// ─────────────────────────────────────────────────────────────────────────────
// QuickAccess — grilla de atajos de la home, filtrada a lo que el usuario
// puede ver y la empresa tiene prendido.
//
// Desde 2026-10-12 (Fase 4) NO tiene lista propia: son las entradas del
// registro único de navegación con `quickAccess: true` (src/lib/module-groups.ts).
// Antes era una tercera copia de la navegación con rótulos en castellano fijo
// (sin i18n) y un color de paleta cruda distinto por atajo (`text-blue-600`,
// `text-rose-600`…): color sin significado, que la spec prohíbe (§2.1). Ahora
// el ícono va en `brand-ink` y el rótulo es el mismo que el del menú.
// ─────────────────────────────────────────────────────────────────────────────

export function QuickAccess({ heading = 'Accesos rápidos' }: { heading?: string }) {
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
    <section>
      <h2 className="text-[15px] font-semibold tracking-[-0.005em] mb-3">{heading}</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {visible.map((e) => (
          <Link
            key={e.href}
            href={e.href}
            className="flex items-center gap-3 p-3 rounded-ui-lg border border-border bg-card hover:bg-surface-2 transition-colors motion-reduce:transition-none"
          >
            <span className="p-2 rounded-ui-md bg-brand-tint text-brand-ink" aria-hidden="true">
              <e.icon className="w-4 h-4" />
            </span>
            <span className="text-sm font-medium truncate">
              {moduleDisplayLabel(e.module, t(e.i18nKey), company)}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
