'use client';

import Link from 'next/link';
import { AuthBrand } from '@/components/auth-brand';
import { AuthPreferences } from '@/components/auth/auth-shell';
import { AUTH_PRIMARY_BASE_CLASS } from '@/components/auth/auth-controls';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// SystemScreen — pantallas de sistema fuera del dashboard (404) con el lenguaje
// «Libro mayor» (2026-10-12).
//
// POR QUÉ: el 404 era una tarjeta `rounded-2xl` con «404» de 48 px en
// `text-primary dark:text-accent` (color de marca como decoración, y una
// variante `dark:` de color), un botón `bg-[var(--color-primary)] text-white`
// y textos en español fijo. Ahora: logo, código en `text-text-3` tabular
// (el color no significa nada acá), título 22/650, bajada `text-2`, un
// primario de 40 px, e idioma/tema arriba a la derecha como en el login.
//
// Es client porque usa i18n (el idioma vive en localStorage); `not-found.tsx`
// sigue siendo server y sólo la renderiza.
// ─────────────────────────────────────────────────────────────────────────────

export interface SystemScreenProps {
  code?: string;
  title: string;
  body: string;
  action: React.ReactNode;
}

export function SystemScreen({ code, title, body, action }: SystemScreenProps) {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <div className="flex justify-end px-3 pt-3 sm:px-4">
        <AuthPreferences />
      </div>
      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className="flex w-full max-w-[400px] flex-col items-center text-center">
          <AuthBrand className="size-16" />
          {code && (
            <p className="mt-6 text-[13px] font-semibold uppercase tracking-[.06em] text-text-3 tabular-nums">{code}</p>
          )}
          <h1 className={cn('text-[22px] font-[650] leading-7 tracking-[-0.015em] max-sm:text-[20px]', code ? 'mt-1' : 'mt-6')}>
            {title}
          </h1>
          <p className="mt-2 text-[13.5px] leading-5 text-text-2">{body}</p>
          <div className="mt-6">{action}</div>
        </div>
      </main>
    </div>
  );
}

export function NotFoundScreen() {
  const { t } = useI18n();
  return (
    <SystemScreen
      code="404"
      title={t('notFound.title')}
      body={t('notFound.body')}
      action={
        <Link href="/" className={cn(AUTH_PRIMARY_BASE_CLASS, 'min-w-40')}>
          {t('notFound.home')}
        </Link>
      }
    />
  );
}
