import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

const BUCKET = 'contracts';
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const profileId = formData.get('profile_id') as string | null;

    if (!file || !profileId) {
      return NextResponse.json({ error: 'Missing file or profile_id' }, { status: 400 });
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: 'Archivo demasiado grande (máx 10 MB)' }, { status: 400 });
    }

    const admin = createAdminClient();

    // Generate unique file path: contracts/{profileId}/{timestamp}_{filename}
    const ext = file.name.split('.').pop() || 'pdf';
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

    // Update the profile with the contract URL
    const { error: updateError } = await admin
      .from('commercial_profiles')
      .update({ contract_url: contractUrl })
      .eq('id', profileId);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, url: contractUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
