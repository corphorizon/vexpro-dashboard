// ---------------------------------------------------------------------------
// POST   /api/admin/expenses/attachment  → sube un comprobante y devuelve su
//                                          metadata + una URL firmada corta.
// DELETE /api/admin/expenses/attachment  → borra un archivo ya subido.
//
// POR QUÉ EL ARCHIVO NO SE ATA AL ID DEL EGRESO
// `replace_period_expenses` BORRA e INSERTA el período entero en cada guardado,
// así que el id de un egreso cambia cada vez que se guarda el mes. Un archivo
// guardado bajo `.../{expenseId}/...` quedaría huérfano al primer guardado.
// Por eso el path se arma con un uuid propio al momento de subir:
//     {companyId}/{uuid}.{ext}
// Ese path viaja en el payload del egreso (columna attachment_path) y sobrevive
// a las reinserciones. Es la misma trampa que ya rompió el vínculo con las
// órdenes de pago; acá se evita por diseño.
//
// La subida ocurre ANTES de guardar la fila — en ese momento el egreso todavía
// no existe en la DB. Por eso este endpoint no recibe ningún id y solo valida
// sesión + empresa: el archivo se asocia recién cuando se guarda el período.
//
// SEGURIDAD: bucket PRIVADO, en la DB vive el PATH (nunca una URL pública) y el
// tipo se decide por MAGIC BYTES — la extensión y el Content-Type los controla
// el cliente y son falsificables. Mismo criterio que los comprobantes de
// órdenes de pago y los contratos de RRHH.
//
// 2026-09-01 — EXCEL COMO COMPROBANTE. Pedido del dueño: adjuntar el detalle de
// gastos del mes (una planilla) como respaldo de un egreso operativo. Hasta hoy
// el sniff rechazaba XLSX con "Formato no admitido". El criterio NO se inventó
// acá: se copió tal cual el de sniffAttachment() en
// /api/admin/payment-orders/[id]/attachment, que ya aceptaba el contenedor ZIP
// de Office desde antes. Se descartó escribir una regla propia justamente para
// no terminar con dos criterios de adjuntos que después divergen en silencio.
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { serverAuditLog } from '@/lib/server-audit';

const BUCKET = 'expense-attachments';
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const SIGNED_TTL_SECONDS = 600;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface Sniffed {
  ext: string;
  mime: string;
  /** true = contenedor ZIP de Office: los bytes NO distinguen docx de xlsx. */
  office?: boolean;
}

/**
 * Sniff por magic bytes.
 *
 * OJO — el comentario que estaba acá antes decía que este sniff era idéntico al
 * de /payment-orders/[id]/proof y que había que tocar los dos juntos. Desde el
 * 2026-09-01 eso es FALSO y se corrige en el mismo lugar en vez de borrarlo:
 *   · El espejo de esta función es sniffAttachment() en
 *     /api/admin/payment-orders/[id]/attachment — el que YA acepta Office
 *     (PDF, PNG, JPG, WEBP, XLSX, DOCX). Si mañana entra un formato nuevo, van
 *     los dos.
 *   · sniffProof() en lib/payment-orders/proof-files.ts NO sigue este criterio:
 *     se queda en los 4 formatos clásicos (PDF/PNG/JPG/WEBP) y rechaza el ZIP
 *     de Office a propósito — proofs.test.ts lo fija.
 */
function sniff(bytes: Uint8Array): Sniffed | null {
  // PDF: "%PDF-"
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
    bytes[3] === 0x46 && bytes[4] === 0x2d
  ) {
    return { ext: 'pdf', mime: 'application/pdf' };
  }
  // PNG
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a &&
    bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { ext: 'png', mime: 'image/png' };
  }
  // JPEG
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  // WEBP: "RIFF" en 0-3 y "WEBP" en 8-11.
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  // DOCX / XLSX: los dos son un ZIP y arrancan con el local file header
  // PK\x03\x04 — por bytes son indistinguibles. Se acepta como "Office
  // genérico" y cuál de los dos es lo resuelve después la extensión declarada
  // (solo decide nombre y Content-Type, nunca si el archivo entra).
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b &&
    bytes[2] === 0x03 && bytes[3] === 0x04
  ) {
    return { ext: 'docx', mime: DOCX_MIME, office: true };
  }
  return null;
}

/**
 * Resuelve el ZIP de Office con la extensión DECLARADA en el nombre subido: si
 * el usuario dijo .xlsx se guarda como planilla; en cualquier otro caso (.docx,
 * una extensión rara o directamente ninguna) queda como documento. Es la misma
 * línea del precedente, con el mismo default.
 *
 * Diferencia deliberada con el precedente: allá la extensión declarada pasa
 * antes por una allowlist (`ALLOWED_EXTENSIONS`) como primera pasada barata,
 * así que para cuando llega acá ya es una de las permitidas. Este endpoint
 * nunca tuvo esa pasada — la entrada la deciden SOLO los bytes — y agregarla
 * ahora rechazaría archivos que hoy entran (un PDF sin extensión en el nombre,
 * por ejemplo). Como la allowlist no cambia el docx-vs-xlsx (solo `'xlsx'`
 * decide, todo lo demás cae al default), replicarla acá no aportaría nada y
 * sería una segunda lista para desincronizar.
 */
function resolveStored(sniffed: Sniffed, declaredName: string): { ext: string; mime: string } {
  if (!sniffed.office) return { ext: sniffed.ext, mime: sniffed.mime };
  const declared = (declaredName.split('.').pop() || '').toLowerCase();
  return declared === 'xlsx'
    ? { ext: 'xlsx', mime: XLSX_MIME }
    : { ext: 'docx', mime: DOCX_MIME };
}

/** Nombre visible saneado: sin rutas, sin caracteres raros, acotado. */
function safeDisplayName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? 'comprobante';
  return base.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'comprobante';
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['expenses', 'upload'] });
    if (auth instanceof NextResponse) return auth;
    if (auth.role === 'hr') {
      return NextResponse.json(
        { success: false, error: 'Permiso insuficiente para modificar egresos' },
        { status: 403 },
      );
    }

    const formData = await request.formData();
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json(
        { success: false, error: 'No se recibió ningún archivo.' },
        { status: 400 },
      );
    }
    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { success: false, error: 'Archivo demasiado grande (máx 10 MB)' },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const kind = sniff(new Uint8Array(buffer.subarray(0, 16)));
    if (!kind) {
      return NextResponse.json(
        { success: false, error: 'Formato no admitido. Se aceptan PDF, PNG, JPG, WEBP, XLSX y DOCX.' },
        { status: 400 },
      );
    }

    // Para el ZIP de Office los bytes no alcanzan: la extensión declarada elige
    // entre planilla y documento (ver resolveStored).
    const stored = resolveStored(kind, file.name);

    // Path estable e independiente del id del egreso (ver cabecera).
    const path = `${auth.companyId}/${randomUUID()}.${stored.ext}`;

    const admin = createAdminClient();
    const { error: upErr } = await admin.storage
      .from(BUCKET)
      .upload(path, buffer, { contentType: stored.mime, upsert: false });

    if (upErr) {
      return apiError('admin/expenses/attachment', upErr, {
        status: 500,
        clientMessage: 'No se pudo subir el comprobante',
      });
    }

    // URL firmada de cortesía: permite ver lo recién subido ANTES de guardar
    // el período, cuando el egreso todavía no tiene id en la base.
    const { data: signed } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(path, SIGNED_TTL_SECONDS);

    await serverAuditLog(admin, {
      companyId: auth.companyId,
      actorId: auth.userId,
      actorName: auth.name || auth.email,
      action: 'create',
      module: 'expenses',
      details: JSON.stringify({ attachment: safeDisplayName(file.name), size: file.size }),
    });

    return NextResponse.json({
      success: true,
      attachment: {
        bucket: BUCKET,
        path,
        name: safeDisplayName(file.name),
        mime: stored.mime,
        size: file.size,
        uploaded_at: new Date().toISOString(),
      },
      url: signed?.signedUrl ?? null,
    });
  } catch (err) {
    return apiError('admin/expenses/attachment', err, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['expenses', 'upload'] });
  if (auth instanceof NextResponse) return auth;
  if (auth.role === 'hr') {
    return NextResponse.json(
      { success: false, error: 'Permiso insuficiente para modificar egresos' },
      { status: 403 },
    );
  }

  const { path } = (await request.json().catch(() => ({}))) as { path?: string };
  if (!path) {
    return NextResponse.json({ success: false, error: 'Falta el path' }, { status: 400 });
  }

  // El path SIEMPRE arranca con el id de la empresa del token. Sin este
  // chequeo, un payload manipulado podría borrar el comprobante de otro
  // tenant — el admin client saltea RLS.
  if (!path.startsWith(`${auth.companyId}/`)) {
    return NextResponse.json({ success: false, error: 'Comprobante no encontrado' }, { status: 404 });
  }

  const admin = createAdminClient();
  const { error } = await admin.storage.from(BUCKET).remove([path]);
  if (error) {
    return apiError('admin/expenses/attachment', error, {
      status: 500,
      clientMessage: 'No se pudo eliminar el comprobante',
    });
  }

  return NextResponse.json({ success: true });
}
