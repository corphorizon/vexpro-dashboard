// ─────────────────────────────────────────────────────────────────────────────
// Órdenes de Pago — validación de los archivos de comprobante.
//
// Vive acá y no dentro de la route para poder testearla sin levantar Next ni
// Supabase: es el control de seguridad del módulo (lo único que separa un PDF
// de un ejecutable renombrado), así que merece cobertura propia.
//
// NO importa nada de servidor a propósito: son bytes y strings.
// ─────────────────────────────────────────────────────────────────────────────

/** Tope por archivo. El de CANTIDAD es MAX_PAYMENT_PROOFS, en types.ts. */
export const MAX_PROOF_SIZE = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_PROOF_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'webp'];

/**
 * Chequeo de magic bytes. La extensión y el Content-Type son los dos
 * falsificables por el cliente: lo único confiable son los primeros bytes.
 * Mismo criterio que sniffContract() en /api/admin/upload-contract.
 *
 * Devuelve la extensión y el mime REALES (los que se usan para guardar), o null
 * si el archivo no es ninguno de los formatos aceptados.
 */
export function sniffProof(bytes: Uint8Array): { ext: string; mime: string } | null {
  // PDF: "%PDF-"
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
    bytes[3] === 0x46 && bytes[4] === 0x2d
  ) {
    return { ext: 'pdf', mime: 'application/pdf' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a &&
    bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { ext: 'png', mime: 'image/png' };
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  // WEBP: contenedor RIFF — "RIFF" en 0-3 y "WEBP" en 8-11 (4-7 es el tamaño).
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

/** ¿La extensión del nombre subido está en la lista blanca? Pasada barata
 *  previa al sniff: descarta lo obvio sin leer el archivo entero. */
export function hasAllowedProofExtension(fileName: string): boolean {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  return ALLOWED_PROOF_EXTENSIONS.includes(ext);
}
