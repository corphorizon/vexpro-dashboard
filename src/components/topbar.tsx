'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ChevronLeft, ChevronRight, Lock, Menu, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dates';
import { useI18n } from '@/lib/i18n';
import { useTheme } from '@/lib/theme-context';
import { useData } from '@/lib/data-context';
import { usePeriod } from '@/lib/period-context';
import { moduleDisplayLabel } from '@/lib/modules';
import { findNavEntry, navGroup } from '@/lib/module-groups';
import { FRESHNESS_STALE_MS, relativeAgo, useDataFreshness } from '@/lib/data-freshness';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { PeriodSelector } from '@/components/period-selector';

// ─────────────────────────────────────────────────────────────────────────────
// Topbar «Libro mayor» (docs/diseno-libro-mayor.md §6.2, Fase 4 2026-10-12).
//
// Una sola barra para escritorio y móvil (antes había una `MobileTopBar` fija
// siempre oscura y en escritorio no había barra: la campana vivía al pie del
// sidebar). 52 px, sticky, `bg` al 88 % + blur.
//
//   izquierda: [menú < 960] migas «Grupo / Pantalla» (< 640 sólo la pantalla)
//   derecha:   frescura · período · notificaciones · tema
//
// · Migas: salen del registro único de navegación (`findNavEntry`), no de un
//   mapa propio.
// · Frescura: SÓLO si la pantalla reportó una marca real
//   (`useReportDataFreshness`, src/lib/data-freshness.tsx). Sin marca no se
//   dibuja nada — nunca un reloj inventado.
// · Período: el MISMO estado de `PeriodContext` que usa `<PeriodSelector/>`.
//   ‹ › mueven al mes anterior/siguiente; el rótulo abre el `<PeriodSelector/>`
//   existente (año, meses, consolidado) en un popover. No hay un segundo
//   estado. Se muestra sólo en las pantallas que leen el período global
//   (`usesPeriod` en el registro): en Usuarios o Risk un selector de mes sería
//   un control que no cambia nada.
//
// Acento de marca (2026-10-12, spec §10, «más color»): una línea de 2 px al
// pie de la barra que va de la tinta de marca al acento y se desvanece, y el
// grupo de las migas en `brand-ink`. Es estructura, no dato: el punto de
// frescura sigue en pos/stale y el período en `foreground`, legibles igual.
// Descartado: teñir todo el fondo de la barra — con el sidebar ya oscuro de
// marca, dos bloques de color compiten y el período pierde contraste visual.
//
// Pendiente (fase 5): esas pantallas todavía tienen su `<PeriodSelector/>`
// dentro del contenido. Comparten estado con la topbar (no se desincronizan),
// pero la spec pide uno solo; sacarlo es tocar cada pantalla.
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS: Record<'es' | 'en', string[]> = {
  es: ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

function Freshness() {
  const { t } = useI18n();
  const iso = useDataFreshness();
  const [now, setNow] = useState(() => Date.now());

  // Reloj de la frase: avanza cada 30 s (la topbar vive entre navegaciones,
  // así que el `now` inicial puede tener minutos; el error queda acotado a 30 s).
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (!iso) return null;
  const stale = now - Date.parse(iso) > FRESHNESS_STALE_MS;
  const text = t('shell.updated', { when: relativeAgo(iso, now, t) });
  const exact = formatDateTime(iso);

  return (
    <p
      className="flex items-center gap-2 text-[12.5px] text-text-2"
      title={stale ? `${t('shell.staleHint')} · ${exact}` : exact}
    >
      <span
        aria-hidden="true"
        className={cn(
          'h-[7px] w-[7px] shrink-0 rounded-full ring-[3px]',
          stale ? 'bg-stale ring-stale-bg' : 'bg-pos ring-pos-bg',
        )}
      />
      {/* < 640 sólo el punto; el texto sigue para lectores de pantalla. */}
      <span className="max-sm:sr-only whitespace-nowrap">{text}</span>
    </p>
  );
}

function PeriodStepper() {
  const { t, locale } = useI18n();
  const { periods } = useData();
  const { mode, selectedPeriodId, consolidationLabel, setSelectedPeriod } = usePeriod();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const ordered = useMemo(
    () => [...periods].sort((a, b) => a.year - b.year || a.month - b.month),
    [periods],
  );
  const index = ordered.findIndex((p) => p.id === selectedPeriodId);
  const current = index >= 0 ? ordered[index] : null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (ordered.length === 0) return null;

  const label =
    mode === 'consolidated' && consolidationLabel
      ? consolidationLabel
      : current
        ? `${MONTHS[locale][current.month - 1] ?? current.month} ${current.year}`
        : t('shell.choosePeriod');

  const prev = index > 0 ? ordered[index - 1] : null;
  const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null;

  const arrow = cn(
    'flex h-full w-8 items-center justify-center text-text-2 transition-colors motion-reduce:transition-none',
    'hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-40 pointer-coarse:w-10',
  );

  return (
    <div ref={boxRef} className="relative">
      <div className="flex h-8 items-stretch overflow-hidden rounded-ui-md border border-border-strong bg-card pointer-coarse:h-10">
        <button
          type="button"
          onClick={() => prev && setSelectedPeriod(prev.id)}
          disabled={!prev}
          aria-label={t('shell.prevPeriod')}
          title={t('shell.prevPeriod')}
          className={arrow}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          title={t('shell.choosePeriod')}
          className="flex max-w-44 items-center gap-1.5 border-x border-border px-2.5 text-[13px] font-semibold tabular-nums transition-colors hover:bg-surface-2 motion-reduce:transition-none"
        >
          <span className="truncate">{label}</span>
          {mode === 'single' && current?.is_closed && (
            <Lock className="h-3.5 w-3.5 shrink-0 text-text-3" aria-label={t('periods.closed')} />
          )}
        </button>
        <button
          type="button"
          onClick={() => next && setSelectedPeriod(next.id)}
          disabled={!next}
          aria-label={t('shell.nextPeriod')}
          title={t('shell.nextPeriod')}
          className={arrow}
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={t('shell.choosePeriod')}
          className="absolute right-0 top-full z-50 mt-2 w-[min(40rem,calc(100vw-2rem))] rounded-ui-lg border border-border bg-card p-3 shadow-2 max-sm:fixed max-sm:inset-x-4 max-sm:top-15 max-sm:mt-0 max-sm:w-auto"
        >
          {/* El selector de siempre, con su mismo estado (PeriodContext).
              En < 640 el panel es `fixed` a lo ancho: el `backdrop-filter`
              del <header> lo vuelve contenedor de los `fixed`, así que
              inset-x-4 / top-15 se miden contra la barra, no contra la página. */}
          <PeriodSelector />
        </div>
      )}
    </div>
  );
}

interface TopbarProps {
  onMenuToggle: () => void;
  menuOpen: boolean;
  /** id del sidebar, para `aria-controls`. */
  sidebarId: string;
}

export function Topbar({ onMenuToggle, menuOpen, sidebarId }: TopbarProps) {
  const pathname = usePathname();
  const { t } = useI18n();
  const { company } = useData();
  const { resolvedTheme, setTheme } = useTheme();

  const entry = findNavEntry(pathname);
  const group = navGroup(entry?.group ?? null);
  const pageLabel = entry
    ? moduleDisplayLabel(entry.module, t(entry.i18nKey), company)
    : pathname.startsWith('/perfil')
      ? t('nav.profile')
      : null;
  const themeLabel = resolvedTheme === 'dark' ? t('shell.themeToLight') : t('shell.themeToDark');

  const iconButton = cn(
    'flex h-10 w-10 shrink-0 items-center justify-center rounded-ui-md text-text-2 transition-colors motion-reduce:transition-none',
    'hover:bg-surface-2 hover:text-foreground',
  );

  return (
    <header className="relative flex h-13 items-center gap-3 border-b border-border bg-background/88 px-6 backdrop-blur-[8px] max-[959.98px]:px-4">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 bg-[linear-gradient(90deg,var(--brand-ink),var(--accent)_45%,transparent)]"
      />
      <button
        type="button"
        onClick={onMenuToggle}
        aria-label={menuOpen ? t('shell.closeMenu') : t('shell.openMenu')}
        aria-expanded={menuOpen}
        aria-controls={sidebarId}
        className={cn(iconButton, '-ml-2 min-[960px]:hidden')}
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>

      {pageLabel && (
        <nav aria-label={t('shell.breadcrumb')} className="min-w-0">
          <ol className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
            {group && (
              <li className="flex items-center gap-1.5 text-text-3 max-sm:hidden">
                <span className="whitespace-nowrap font-medium text-brand-ink">{t(group.i18nKey)}</span>
                <span aria-hidden="true">/</span>
              </li>
            )}
            <li className="min-w-0">
              <span aria-current="page" className="block truncate font-semibold text-foreground">
                {pageLabel}
              </span>
            </li>
          </ol>
        </nav>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-3">
        <Freshness />
        {entry?.usesPeriod && <PeriodStepper />}
        <div className="flex items-center">
          <NotificationBell variant="topbar" />
          <button
            type="button"
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
            aria-label={themeLabel}
            title={themeLabel}
            className={iconButton}
          >
            {resolvedTheme === 'dark'
              ? <Sun className="h-[18px] w-[18px]" aria-hidden="true" />
              : <Moon className="h-[18px] w-[18px]" aria-hidden="true" />}
          </button>
        </div>
      </div>
    </header>
  );
}
