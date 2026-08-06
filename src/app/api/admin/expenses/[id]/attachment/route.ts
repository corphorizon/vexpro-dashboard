// ---------------------------------------------------------------------------
// GET /api/admin/expenses/[id]/attachment
//
// Devuelve una URL FIRMADA y corta para ver el comprobante de un egreso.
//
// El archivo puede vivir en dos buckets distintos, los dos PRIVADOS:
//   · expense-attachments → se subió directo al egreso.
//   · payment-proofs      → el egreso nació de una orden de pago y apunta al
//                           comprobante original de esa orden, sin duplicarlo.
// Por eso el bucket se lee de la fila (`attachment_bucket`) y no se asume.
//
// Mismo patrón de seguridad que los comprobantes de órdenes y los contratos de
// RRHH: en la DB vive el PATH, nunca una URL pública permanente, y cada lectura
// pasa por acá para validar sesión + empresa antes de firmar.
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';

/** Alcanza para abrir o descargar; demasiado corta para compartir por ahí. */
const SIGNED_TTL_SECONDS = 600;

/** Los únicos buckets que un egreso puede referenciar. */
const ALLOWED_BUCKETS = new Set(['expense-attachments', 'payment-proofs']);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await verifyAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const admin = createAdminClient();

  const { data: expense, error } = await admin
    .from('expenses')
    .select('id, company_id, attachment_bucket, attachment_path, attachment_name')
    .eq('id', id)
    .maybeSingle();

  if (error) return apiError('admin/expenses/attachment', error, { status: 500 });

  // El chequeo de empresa va DESPUÉS de leer, con el admin client: leer con
  // el cliente del browser dependería de RLS y el 404/403 se confundirían.
  if (!expense || expense.company_id !== auth.companyId) {
    return NextResponse.json({ success: false, error: 'Egreso no encontrado' }, { status: 404 });
  }
  if (!expense.attachment_path) {
    return NextResponse.json({ success: false, error: 'Este egreso no tiene comprobante' }, { status: 404 });
  }

  const bucket = expense.attachment_bucket ?? '';
  if (!ALLOWED_BUCKETS.has(bucket)) {
    // Fila vieja o manipulada: no se firma nada contra un bucket arbitrario.
    return NextResponse.json(
      { success: false, error: 'El comprobante tiene un origen no reconocido' },
      { status: 422 },
    );
  }

  const { data: signed, error: signErr } = await admin.storage
    .from(bucket)
    .createSignedUrl(expense.attachment_path, SIGNED_TTL_SECONDS);

  if (signErr || !signed?.signedUrl) {
    return apiError('admin/expenses/attachment', signErr, {
      status: 500,
      clientMessage: 'No se pudo generar el enlace al comprobante',
    });
  }

  return NextResponse.json({
    success: true,
    url: signed.signedUrl,
    name: expense.attachment_name ?? 'comprobante',
    expiresIn: SIGNED_TTL_SECONDS,
  });
}
