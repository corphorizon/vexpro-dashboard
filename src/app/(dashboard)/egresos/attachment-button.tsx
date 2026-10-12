'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Botón de fila «Ver comprobante» de /egresos.
//
// POR QUÉ (2026-10-12, «Libro mayor»): en la tabla nueva la referencia va
// como metadato bajo el concepto y el comprobante pasa a ser una ACCIÓN de
// fila (aparece al hover, accesible por teclado). Pide la URL firmada al
// mismo endpoint que `ExpenseReference` (ui/expense-reference.tsx) —
// `/api/admin/expenses/{id}/attachment`—: el comprobante sigue saliendo de un
// solo lugar del servidor, con su control de acceso.
//
// A diferencia de ExpenseReference (que falla en silencio), un error se dice:
// un clic que no abre nada es indistinguible de «no hay archivo».
//
// DESCARTADO: tocar ExpenseReference para exportar su `openAttachment` — está
// en src/components/ui/ (fuera de esta tanda) y la usa /upload.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { Loader2, Paperclip } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';
import { ROW_ACTION_CLASS } from '@/components/ui/action-button';

export function AttachmentButton({
  expenseId,
  name,
  onError,
}: {
  expenseId: string;
  name?: string | null;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);

  const open = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/admin/expenses/${expenseId}/attachment`);
      const json = await res.json();
      if (json.success && json.url) window.open(json.url, '_blank', 'noopener,noreferrer');
      else onError(t('expenses.attachmentError'));
    } catch {
      onError(t('expenses.attachmentError'));
    } finally {
      setLoading(false);
    }
  };

  const label = name ? `${t('expenses.viewAttachment')}: ${name}` : t('expenses.viewAttachment');
  return (
    <button
      type="button"
      onClick={open}
      disabled={loading}
      aria-busy={loading || undefined}
      className={ROW_ACTION_CLASS}
      title={label}
      aria-label={label}
    >
      {loading ? (
        <Loader2 aria-hidden className="size-4 animate-spin" strokeWidth={1.75} />
      ) : (
        <Paperclip aria-hidden className="size-4" strokeWidth={1.75} />
      )}
    </button>
  );
}
