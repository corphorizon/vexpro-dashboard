// ─────────────────────────────────────────────────────────────────────────────
// Órdenes de Pago — ÍNDICE de archivos (nombre, tipo, tamaño, fecha).
//
// POR QUÉ EXISTE (Kevin 2026-09-03: "que el PDF de la orden liste los adjuntos")
// El PDF no mencionaba ningún archivo: una orden con la factura y el
// comprobante adentro se imprimía idéntica a una sin nada. Eso es justo el
// fallo que este repo persigue — un documento plausible que omite en silencio
// lo que respalda el pago. Acá se arma la tabla que el PDF imprime.
//
// PURO A PROPÓSITO: sin jsPDF, sin React, sin Supabase. Las filas se testean
// solas (0, 1 y N archivos) y el generador solo las pinta.
//
// NO se incrusta el contenido ni la URL del archivo: las URLs del bucket son
// firmadas y caducan, así que un PDF con links sería un PDF que miente a los
// dos días. Esto es un índice de QUÉ respalda la orden, no una copia.
//
// La lista de archivos la trae SIEMPRE el mismo lector del servidor
// (loadOrderAttachments / loadOrderProofs vía withFiles): acá no hay consulta.
// ─────────────────────────────────────────────────────────────────────────────

/** Lo mínimo que necesita el índice. Lo cumplen PaymentOrderProof y
 *  PaymentOrderAttachment sin adaptador. */
export interface IndexableFile {
  file_name: string | null;
  mime?: string | null;
  size: number | null;
  uploaded_at: string | null;
}

/** Placeholder de dato ausente — el mismo guion que usa el resto del PDF. */
const DASH = '—';

/**
 * Tamaño legible. Vivía copiado en el detalle y en el formulario; desde la
 * migración 127 hay una sola implementación y el PDF usa ESTA, no una cuarta.
 */
export function formatFileSize(bytes: number | null | undefined): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const MIME_LABELS: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/png': 'PNG',
  'image/jpeg': 'JPG',
  'image/webp': 'WEBP',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
};

/**
 * Tipo mostrable del archivo. Manda el mime guardado (lo puso el sniff de
 * magic bytes del servidor, no el cliente); si falta —filas legadas, que no
 * siempre lo tienen— se cae a la extensión del nombre, y si tampoco hay, al
 * guion. Inventar "PDF" porque sí sería adivinar.
 */
export function fileTypeLabel(file: Pick<IndexableFile, 'file_name' | 'mime'>): string {
  const mime = (file.mime ?? '').trim().toLowerCase();
  if (mime && MIME_LABELS[mime]) return MIME_LABELS[mime];
  const name = file.file_name ?? '';
  const ext = name.includes('.') ? name.split('.').pop()!.trim() : '';
  if (ext && ext.length <= 5) return ext.toUpperCase();
  if (mime) return mime.split('/').pop()!.toUpperCase();
  return DASH;
}

export interface FileIndexOptions {
  /** Nombre a mostrar cuando el archivo no tiene file_name guardado. */
  unnamed: string;
  /** Formateo de fecha del documento (el del PDF, que respeta el locale). */
  formatDate: (value: string | null | undefined) => string;
}

/**
 * Filas de la tabla: [N°, nombre, tipo, tamaño, subido el].
 *
 * Con la lista vacía (o ausente) devuelve `[]` — y el generador NO imprime la
 * sección. No se imprime "0 adjuntos": la ausencia de sección ya dice eso, y
 * un contador en cero invita a leerlo como "se verificó que no hay", que no es
 * lo mismo cuando la lista simplemente no se cargó.
 *
 * `size` en null NO es 0: "no lo sabemos" se muestra como guion, no como 0 B.
 */
export function buildFileIndexRows(
  files: readonly IndexableFile[] | null | undefined,
  opts: FileIndexOptions,
): string[][] {
  if (!files || files.length === 0) return [];
  return files.map((f, i) => [
    String(i + 1),
    (f.file_name ?? '').trim() || opts.unnamed,
    fileTypeLabel(f),
    f.size == null ? DASH : formatFileSize(f.size),
    opts.formatDate(f.uploaded_at),
  ]);
}
