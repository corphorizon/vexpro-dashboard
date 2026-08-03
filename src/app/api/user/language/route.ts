import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { isEmailLocale } from '@/lib/email-i18n';
import { apiError } from '@/lib/api-error';

// ---------------------------------------------------------------------------
// PATCH /api/user/language
//
// Any authenticated user updates their OWN preferred_language ('en' | 'es'),
// used to localise every transactional email they receive. Platform
// superadmins update platform_users; company members update company_users.
//
// Deliberately does not go through verifyAuth(): that helper forces
// superadmins to target a tenant via ?company_id, which makes no sense here —
// this endpoint only ever touches the caller's own row, resolved from the
// session. Body: { language: 'en' | 'es' }.
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) {
      return NextResponse.json(
        { success: false, error: 'No autenticado' },
        { status: 401 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const language = (body as { language?: unknown }).language;
    if (!isEmailLocale(language)) {
      return NextResponse.json(
        { success: false, error: "language debe ser 'en' o 'es'" },
        { status: 400 },
      );
    }

    // Writes go through the service-role client — RLS policies on these
    // tables don't necessarily allow self-updates, and the WHERE is pinned
    // to the caller's own auth user id, so there's no cross-user surface.
    const admin = createAdminClient();

    // Platform superadmin → platform_users. Otherwise → company_users.
    const { data: pu } = await supabase
      .from('platform_users')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle();

    const table = pu ? 'platform_users' : 'company_users';
    const { error: updateErr, count } = await admin
      .from(table)
      .update({ preferred_language: language }, { count: 'exact' })
      .eq('user_id', user.id);

    if (updateErr) {
      console.error('[user/language] update failed:', updateErr.message);
      return NextResponse.json(
        { success: false, error: 'No se pudo actualizar el idioma' },
        { status: 500 },
      );
    }
    if (!count) {
      return NextResponse.json(
        { success: false, error: 'Usuario sin perfil asignado' },
        { status: 403 },
      );
    }

    return NextResponse.json({ success: true, language });
  } catch (err: unknown) {
    return apiError('user/language', err, { status: 500 });
  }
}
