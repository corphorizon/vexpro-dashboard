import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';

const BUCKET = 'contracts';
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_EXTENSIONS = ['pdf', 'docx', 'doc', 'jpg', 'jpeg', 'png'];

// Server-side magic-bytes check. Extensions + Content-Type are both
// spoofable by the client. We need to inspect the actual bytes before
// trusting the upload. Mirrors the sniff done for logo uploads in
// /api/superadmin/companies/[id]/logo/route.ts.
function sniffContract(bytes: Uint8Array): { ext: string; mime: string } | null {
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
  // DOCX / DOC (both modern Office zip and legacy OLE compound). Modern
  // .docx starts with the ZIP local file header PK\x03\x04. Legacy .doc
  // starts with the D0CF11E0 OLE signature.
  //   ZIP:    50 4B 03 04
  //   OLE:    D0 CF 11 E0 A1 B1 1A E1
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b &&
    bytes[2] === 0x03 && bytes[3] === 0x04
  ) {
    return {
      ext: 'docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 &&
    bytes[3] === 0xe0 && bytes[4] === 0xa1 && bytes[5] === 0xb1 &&
    bytes[6] === 0x1a && bytes[7] === 0xe1
  ) {
    return { ext: 'doc', mime: 'application/msword' };
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const profileId = formData.get('profile_id') as string | null;

    if (!file || !profileId) {
      return NextResponse.json({ error: 'Missing file or profile_id' }, { status: 400 });
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: 'Archivo demasiado grande (máx 10 MB)' }, { status: 400 });
    }

    // Validate file extension (cheap first-pass)
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return NextResponse.json(
        { error: `Tipo de archivo no permitido. Solo: ${ALLOWED_EXTENSIONS.join(', ')}` },
        { status: 400 },
      );
    }

    // Magic-bytes check — authoritative. Extensions + Content-Type are
    // both client-controlled, so we read the first bytes and confirm the
    // file really is what it claims to be. Blocks the classic "rename
    // malware.exe to contract.pdf" attack.
    const buf = Buffer.from(await file.arrayBuffer());
    const sniffed = sniffContract(buf);
    if (!sniffed) {
      return NextResponse.json(
        { error: 'El archivo no es un contrato válido (PDF, DOC, DOCX, JPG o PNG)' },
        { status: 400 },
      );
    }

    const admin = createAdminClient();

    // Verify the profile belongs to the caller's company
    const { data: profile } = await admin
      .from('commercial_profiles')
      .select('id')
      .eq('id', profileId)
      .eq('company_id', auth.companyId)
      .single();

    if (!profile) {
      return NextResponse.json({ error: 'Perfil no encontrado o no pertenece a tu empresa' }, { status: 404 });
    }

    // Generate unique file path: contracts/{profileId}/{timestamp}_contract.{ext}
    // Use the sniffed extension — NOT the filename's — so a renamed upload
    // still lands with the correct extension and content-type.
    const fileName = `${profileId}/${Date.now()}_contract.${sniffed.ext}`;

    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(fileName, buf, {
        contentType: sniffed.mime,
        upsert: true,
      });

    if (uploadError) {
      console.error('[upload-contract] upload failed:', uploadError);
      return NextResponse.json(
        { error: 'No se pudo subir el archivo' },
        { status: 400 },
      );
    }

    // Get the public/signed URL
    const { data: urlData } = admin.storage
      .from(BUCKET)
      .getPublicUrl(fileName);

    const contractUrl = urlData.publicUrl;

    // Update the profile with the contract URL (scoped to company)
    const { error: updateError } = await admin
      .from('commercial_profiles')
      .update({ contract_url: contractUrl })
      .eq('id', profileId)
      .eq('company_id', auth.companyId);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, url: contractUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
