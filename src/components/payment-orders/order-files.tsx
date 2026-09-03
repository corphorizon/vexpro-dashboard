'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Órdenes de Pago — listas de archivos, UNA sola implementación.
//
// POR QUÉ EXISTE (migración 127)
// Una orden tiene ahora DOS listas de archivos con exactamente la misma forma:
// los comprobantes de pago (payment_order_proofs) y los documentos de respaldo
// (payment_order_attachments). Antes de esto había una lista escrita a mano en
// el detalle para los comprobantes y un bloque de "un solo archivo" para el
// respaldo, y al duplicar la segunda habrían quedado TRES implementaciones del
// mismo widget desincronizándose de a poco — el modo de falla número uno de
// este repo (listas duplicadas que divergen en silencio).
//
// Dos componentes, porque son dos estados distintos del mismo archivo:
//   · SavedFileList  → lo que YA está en el servidor: ver, descargar, quitar.
//   · PickedFileList → lo elegido y todavía sin subir: solo sacarlo de la
//                      selección (no hay nada que borrar del bucket).
//
// Los textos entran YA TRADUCIDOS (props), no como claves de i18n: cada lista
// habla de "comprobante" o de "documento de respaldo" y ese matiz es de quien
// la usa, no de este componente. Confundir los dos nombres en pantalla es el
// error que este módulo evita a propósito desde que existen los dos adjuntos.
// ─────────────────────────────────────────────────────────────────────────────

import { Download, ExternalLink, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatFileSize } from '@/lib/payment-orders/file-index';

/** Tamaño legible. Vivía copiado en el detalle y en el formulario; ahora vive
 *  en lib/payment-orders/file-index.ts porque el PDF también lo necesita y
 *  este archivo es 'use client'. Se re-exporta para no tocar a quien ya lo
 *  importaba desde acá — sigue habiendo UNA sola implementación. */
export { formatFileSize };

/** Lo mínimo que necesita la lista. Lo cumplen PaymentOrderProof y
 *  PaymentOrderAttachment sin adaptador. */
export interface SavedFile {
  id: string;
  file_name: string | null;
  size: number | null;
  uploaded_at: string | null;
}

export interface SavedFileTexts {
  /** Nombre a mostrar cuando el archivo no tiene file_name guardado. */
  fallbackName: string;
  /** "Subido el {date}" ya armado por el llamador (formatea la fecha él). */
  uploadedAt: (date: string) => string;
  view: string;
  viewAria: (name: string) => string;
  download: string;
  downloadAria: (name: string) => string;
  remove: string;
  removeAria: (name: string) => string;
}

export function SavedFileList({
  files,
  texts,
  hrefFor,
  downloadHrefFor,
  onRemove,
  disabled = false,
}: {
  files: SavedFile[];
  texts: SavedFileTexts;
  hrefFor: (file: SavedFile) => string;
  downloadHrefFor: (file: SavedFile) => string;
  /** null = archivos de solo lectura (orden anulada): no se dibuja "Quitar". */
  onRemove: ((file: SavedFile) => void) | null;
  disabled?: boolean;
}) {
  if (files.length === 0) return null;
  return (
    <ul className="divide-y divide-border">
      {files.map((f) => {
        const name = f.file_name || texts.fallbackName;
        return (
          <li
            key={f.id}
            className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 py-3 first:pt-0 last:pb-0"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium break-all">{name}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {formatFileSize(f.size)}
                {f.uploaded_at && (
                  <>
                    {' · '}
                    {texts.uploadedAt(f.uploaded_at)}
                  </>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <a
                href={hrefFor(f)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={texts.viewAria(name)}
              >
                <Button type="button" variant="secondary">
                  <ExternalLink className="w-4 h-4" />
                  {texts.view}
                </Button>
              </a>
              {/* La descarga usa su propia URL firmada (el servidor le pone
                  Content-Disposition: attachment): con el redirect
                  cross-origin, un <a download> no alcanza. */}
              <a href={downloadHrefFor(f)} aria-label={texts.downloadAria(name)}>
                <Button type="button" variant="secondary">
                  <Download className="w-4 h-4" />
                  {texts.download}
                </Button>
              </a>
              {onRemove && (
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={texts.removeAria(name)}
                  disabled={disabled}
                  onClick={() => onRemove(f)}
                >
                  <Trash2 className="w-4 h-4" />
                  {texts.remove}
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Archivos elegidos y todavía sin subir. Se muestran con su nombre y tamaño
 * para que el usuario pueda revisar la selección ANTES de mandarla: sin esto,
 * "10 archivos" es un número y no una lista, y elegir el PDF equivocado no se
 * nota hasta que ya está en el bucket.
 */
export function PickedFileList({
  files,
  onRemove,
  removeAria,
  pendingNote,
}: {
  files: File[];
  onRemove: (index: number) => void;
  removeAria: (name: string) => string;
  /** Aclaración opcional por archivo, p. ej. "Se sube al guardar la orden". */
  pendingNote?: string;
}) {
  if (files.length === 0) return null;
  return (
    <ul className="space-y-1">
      {files.map((f, i) => (
        <li
          key={`${f.name}-${f.size}-${i}`}
          className="flex items-center justify-between gap-2 text-xs"
        >
          <span className="min-w-0 truncate">
            {f.name}
            <span className="text-muted-foreground">
              {' · '}
              {formatFileSize(f.size)}
              {pendingNote ? ` · ${pendingNote}` : ''}
            </span>
          </span>
          <button
            type="button"
            className="text-muted-foreground hover:text-negative shrink-0"
            aria-label={removeAria(f.name)}
            onClick={() => onRemove(i)}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}
