'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Floating toast container — bottom-right, stacked, auto-dismiss.
//
// Why not a portal or a third-party lib:
//   Toasts live at fixed position bottom-right so they're visible regardless
//   of which section of /upload the user is working on. The old approach
//   rendered a div below the page <h1>; users working on Egresos (bottom of
//   the page) never saw their save confirmation. A fixed-position toast
//   stays glued to the viewport corner.
//
// Usage:
//   const { toast, ToastHost } = useToasts();
//   toast.success('Guardado');
//   toast.error('No se pudo guardar');
//   return <> {ToastHost} …rest of page… </>
//
// One toast can be dismissed before its TTL by clicking it.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useRef, useState } from 'react';
import { Check, X, AlertTriangle } from 'lucide-react';

export type ToastKind = 'success' | 'error' | 'info';
export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

/**
 * Default time-to-live per toast kind.
 * Success: 4s (long enough to read, short enough not to linger).
 * Error: 7s (errors need more reading time).
 * Info: 4s.
 */
const TTL: Record<ToastKind, number> = {
  success: 4000,
  error: 7000,
  info: 4000,
};

export function useToasts() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++;
      setItems((prev) => [...prev, { id, kind, message }]);
      // Auto-dismiss.
      setTimeout(() => dismiss(id), TTL[kind]);
    },
    [dismiss],
  );

  const toast = {
    success: (msg: string) => push('success', msg),
    error: (msg: string) => push('error', msg),
    info: (msg: string) => push('info', msg),
  };

  const ToastHost = <ToastContainer items={items} onDismiss={dismiss} />;

  return { toast, ToastHost };
}

function ToastContainer({
  items,
  onDismiss,
}: {
  items: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-[calc(100vw-2rem)] sm:max-w-sm"
      aria-live="polite"
      aria-atomic="false"
    >
      {items.map((t) => (
        <Toast key={t.id} item={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const base =
    'flex items-start gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium cursor-pointer transition-transform duration-150 animate-in slide-in-from-right-4';
  const byKind: Record<ToastKind, string> = {
    success:
      'bg-emerald-600 text-white border border-emerald-700',
    error:
      'bg-red-600 text-white border border-red-700',
    info:
      'bg-slate-800 text-white border border-slate-700',
  };
  const Icon = item.kind === 'error' ? AlertTriangle : item.kind === 'success' ? Check : null;
  return (
    <div
      className={`${base} ${byKind[item.kind]}`}
      onClick={onDismiss}
      role={item.kind === 'error' ? 'alert' : 'status'}
    >
      {Icon && <Icon className="w-4 h-4 mt-0.5 shrink-0" />}
      <span className="flex-1 leading-snug whitespace-pre-line">{item.message}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        className="shrink-0 opacity-70 hover:opacity-100"
        aria-label="Cerrar"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
