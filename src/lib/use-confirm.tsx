'use client';

import { useCallback, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

// ─────────────────────────────────────────────────────────────────────────────
// useConfirm — stateless-feeling hook for showing a confirmation modal.
//
// Usage:
//   const { confirm, Modal } = useConfirm();
//   ...
//   <button onClick={() => confirm('Eliminar egreso?', () => doDelete(), { tone: 'danger' })}>
//   ...
//   {Modal}
//
// The `Modal` element MUST be rendered once at the top of the JSX tree so the
// dialog actually shows up. Re-rendering it elsewhere works the same way.
// ─────────────────────────────────────────────────────────────────────────────

interface ConfirmOptions {
  /** Visual tone — `danger` paints the confirm button red. */
  tone?: 'default' | 'danger';
  /** Override the modal title. */
  title?: string;
  /** Override the button labels. */
  confirmLabel?: string;
  cancelLabel?: string;
}

interface PendingConfirmation extends ConfirmOptions {
  message: string;
  onConfirm: () => void;
}

export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);

  const confirm = useCallback(
    (message: string, onConfirm: () => void, options: ConfirmOptions = {}) => {
      setPending({ message, onConfirm, ...options });
    },
    [],
  );

  const Modal = pending ? (
    <ConfirmDialog
      message={pending.message}
      title={pending.title}
      confirmLabel={pending.confirmLabel}
      cancelLabel={pending.cancelLabel}
      tone={pending.tone}
      onConfirm={pending.onConfirm}
      onClose={() => setPending(null)}
    />
  ) : null;

  return { confirm, Modal };
}
