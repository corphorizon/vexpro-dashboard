'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from './button';

// ─────────────────────────────────────────────────────────────────────────────
// ConfirmDialog — shared modal used across the finance modules.
//
// Two visual tones:
//   - `default`: primary-colored confirm button (updates, saves).
//   - `danger`:  negative-token confirm button (deletes, irreversible actions).
//
// Also wires up:
//   - ESC key closes the dialog.
//   - Click outside the card closes the dialog.
//   - `aria-modal` + `role="dialog"` for assistive tech.
//   - Focus trap: Tab/Shift+Tab ciclan dentro del diálogo (antes se escapaba
//     al fondo) y al cerrar el foco vuelve al elemento que lo abrió.
//   - Confirm async: si `onConfirm` devuelve una promesa, el botón muestra
//     spinner y el diálogo se cierra recién cuando resuelve (antes cerraba
//     en el acto y la acción seguía corriendo a ciegas).
// ─────────────────────────────────────────────────────────────────────────────

interface ConfirmDialogProps {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

export function ConfirmDialog({
  message,
  title = 'Confirmar acción',
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  tone = 'default',
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);

  // ESC cierra + focus trap. Attached to the document so the user can dismiss
  // even when focus is inside an input within the dialog.
  useEffect(() => {
    // Devolver el foco al elemento que abrió el diálogo cuando se desmonte.
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && cardRef.current) {
        const focusables = cardRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  const handleConfirm = async () => {
    const result = onConfirm();
    if (result instanceof Promise) {
      setBusy(true);
      try {
        await result;
      } finally {
        setBusy(false);
      }
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={busy ? undefined : onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div
        ref={cardRef}
        className="bg-card rounded-xl shadow-[var(--elevation-3)] p-6 max-w-md mx-4 w-full vex-pop-in"
        // Stop propagation so clicks inside the card don't trigger the
        // backdrop's onClose.
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="confirm-dialog-title" className="text-lg font-semibold mb-2">
          {title}
        </h3>
        <p className="text-sm text-muted-foreground mb-6 whitespace-pre-line">
          {message}
        </p>
        <div className="flex gap-3 justify-end">
          <Button onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'destructive' : 'primary'}
            onClick={handleConfirm}
            loading={busy}
            autoFocus
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
