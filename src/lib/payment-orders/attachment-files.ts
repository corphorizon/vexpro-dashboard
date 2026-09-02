// ─────────────────────────────────────────────────────────────────────────────
// Órdenes de Pago — validación de los archivos de RESPALDO (factura, contrato,
// cotización). Hermano de ./proof-files.ts, que hace lo mismo para los
// comprobantes de pago.
//
// POR QUÉ VIVE ACÁ Y NO EN LA ROUTE (migración 127)
// Estaba embebido en /api/admin/payment-orders/[id]/attachment/route.ts, donde
// no se podía testear sin levantar Next ni Supabase. Es el control de seguridad
// del adjunto —lo único que separa un PDF de un ejecutable renombrado—, así que
// merece la misma cobertura que sniffProof().
//
// DIFERENCIA CON LOS COMPROBANTES: acá se aceptan además docx y xlsx, porque el
// respaldo típico de una orden es la factura del proveedor y muchas llegan como
// planilla. Un comprobante bancario nunca es un .xlsx, así que esa puerta no se
// abre del otro lado.
//
// NO importa nada de servidor a propósito: son bytes y strings.
// ─────────────────────────────────────────────────────────────────────────────

/** Tope por archivo. El de CANTIDAD es MAX_PAYMENT_ATTACHMENTS, en types.ts. */
export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_ATTACHMENT_EXTENSIONS = [
  'pdf', 'png', 'jpg', 'jpeg', 'webp', 'docx', 'xlsx',
];

/** `accept` del <input type="file"> — derivado de la allowlist para que la UI
 *  no pueda ofrecer un formato que el servidor rechaza. */
export const ATTACHMENT_ACCEPT = ALLOWED_ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(',');

export interface SniffedAttachment {
  ext: string;
  mime: string;
  /** true = contenedor ZIP de Office: los bytes NO distinguen docx de xlsx. */
  office?: boolean;
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Chequeo de magic bytes. La extensión y el Content-Type son los dos
 * falsificables por el cliente: lo único confiable son los primeros bytes.
 * Mismo criterio que sniffProof() y que sniffContract() en /api/admin/upload-contract.
 */
export function sniffAttachment(bytes: Uint8Array): SniffedAttachment | null {
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
  // DOCX / XLSX: los dos son un ZIP y arrancan con el local file header
  // PK\x03\x04 — por bytes son indistinguibles. Se acepta como "Office
  // genérico" y cuál de los dos es lo resuelve después la extensión declarada,
  // que para entonces ya pasó la allowlist (solo decide nombre y Content-Type,
  // nunca si el archivo entra).
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b &&
    bytes[2] === 0x03 && bytes[3] === 0x04
  ) {
    return { ext: 'docx', mime: DOCX_MIME, office: true };
  }
  return null;
}

/** ¿La extensión del nombre subido está en la lista blanca? Pasada barata
 *  previa al sniff: descarta lo obvio sin leer el archivo entero. */
export function hasAllowedAttachmentExtension(fileName: string): boolean {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  return ALLOWED_ATTACHMENT_EXTENSIONS.includes(ext);
}

/**
 * Con qué extensión y mime se GUARDA el archivo.
 *
 * Para el ZIP de Office los bytes no alcanzan: si el usuario declaró .xlsx se
 * guarda como planilla, en cualquier otro caso queda como documento. La
 * extensión declarada solo decide entre esas dos ramas — nunca si el archivo
 * entra, eso ya lo decidió el sniff.
 */
export function storedAttachmentType(
  sniffed: SniffedAttachment,
  declaredName: string,
): { ext: string; mime: string } {
  const ext = (declaredName.split('.').pop() || '').toLowerCase();
  if (sniffed.office && ext === 'xlsx') return { ext: 'xlsx', mime: XLSX_MIME };
  return { ext: sniffed.ext, mime: sniffed.mime };
}
