'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Adjuntar / quitar el comprobante de un egreso.
//
// El archivo se sube APENAS se elige, antes de guardar el período: el endpoint
// devuelve la metadata y esta se guarda en la fila. El path que devuelve es
// estable y no depende del id del egreso — importante, porque
// replace_period_expenses regenera los ids en cada guardado del mes.
//
// Consecuencia asumida: si alguien sube un archivo y después descarta los
// cambios sin guardar, el archivo queda en el bucket sin fila que lo apunte.
// Es preferible a la alternativa (subir al guardar) porque el usuario ve el
// resultado en el momento y un fallo de subida no arruina el guardado del mes.
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useState } from 'react';
import { Paperclip, X, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';

export interface ExpenseAttachment {
  bucket: string;
  path: string;
  name: string;
  mime: string;
  size: number;
  uploaded_at: string;
}

interface Props {
  value: ExpenseAttachment | null;
  onChange: (next: ExpenseAttachment | null) => void;
  /** Heredado de una orden de pago: se muestra pero no se puede reemplazar. */
  readOnly?: boolean;
  className?: string;
}

// El servidor decide por magic bytes; esto es solo el filtro del diálogo del
// SO. XLSX/DOCX se agregaron el 2026-09-01 (Excel como comprobante de egresos).
const ACCEPT = [
  '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.xlsx', '.docx',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
].join(',');

export function ExpenseAttachmentInput({ value, onChange, readOnly, className }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      // Sin Content-Type a mano: el browser tiene que poner el boundary del
      // multipart, y fijarlo rompe el parseo del lado del servidor.
      const res = await apiFetch('/api/admin/expenses/attachment', { method: 'POST', body: fd });
      const json = await res.json();
      if (json.success && json.attachment) onChange(json.attachment);
      else setError(json.error ?? 'No se pudo subir el comprobante');
    } catch {
      setError('No se pudo subir el comprobante');
    } finally {
      setBusy(false);
      // Permite volver a elegir el MISMO archivo después de un error.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async () => {
    if (!value) return;
    const previous = value;
    // Se saca de la fila primero: si el borrado del archivo falla, lo que le
    // importa al usuario (que el egreso quede sin comprobante) igual se cumple.
    onChange(null);
    try {
      await apiFetch('/api/admin/expenses/attachment', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: previous.path }),
      });
    } catch {
      /* huérfano en el bucket, sin impacto para el usuario */
    }
  };

  if (value) {
    return (
      <div className={className}>
        <div className="flex items-center gap-1 min-w-0">
          <Paperclip className="w-3 h-3 shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-xs truncate" title={value.name}>{value.name}</span>
          {!readOnly && (
            <button
              type="button"
              onClick={remove}
              aria-label={`Quitar ${value.name}`}
              className="p-0.5 rounded text-muted-foreground hover:text-negative shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    );
  }

  if (readOnly) return <span className="text-xs text-muted-foreground">—</span>;

  return (
    <div className={className}>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline disabled:opacity-50"
      >
        {busy
          ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden />
          : <Paperclip className="w-3 h-3" aria-hidden />}
        {busy ? 'Subiendo…' : 'Adjuntar'}
      </button>
      {error && <p className="text-[11px] text-negative mt-0.5">{error}</p>}
    </div>
  );
}
