'use client';

import { useEffect } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// ConfirmDialog — shared modal used across the finance modules.
//
// Two visual tones:
//   - `default`: primary-colored confirm button (updates, saves).
//   - `danger`:  red confirm button (deletes, irreversible actions).
//
// Also wires up:
//   - ESC key closes the dialog.
//   - Click outside the card closes the dialog.
//   - `aria-modal` + `role="dialog"` for assistive tech.
// ─────────────────────────────────────────────────────────────────────────────

interface ConfirmDialogProps {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  onConfirm: () => void;
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
  // Close on ESC — attached to the document so the user can dismiss even
  // when focus is inside an input within the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const confirmClasses =
    tone === 'danger'
      ? 'bg-red-600 hover:bg-red-700 text-white'
      : 'bg-[var(--color-primary)] hover:opacity-90 text-white';

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div
        className="bg-card rounded-xl shadow-xl p-6 max-w-md mx-4 w-full"
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
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-opacity ${confirmClasses}`}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
