'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Estado cliente de la bandeja. Vive acá y no dentro de la campanita para que
// cualquier otra pantalla (un resumen, un contador en otro lado) lea la MISMA
// lista y el mismo orden, sin duplicar el fetch ni el criterio de ordenamiento.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import {
  sortNotifications,
  unreadCount,
  type AppNotification,
} from '@/lib/notifications/catalog';

const POLL_MS = 3 * 60 * 1000;

export interface UseNotifications {
  notifications: AppNotification[];
  unread: number;
  loading: boolean;
  error: boolean;
  markRead: (ids: string[]) => Promise<void>;
  markAllRead: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useNotifications(limit?: number): UseNotifications {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Espejo de la lista: marcar leído es optimista y necesita el estado previo
  // para revertir. Leerlo del updater de setState lo ejecutaría dos veces en
  // StrictMode, así que el snapshot sale de acá.
  const rowsRef = useRef<AppNotification[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const applyRows = useCallback((rows: AppNotification[]) => {
    rowsRef.current = rows;
    if (mountedRef.current) setNotifications(rows);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch(
        limit ? `/api/notifications?limit=${limit}` : '/api/notifications',
      );
      const json = await res.json();
      if (!res.ok || !json?.success) throw new Error('notifications fetch failed');
      applyRows(sortNotifications((json.notifications ?? []) as AppNotification[]));
      if (mountedRef.current) setError(false);
    } catch {
      if (mountedRef.current) setError(true);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [limit, applyRows]);

  // Polling que se detiene con la pestaña oculta y refresca al volver: la
  // bandeja abierta en una pestaña de fondo no tiene por qué seguir pegándole
  // al endpoint (mismo patrón que /balances y el home de admin).
  useEffect(() => {
    refresh();
    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (interval) return;
      interval = setInterval(refresh, POLL_MS);
    };
    const stop = () => {
      if (interval) { clearInterval(interval); interval = null; }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        refresh();
        start();
      } else {
        stop();
      }
    };
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refresh]);

  // El orden NO se recalcula al marcar leído: sortNotifications manda las
  // leídas al fondo y el ítem se escaparía de abajo del cursor con el panel
  // abierto. Se reordena recién en el próximo refresh.
  const markRead = useCallback(async (ids: string[]) => {
    const target = new Set(ids.filter(Boolean));
    if (target.size === 0) return;
    const previous = rowsRef.current;
    if (!previous.some((n) => target.has(n.id) && !n.read_at)) return;

    const now = new Date().toISOString();
    applyRows(previous.map((n) => (target.has(n.id) && !n.read_at ? { ...n, read_at: now } : n)));

    try {
      const res = await apiFetch('/api/notifications', {
        method: 'PATCH',
        body: JSON.stringify({ ids: [...target] }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) throw new Error('mark read failed');
    } catch {
      applyRows(previous);
    }
  }, [applyRows]);

  const markAllRead = useCallback(async () => {
    const previous = rowsRef.current;
    if (!previous.some((n) => !n.read_at)) return;

    const now = new Date().toISOString();
    applyRows(previous.map((n) => (n.read_at ? n : { ...n, read_at: now })));

    try {
      const res = await apiFetch('/api/notifications', {
        method: 'PATCH',
        body: JSON.stringify({ all: true }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) throw new Error('mark all read failed');
    } catch {
      applyRows(previous);
    }
  }, [applyRows]);

  return {
    notifications,
    unread: unreadCount(notifications),
    loading,
    error,
    markRead,
    markAllRead,
    refresh,
  };
}
