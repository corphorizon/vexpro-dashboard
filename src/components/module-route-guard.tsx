'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Lock } from 'lucide-react';
import { useAuth, hasModuleAccess } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { moduleLabel } from '@/lib/modules';
import { ALWAYS_ALLOWED, resolveModule } from '@/lib/route-modules';
import { actionButtonClass } from '@/components/ui/action-button';

// ─────────────────────────────────────────────────────────────────────────────
// ModuleRouteGuard
//
// Central gatekeeper that turns inactive / forbidden modules into a visible
// 403 surface at the layout level. Pages that already have their own guard
// can keep it — this component is a safety net for ones that don't.
//
// Mapping here is explicit (not auto-inferred) so we never accidentally lock
// users out of a route when a new page is added without a registered module.
// The table lives in src/lib/route-modules.ts (pure, testable): the nav
// registry test checks it agrees with every menu entry.
//
// «Libro mayor» (2026-10-12): la pantalla 403 era un «403» de 36 px en
// `text-muted-foreground` y una frase fija en español, sin decir QUÉ módulo
// ni ofrecer salida. Ahora: código en `text-3` tabular (el color no significa
// nada acá), título 22/650 con el nombre del módulo (del registro único,
// `moduleLabel`), bajada `text-2` bilingüe y un botón para volver al inicio.
// La lógica de acceso NO cambió (mismo `hasModuleAccess`, mismos argumentos).
//
// `ModuleForbidden` se exporta para que las pantallas con guard propio
// (/logs, /usuarios) pinten EL MISMO 403 en vez de un tercer diseño.
// DESCARTADO: decir si falta el módulo en la empresa o el permiso del usuario
// — `hasModuleAccess` mezcla empresa, usuario y modelo de negocio, y adivinar
// el motivo desde acá sería una segunda copia de esa lógica (reglas §1.1).
// ─────────────────────────────────────────────────────────────────────────────

export function ModuleForbidden({ moduleKey }: { moduleKey?: string | null }) {
  const { t, locale } = useI18n();
  const name = moduleKey ? moduleLabel(moduleKey, locale) : null;
  return (
    <div className="flex min-h-[40vh] items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-[440px] flex-col items-center text-center">
        <span
          aria-hidden
          className="flex size-10 items-center justify-center rounded-full border border-border bg-surface-2 text-text-3"
        >
          <Lock className="size-[18px]" strokeWidth={1.75} />
        </span>
        <p className="mt-4 text-[13px] font-semibold uppercase tracking-[.06em] text-text-3 tabular-nums">403</p>
        <h1 className="mt-1 text-[20px] font-[650] leading-7 tracking-[-0.015em] text-foreground sm:text-[22px]">
          {name ? t('lmAdm.forbidden.titleModule', { module: name }) : t('lmAdm.forbidden.title')}
        </h1>
        <p className="mt-2 text-[13.5px] leading-5 text-text-2">{t('lmAdm.forbidden.body')}</p>
        <Link href="/" className={actionButtonClass('secondary', 'mt-6')}>
          {t('lmAdm.forbidden.home')}
        </Link>
      </div>
    </div>
  );
}

export function ModuleRouteGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user } = useAuth();
  const { company } = useData();

  // Personal routes + home pass through.
  if (ALWAYS_ALLOWED.test(pathname)) return <>{children}</>;

  const moduleKey = resolveModule(pathname);
  if (!moduleKey) return <>{children}</>; // unmapped route — let it render

  // Superadmin bypass is baked into hasModuleAccess. For normal users this
  // enforces both user.allowed_modules AND company.active_modules.
  if (hasModuleAccess(user, moduleKey, company?.active_modules, company?.business_model)) {
    return <>{children}</>;
  }

  return <ModuleForbidden moduleKey={moduleKey} />;
}
