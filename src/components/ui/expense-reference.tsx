'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Referencia y comprobante de un egreso (migration-060).
//
// Mismo criterio que en las órdenes de pago:
//   · Si la referencia es un link http/https se muestra clickeable — Kevin a
//     veces pega el hash y a veces la URL del explorador de la transacción.
//   · Se recorta para mostrar: un hash de 64 caracteres o una URL de Tronscan
//     desbordan la celda. El valor completo queda en el `title`.
//   · break-all obligatorio: hashes y URLs no tienen espacios, así que sin
//     esto rompen la tabla aunque estén recortados.
//
// El comprobante se abre con una URL firmada de 10 minutos que emite
// /api/admin/expenses/[id]/attachment — el bucket es privado y puede ser el
// del egreso o el de la orden de pago que lo originó.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { ExternalLink, Paperclip, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';

interface Props {
  expenseId: string;
  reference?: string | null;
  attachmentName?: string | null;
  hasAttachment?: boolean;
  /** Caracteres visibles antes de elidir por el medio. */
  max?: number;
}

function isUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Recorta por el medio: el principio y el final de un hash son lo que se compara. */
function shorten(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function ExpenseReference({
  expenseId,
  reference,
  attachmentName,
  hasAttachment,
  max = 22,
}: Props) {
  const [loading, setLoading] = useState(false);

  const openAttachment = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/admin/expenses/${expenseId}/attachment`);
      const json = await res.json();
      // noopener/noreferrer: la URL firmada no debe filtrarse por el referrer.
      if (json.success && json.url) window.open(json.url, '_blank', 'noopener,noreferrer');
    } catch {
      /* silencioso: el comprobante es un extra, no bloquea la lectura */
    } finally {
      setLoading(false);
    }
  };

  if (!reference && !hasAttachment) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  return (
    <div className="flex flex-col gap-1 min-w-0">
      {reference && (
        isUrl(reference) ? (
          <a
            href={reference}
            target="_blank"
            rel="noopener noreferrer"
            title={reference}
            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline break-all"
          >
            {shorten(reference, max)}
            <ExternalLink className="w-3 h-3 shrink-0" aria-hidden />
          </a>
        ) : (
          <span title={reference} className="text-xs text-muted-foreground break-all font-mono">
            {shorten(reference, max)}
          </span>
        )
      )}

      {hasAttachment && (
        <button
          type="button"
          onClick={openAttachment}
          disabled={loading}
          title={attachmentName ?? 'Ver comprobante'}
          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline disabled:opacity-50 w-fit"
        >
          {loading
            ? <Loader2 className="w-3 h-3 animate-spin shrink-0" aria-hidden />
            : <Paperclip className="w-3 h-3 shrink-0" aria-hidden />}
          Comprobante
        </button>
      )}
    </div>
  );
}
