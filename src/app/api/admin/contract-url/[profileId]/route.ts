import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';

const BUCKET = 'contracts';
/** Vida de la URL firmada: suficiente para abrir/descargar, corta para compartir. */
const SIGNED_TTL_SECONDS = 600;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/contract-url/[profileId] — acceso autorizado a contratos RRHH.
//
// SEGURIDAD (S2, auditoría 2026-08): el bucket `contracts` pasa a PRIVADO.
// Este endpoint es la única puerta: valida sesión + empresa (el perfil debe
// pertenecer al tenant del caller) y responde con un redirect 302 a una URL
// firmada de 10 minutos. Así el <a href> de la UI sigue funcionando con un
// click (la cookie de sesión viaja en la navegación).
//
// Compat: las filas viejas guardan la URL pública completa
// (…/object/public/contracts/<path>); las nuevas guardan solo el <path>.
// Acá se aceptan ambas.
// ─────────────────────────────────────────────────────────────────────────────

function extractPath(stored: string): string | null {
  if (!stored) return null;
  // Fila nueva: ya es un path relativo dentro del bucket.
  if (!stored.startsWith('http')) return stored;
  // Fila legacy: URL pública completa → extraer el path después del bucket.
  const marker = `/object/public/${BUCKET}/`;
  const idx = stored.indexOf(marker);
  if (idx === -1) return null;
  const raw = stored.slice(idx + marker.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ profileId: string }> },
) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;
    const { profileId } = await params;

    const admin = createAdminClient();
    // Scope por empresa: el admin client bypassa RLS, así que el filtro por
    // company_id es obligatorio (anti-IDOR).
    const { data: profile } = await admin
      .from('commercial_profiles')
      .select('contract_url')
      .eq('id', profileId)
      .eq('company_id', auth.companyId)
      .maybeSingle();

    if (!profile?.contract_url) {
      return NextResponse.json({ error: 'Este perfil no tiene contrato' }, { status: 404 });
    }

    const path = extractPath(profile.contract_url);
    if (!path) {
      return NextResponse.json({ error: 'Ruta de contrato inválida' }, { status: 422 });
    }

    const { data: signed, error } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(path, SIGNED_TTL_SECONDS);

    if (error || !signed) {
      return apiError('admin/contract-url', error, {
        status: 500,
        clientMessage: 'No se pudo generar el enlace del contrato',
      });
    }

    return NextResponse.redirect(signed.signedUrl, 302);
  } catch (err) {
    return apiError('admin/contract-url', err, { status: 500 });
  }
}
