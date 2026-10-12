'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { formatDateTime } from '@/lib/dates';
import { notificationType, type AppNotification } from '@/lib/notifications/catalog';
import { useNotifications } from '@/lib/notifications/use-notifications';

interface NotificationBellProps {
  /**
   * Dónde está montada: el sidebar la abre hacia arriba (vive al pie) y la
   * barra móvil hacia abajo.
   */
  variant?: 'sidebar' | 'topbar';
  /** Rail contraído del sidebar: solo entra el icono. */
  collapsed?: boolean;
  className?: string;
}

const SEVERITY_DOT: Record<string, string> = {
  critical: 'bg-neg',
  high: 'bg-pend',
  normal: 'bg-text-3/50',
};

const SEVERITY_BORDER: Record<string, string> = {
  critical: 'border-l-neg',
  high: 'border-l-pend',
  normal: 'border-l-border',
};

export function NotificationBell({
  variant = 'sidebar',
  collapsed = false,
  className,
}: NotificationBellProps) {
  const { t } = useI18n();
  const { notifications, unread, loading, error, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

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

  // El número del badge es aria-hidden: el conteo viaja en el nombre del botón.
  const label = unread > 0
    ? `${t('notif.open')} (${t('notif.unread', { count: String(unread) })})`
    : t('notif.open');
  const badge = unread > 9 ? '9+' : String(unread);

  const renderItem = (n: AppNotification) => {
    // Una fila vieja puede traer un `type` que ya no está en el catálogo:
    // se muestra crudo antes que romper la bandeja entera.
    const def = notificationType(n.type);
    const title = def ? t(`${def.i18nKey}.title`) : n.type;
    const body = def ? t(`${def.i18nKey}.body`, n.params ?? {}) : '';
    const severity = SEVERITY_DOT[n.severity] ? n.severity : 'normal';
    const severityLabel =
      severity === 'critical'
        ? t('notif.severityCritical')
        : severity === 'high'
          ? t('notif.severityHigh')
          : undefined;

    const inner = (
      <span className="flex items-start gap-2">
        <span
          className={cn('mt-1.5 w-2 h-2 rounded-full shrink-0', SEVERITY_DOT[severity])}
          title={severityLabel}
          aria-label={severityLabel}
        />
        <span className="min-w-0 flex-1">
          <span className={cn('block text-sm leading-snug', n.read_at ? 'font-medium' : 'font-semibold')}>
            {title}
          </span>
          {body && (
            <span className="block text-xs text-text-3 mt-0.5 leading-snug">{body}</span>
          )}
          <span className="block text-xs text-text-3/80 mt-1">
            {formatDateTime(n.created_at)}
          </span>
        </span>
      </span>
    );

    const rowClass = cn(
      'w-full text-left block border-l-2 px-3 py-3 min-h-[44px] transition-colors',
      'hover:bg-surface-hover focus-visible:bg-surface-2',
      SEVERITY_BORDER[severity],
      !n.read_at && 'bg-surface-2/40',
    );

    if (n.link) {
      return (
        <Link
          key={n.id}
          href={n.link}
          className={rowClass}
          onClick={() => {
            markRead([n.id]);
            setOpen(false);
          }}
        >
          {inner}
        </Link>
      );
    }

    return (
      <button
        key={n.id}
        type="button"
        className={rowClass}
        onClick={() => markRead([n.id])}
      >
        {inner}
      </button>
    );
  };

  return (
    <div ref={boxRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={cn(
          'relative flex items-center justify-center rounded-ui-md transition-colors motion-reduce:transition-none',
          // Sigue el tema (2026-10-12, Fase 4): la campana vive ahora en la
          // topbar, que es clara u oscura según el tema. Antes era slate fijo
          // porque estaba en el sidebar siempre oscuro.
          'text-text-2 hover:bg-surface-hover hover:text-foreground',
          open && 'bg-surface-2 text-foreground',
          // ≥ 40 px de blanco táctil; en el rail el alto lo fija el sidebar.
          variant === 'topbar'
            ? 'w-10 h-10'
            : collapsed
              ? 'w-9 h-9'
              : 'w-full gap-2 px-3 py-2 min-h-[44px] text-sm font-medium',
        )}
      >
        <Bell aria-hidden="true" className={cn(variant === 'topbar' ? 'w-[18px] h-[18px]' : collapsed ? 'w-5 h-5' : 'w-4 h-4')} />
        {variant === 'sidebar' && !collapsed && <span>{t('notif.title')}</span>}
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute top-0 right-0 min-w-[18px] h-[18px] px-1 rounded-full bg-neg text-background text-[11.5px] font-semibold leading-[18px] text-center tabular-nums"
          >
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={t('notif.title')}
          className={cn(
            'absolute z-50 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-border bg-card text-card-foreground shadow-[var(--elevation-3)] overflow-hidden',
            // < 640: a lo ancho bajo la topbar (su backdrop-filter la vuelve el
            // contenedor de los `fixed`); anclado al botón se salía por la izquierda.
            variant === 'topbar'
              ? 'top-full right-0 mt-2 max-sm:fixed max-sm:inset-x-4 max-sm:top-15 max-sm:mt-0 max-sm:w-auto'
              : 'bottom-full left-0 mb-2',
          )}
        >
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border">
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">{t('notif.title')}</p>
              {unread > 0 && (
                <p className="text-xs text-text-3">
                  {t('notif.unread', { count: String(unread) })}
                </p>
              )}
            </div>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => markAllRead()}
                className="shrink-0 rounded-lg px-2 py-2 min-h-[44px] text-xs font-medium text-text-3 hover:bg-surface-hover hover:text-foreground transition-colors"
              >
                {t('notif.markAllRead')}
              </button>
            )}
          </div>

          <div className="max-h-[60vh] overflow-y-auto custom-scrollbar divide-y divide-border">
            {loading && notifications.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-text-3">
                {t('common.loading')}
              </p>
            )}
            {!loading && error && notifications.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-neg">{t('notif.loadError')}</p>
            )}
            {!loading && !error && notifications.length === 0 && (
              <div className="px-4 py-8 text-center">
                <p className="text-sm font-medium">{t('notif.empty')}</p>
                <p className="text-xs text-text-3 mt-1">{t('notif.emptyHint')}</p>
              </div>
            )}
            {notifications.map(renderItem)}
          </div>
        </div>
      )}
    </div>
  );
}
