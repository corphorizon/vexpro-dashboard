import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { serverAuditLog } from '@/lib/server-audit';

// ---------------------------------------------------------------------------
// POST   /api/superadmin/companies/:id/logo   → upload a logo file
// DELETE /api/superadmin/companies/:id/logo   → clear the logo
//
// Upload accepts PNG / SVG / JPG / WEBP, max 2MB. Content-type is verified
// server-side by:
//   1. Checking the MIME header (File.type).
//   2. Sniffing magic bytes for binary formats (PNG/JPG/WEBP).
//   3. Detecting `<svg` at the start of text-decoded bytes for SVG.
//
// The `company-logos` Storage bucket is created on first use with public
// read + no anon write (writes go through this service-role route).
// ---------------------------------------------------------------------------

const BUCKET = 'company-logos';
const MAX_SIZE = 2 * 1024 * 1024; // 2 MB

type MimeCheck = { mime: string; ext: string };

/** Returns {mime, ext} if the bytes are a recognised image, else null. */
function sniffImage(bytes: Uint8Array): MimeCheck | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: 'png' };
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  // SVG: text starting with optional BOM/whitespace/xml prolog, contains "<svg"
  try {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 512)).toLowerCase();
    if (head.includes('<svg')) {
      return { mime: 'image/svg+xml', ext: 'svg' };
    }
  } catch {
    /* not text */
  }
  return null;
}

/** Ensures the bucket exists + is public. Cheap: one listBuckets call. */
async function ensureBucket(admin: ReturnType<typeof createAdminClient>) {
  const { data: buckets, error } = await admin.storage.listBuckets();
  if (error) throw new Error(`listBuckets failed: ${error.message}`);
  const exists = (buckets ?? []).some((b) => b.name === BUCKET);
  if (exists) return;
  const { error: createErr } = await admin.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: MAX_SIZE,
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'],
  });
  if (createErr) {
    // If another worker created it concurrently, that's fine.
    if (!/already exists/i.test(createErr.message)) {
      throw new Error(`createBucket failed: ${createErr.message}`);
    }
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id: companyId } = await params;

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json({ success: false, error: 'Falta archivo' }, { status: 400 });
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { success: false, error: 'El archivo supera 2MB' },
        { status: 400 },
      );
    }
    if (file.size === 0) {
      return NextResponse.json(
        { success: false, error: 'Archivo vacío' },
        { status: 400 },
      );
    }

    // MIME check (cheap first pass).
    const mimeAllowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml'];
    if (file.type && !mimeAllowed.includes(file.type.toLowerCase())) {
      return NextResponse.json(
        {
          success: false,
          error: `Tipo de archivo no permitido. Usa PNG, SVG, JPG o WEBP.`,
        },
        { status: 400 },
      );
    }

    // Magic-bytes check (authoritative — clients can lie about MIME).
    const buf = Buffer.from(await file.arrayBuffer());
    const sniffed = sniffImage(buf);
    if (!sniffed) {
      return NextResponse.json(
        { success: false, error: 'El archivo no es una imagen válida (PNG, SVG, JPG o WEBP)' },
        { status: 400 },
      );
    }

    const admin = createAdminClient();

    // Verify the company exists before uploading.
    const { data: company } = await admin
      .from('companies')
      .select('id, name, logo_url')
      .eq('id', companyId)
      .maybeSingle();
    if (!company) {
      return NextResponse.json(
        { success: false, error: 'Empresa no encontrada' },
        { status: 404 },
      );
    }

    await ensureBucket(admin);

    const fileName = `${companyId}/${Date.now()}.${sniffed.ext}`;
    const { error: uploadErr } = await admin.storage
      .from(BUCKET)
      .upload(fileName, buf, {
        contentType: sniffed.mime,
        upsert: false,
      });

    if (uploadErr) {
      return NextResponse.json(
        { success: false, error: `No se pudo subir el archivo: ${uploadErr.message}` },
        { status: 500 },
      );
    }

    const { data: urlData } = admin.storage.from(BUCKET).getPublicUrl(fileName);
    const publicUrl = urlData.publicUrl;

    // Best-effort cleanup of the prior logo if it also lived in our bucket.
    const prevUrl = company.logo_url as string | null;
    if (prevUrl && prevUrl.includes(`/storage/v1/object/public/${BUCKET}/`)) {
      const prevPath = prevUrl.split(`/public/${BUCKET}/`)[1];
      if (prevPath) {
        await admin.storage
          .from(BUCKET)
          .remove([prevPath])
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn('[logo-cleanup] could not remove previous logo:', prevPath, msg);
          });
      }
    }

    const { error: updateErr } = await admin
      .from('companies')
      .update({ logo_url: publicUrl })
      .eq('id', companyId);
    if (updateErr) {
      return NextResponse.json(
        { success: false, error: updateErr.message },
        { status: 500 },
      );
    }

    await serverAuditLog(admin, {
      companyId,
      actorId: auth.userId,
      actorName: auth.name || auth.email,
      action: 'update',
      module: 'companies',
      details: `Superadmin actualizó el logo de ${company.name} (${sniffed.ext.toUpperCase()}, ${(file.size / 1024).toFixed(1)} KB)`,
    });

    return NextResponse.json({ success: true, url: publicUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id: companyId } = await params;

    const admin = createAdminClient();

    const { data: company } = await admin
      .from('companies')
      .select('id, name, logo_url')
      .eq('id', companyId)
      .maybeSingle();
    if (!company) {
      return NextResponse.json(
        { success: false, error: 'Empresa no encontrada' },
        { status: 404 },
      );
    }

    const prevUrl = company.logo_url as string | null;
    if (prevUrl && prevUrl.includes(`/storage/v1/object/public/${BUCKET}/`)) {
      const prevPath = prevUrl.split(`/public/${BUCKET}/`)[1];
      if (prevPath) {
        await admin.storage
          .from(BUCKET)
          .remove([prevPath])
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn('[logo-cleanup] could not remove previous logo:', prevPath, msg);
          });
      }
    }

    const { error: updateErr } = await admin
      .from('companies')
      .update({ logo_url: null })
      .eq('id', companyId);
    if (updateErr) {
      return NextResponse.json(
        { success: false, error: updateErr.message },
        { status: 500 },
      );
    }

    await serverAuditLog(admin, {
      companyId,
      actorId: auth.userId,
      actorName: auth.name || auth.email,
      action: 'delete',
      module: 'companies',
      details: `Superadmin eliminó el logo de ${company.name}`,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
