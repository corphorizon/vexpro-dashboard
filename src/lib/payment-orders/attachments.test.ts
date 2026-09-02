// Documentos de respaldo de una orden de pago (migración 127).
//
// Lo que se cubre acá es lo que YA falló una vez del otro lado (comprobantes) o
// lo que fallaría en silencio si no se mira:
//   · el tope: 10 exacto entra, 11 no, y el mensaje DICE cuántos entran;
//   · el sniff: la extensión y el Content-Type los pone el cliente, los magic
//     bytes no;
//   · el par docx/xlsx, que por bytes es indistinguible y se resuelve con la
//     extensión declarada — la única decisión del módulo que depende del
//     cliente, y por eso la que hay que fijar con un test;
//   · el fallback legado, que es la diferencia entre "esta orden no tiene
//     factura" (falso) y verla.

import { describe, it, expect } from 'vitest';
import {
  LEGACY_ATTACHMENT_ID,
  MAX_PAYMENT_ATTACHMENTS,
  attachmentCountError,
} from './types';
import {
  ALLOWED_ATTACHMENT_EXTENSIONS,
  ATTACHMENT_ACCEPT,
  hasAllowedAttachmentExtension,
  sniffAttachment,
  storedAttachmentType,
} from './attachment-files';

describe('MAX_PAYMENT_ATTACHMENTS', () => {
  it('es el tope que pidió Kevin: hasta 10 archivos', () => {
    expect(MAX_PAYMENT_ATTACHMENTS).toBe(10);
  });
});

describe('attachmentCountError', () => {
  it('acepta el primer respaldo de una orden vacía', () => {
    expect(attachmentCountError(0, 1)).toBeNull();
  });

  it('el tope exacto entra y uno más no', () => {
    expect(attachmentCountError(0, MAX_PAYMENT_ATTACHMENTS)).toBeNull();
    expect(attachmentCountError(0, MAX_PAYMENT_ATTACHMENTS + 1)).not.toBeNull();
    expect(attachmentCountError(MAX_PAYMENT_ATTACHMENTS - 1, 1)).toBeNull();
    expect(attachmentCountError(MAX_PAYMENT_ATTACHMENTS - 1, 2)).not.toBeNull();
  });

  it('el rechazo dice cuántos entran todavía — nunca solo "no se puede"', () => {
    const err = attachmentCountError(MAX_PAYMENT_ATTACHMENTS - 2, 3);
    expect(err).toMatch(/2 más/);
    expect(err).toMatch(String(MAX_PAYMENT_ATTACHMENTS));
  });

  it('con la orden llena avisa que hay que quitar alguno', () => {
    const err = attachmentCountError(MAX_PAYMENT_ATTACHMENTS, 1);
    expect(err).toMatch(/máximo/);
    expect(err).toMatch(/Quitá/);
  });

  it('sin archivos no es "entra": es un request vacío', () => {
    expect(attachmentCountError(0, 0)).toMatch(/No se recibió/);
    expect(attachmentCountError(3, 0)).toMatch(/No se recibió/);
  });

  it('habla de documentos de respaldo, no de comprobantes', () => {
    // Los dos adjuntos de una orden se confunden con una facilidad peligrosa:
    // el mensaje tiene que nombrar el correcto.
    const err = attachmentCountError(1, MAX_PAYMENT_ATTACHMENTS);
    expect(err).toMatch(/1 documento de respaldo:/);
    expect(err).not.toMatch(/comprobante/);
    expect(attachmentCountError(2, MAX_PAYMENT_ATTACHMENTS)).toMatch(/2 documentos de respaldo:/);
  });
});

// ── Validación del archivo ──────────────────────────────────────────────────

const bytes = (...b: number[]) => new Uint8Array(b);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00);
const JPG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00);
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00);

describe('sniffAttachment', () => {
  it('reconoce los formatos por sus magic bytes', () => {
    expect(sniffAttachment(PDF)).toEqual({ ext: 'pdf', mime: 'application/pdf' });
    expect(sniffAttachment(PNG)).toEqual({ ext: 'png', mime: 'image/png' });
    expect(sniffAttachment(JPG)).toEqual({ ext: 'jpg', mime: 'image/jpeg' });
    expect(sniffAttachment(WEBP)).toEqual({ ext: 'webp', mime: 'image/webp' });
  });

  it('acepta el contenedor ZIP de Office y lo marca como ambiguo', () => {
    const office = sniffAttachment(ZIP);
    expect(office?.office).toBe(true);
    expect(office?.ext).toBe('docx');
  });

  it('rechaza un ejecutable aunque el nombre diga .pdf', () => {
    // "MZ" — cabecera de un .exe de Windows.
    expect(sniffAttachment(bytes(0x4d, 0x5a, 0x90, 0x00))).toBeNull();
  });

  it('rechaza un RIFF que no es WEBP (un .wav, por ejemplo)', () => {
    const wav = bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45);
    expect(sniffAttachment(wav)).toBeNull();
  });

  it('no explota con archivos truncados', () => {
    expect(sniffAttachment(bytes())).toBeNull();
    expect(sniffAttachment(bytes(0x25, 0x50))).toBeNull();
    expect(sniffAttachment(bytes(0x50, 0x4b, 0x03))).toBeNull();
    expect(sniffAttachment(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0))).toBeNull();
  });
});

describe('storedAttachmentType', () => {
  const office = { ext: 'docx', mime: 'x', office: true } as const;

  it('un ZIP declarado .xlsx se guarda como planilla', () => {
    expect(storedAttachmentType(office, 'balance.xlsx').ext).toBe('xlsx');
    expect(storedAttachmentType(office, 'balance.XLSX').ext).toBe('xlsx');
  });

  it('cualquier otro ZIP de Office queda como documento', () => {
    expect(storedAttachmentType(office, 'contrato.docx').ext).toBe('docx');
  });

  it('la extensión declarada NO puede cambiar un formato no ambiguo', () => {
    // Un PDF renombrado .xlsx sigue guardándose como PDF: los bytes mandan.
    const pdf = { ext: 'pdf', mime: 'application/pdf' };
    expect(storedAttachmentType(pdf, 'factura.xlsx')).toEqual(pdf);
  });
});

describe('hasAllowedAttachmentExtension', () => {
  it('acepta la lista blanca sin importar mayúsculas', () => {
    for (const name of ['a.pdf', 'a.PNG', 'foto.JPG', 'x.jpeg', 'y.webp', 'c.DOCX', 'b.xlsx']) {
      expect(hasAllowedAttachmentExtension(name)).toBe(true);
    }
  });

  it('rechaza lo demás, incluido un archivo sin extensión', () => {
    for (const name of ['a.exe', 'a.zip', 'factura', 'a.pdf.exe']) {
      expect(hasAllowedAttachmentExtension(name)).toBe(false);
    }
  });

  it('el `accept` del input sale de la MISMA lista que valida el servidor', () => {
    // Si divergen, la UI ofrece un formato que el endpoint rechaza — el usuario
    // elige el archivo, espera la subida y recibe un error inexplicable.
    for (const ext of ALLOWED_ATTACHMENT_EXTENSIONS) {
      expect(ATTACHMENT_ACCEPT).toContain(`.${ext}`);
    }
  });
});

// ── Fallback legado (migración 127) ─────────────────────────────────────────
// Réplica de la regla que aplican loadOrderAttachments() en server.ts y el
// formulario: si hay filas, mandan; si no, el archivo de las cinco columnas
// viejas se muestra como un adjunto más con id sintético. Se testea la REGLA,
// no la consulta (eso necesitaría Supabase).

interface LegacyOrder {
  attachment_path: string | null;
  attachment_name: string | null;
  attachment_size: number | null;
}

function visibleAttachments(
  rows: { id: string; file_name: string | null; size: number | null }[],
  order: LegacyOrder,
) {
  if (rows.length > 0) return rows;
  return order.attachment_path
    ? [{ id: LEGACY_ATTACHMENT_ID, file_name: order.attachment_name, size: order.attachment_size }]
    : [];
}

describe('fallback legado', () => {
  const legacyOrder: LegacyOrder = {
    attachment_path: 'empresa/orden-1.pdf',
    attachment_name: 'factura.pdf',
    attachment_size: 1234,
  };

  it('una orden sin backfill NO aparece sin respaldo', () => {
    const list = visibleAttachments([], legacyOrder);
    expect(list).toHaveLength(1);
    expect(list[0].file_name).toBe('factura.pdf');
    expect(list[0].id).toBe(LEGACY_ATTACHMENT_ID);
  });

  it('con filas en la tabla, las filas mandan y el legado no se suma', () => {
    const rows = [{ id: 'uuid-1', file_name: 'factura.pdf', size: 1234 }];
    expect(visibleAttachments(rows, legacyOrder)).toEqual(rows);
  });

  it('sin filas y sin columna vieja, la lista está vacía de verdad', () => {
    expect(
      visibleAttachments([], { attachment_path: null, attachment_name: null, attachment_size: null }),
    ).toEqual([]);
  });

  it('el id sintético nunca puede confundirse con un uuid real', () => {
    expect(LEGACY_ATTACHMENT_ID).not.toMatch(/^[0-9a-f]{8}-/i);
  });
});
