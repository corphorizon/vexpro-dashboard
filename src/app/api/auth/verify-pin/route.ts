import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// ---------------------------------------------------------------------------
// POST /api/auth/verify-pin
//
// Server-side verification of a user's 2FA PIN for deactivation.
// Requires an active Supabase session. Verifies the PIN against the
// stored twofa_secret without ever sending it to the client.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    // Verify the caller has an active session
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { success: false, error: 'No autenticado' },
        { status: 401 },
      );
    }

    const body = await request.json();
    const { pin } = body as { pin?: string };

    if (!pin) {
      return NextResponse.json(
        { success: false, error: 'PIN requerido' },
        { status: 400 },
      );
    }

    // Look up the stored secret using admin client (server-side only)
    const adminClient = createAdminClient();
    const { data: companyUser } = await adminClient
      .from('company_users')
      .select('twofa_secret')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!companyUser || !companyUser.twofa_secret) {
      return NextResponse.json(
        { success: false, error: '2FA no configurado' },
        { status: 400 },
      );
    }

    if (companyUser.twofa_secret !== pin) {
      return NextResponse.json(
        { success: false, error: 'PIN incorrecto' },
        { status: 401 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
