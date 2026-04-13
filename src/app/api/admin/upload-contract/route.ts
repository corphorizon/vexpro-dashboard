import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';

const BUCKET = 'contracts';
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_EXTENSIONS = ['pdf', 'docx', 'doc', 'jpg', 'jpeg', 'png'];

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth();
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

    // Validate file extension
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return NextResponse.json(
        { error: `Tipo de archivo no permitido. Solo: ${ALLOWED_EXTENSIONS.join(', ')}` },
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
    const fileName = `${profileId}/${Date.now()}_contract.${ext}`;

    const buffer = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(fileName, buffer, {
        contentType: file.type,
        upsert: true,
      });

    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 400 });
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
