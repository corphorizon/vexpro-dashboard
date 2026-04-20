import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';

// ---------------------------------------------------------------------------
// POST /api/auth/setup-2fa
//
// Actions:
//   generate — Creates a TOTP secret + QR code. The secret is stored
//              server-side as `twofa_pending_secret`; the client receives the
//              secret and QR for display, but `verify` always uses the
//              server copy (prevents XSS swapping the secret at verify time).
//   verify   — Verifies a TOTP code and activates 2FA
//   disable  — Disables 2FA (requires valid TOTP code)
//
// Re-generating when 2FA is already active requires a valid current TOTP
// token in `currentToken` — prevents silent rotation via stolen session.
// ---------------------------------------------------------------------------

// Fallback when we can't resolve a tenant name (e.g. orphan auth user).
// The tenant's own name is used when available — see `resolveIssuer`.
const DEFAULT_APP_NAME = 'Smart Dashboard';
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

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

    const body = await request.json().catch(() => ({}));
    const { action } = body as { action?: string };

    const adminClient = createAdminClient();

    // Action: generate — create a new TOTP secret and QR code
    if (!action || action === 'generate') {
      const { currentToken } = body as { currentToken?: string };

      // Get user email + current 2FA state + company name (for the TOTP
      // label shown in the authenticator app).
      const { data: companyUser } = await adminClient
        .from('company_users')
        .select('email, twofa_enabled, twofa_secret, companies(name)')
        .eq('user_id', user.id)
        .maybeSingle();

      if (!companyUser) {
        return NextResponse.json(
          { success: false, error: 'Usuario no encontrado' },
          { status: 404 },
        );
      }

      // Per-tenant TOTP issuer so users with accounts in multiple companies
      // see them as distinct entries in Google Authenticator / Authy.
      const companyRel = (companyUser as { companies?: { name?: string } | { name?: string }[] | null }).companies;
      const companyName = Array.isArray(companyRel)
        ? companyRel[0]?.name
        : companyRel?.name;
      const issuer = companyName || DEFAULT_APP_NAME;

      // If 2FA is already active, require a valid TOTP from the current secret
      // before allowing rotation.
      if (companyUser.twofa_enabled && companyUser.twofa_secret) {
        if (!currentToken) {
          return NextResponse.json(
            {
              success: false,
              error: 'Ya tienes 2FA activo. Ingresa un código actual para regenerar.',
              requiresCurrentToken: true,
            },
            { status: 400 },
          );
        }
        const validCurrent = speakeasy.totp.verify({
          secret: companyUser.twofa_secret,
          encoding: 'base32',
          token: currentToken,
          window: 1,
        });
        if (!validCurrent) {
          return NextResponse.json(
            { success: false, error: 'Código actual incorrecto.' },
            { status: 401 },
          );
        }
      }

      // Generate a new TOTP secret
      const secretObj = speakeasy.generateSecret({
        name: `${issuer}:${companyUser.email}`,
        issuer,
        length: 20,
      });

      const otpauthUrl = secretObj.otpauth_url!;

      // Store the pending secret server-side (replaces any previous pending)
      const { error: pendingErr } = await adminClient
        .from('company_users')
        .update({
          twofa_pending_secret: secretObj.base32,
          twofa_pending_at: new Date().toISOString(),
        })
        .eq('user_id', user.id);

      if (pendingErr) {
        console.error('[setup-2fa] Error saving pending secret:', pendingErr.message);
        return NextResponse.json(
          { success: false, error: 'Error generando código QR' },
          { status: 500 },
        );
      }

      // Generate QR code as data URL
      const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, {
        width: 256,
        margin: 2,
        color: {
          dark: '#1E293B',
          light: '#FFFFFF',
        },
      });

      return NextResponse.json({
        success: true,
        secret: secretObj.base32, // shown to user for manual entry
        qrCode: qrCodeDataUrl,
        otpauthUrl,
      });
    }

    // Action: verify — verify a TOTP code against the server-stored pending
    // secret and activate 2FA. The `secret` from the body is IGNORED.
    if (action === 'verify') {
      const { token } = body as { token?: string };

      if (!token || !/^\d{6}$/.test(token)) {
        return NextResponse.json(
          { success: false, error: 'Se requiere un código de 6 dígitos' },
          { status: 400 },
        );
      }

      const { data: companyUser } = await adminClient
        .from('company_users')
        .select('twofa_pending_secret, twofa_pending_at')
        .eq('user_id', user.id)
        .maybeSingle();

      if (!companyUser?.twofa_pending_secret || !companyUser.twofa_pending_at) {
        return NextResponse.json(
          { success: false, error: 'No hay configuración pendiente. Genera un nuevo código.' },
          { status: 400 },
        );
      }

      const age = Date.now() - new Date(companyUser.twofa_pending_at).getTime();
      if (age > PENDING_TTL_MS) {
        return NextResponse.json(
          { success: false, error: 'El código expiró. Genera uno nuevo.' },
          { status: 400 },
        );
      }

      const isValid = speakeasy.totp.verify({
        secret: companyUser.twofa_pending_secret,
        encoding: 'base32',
        token,
        window: 1,
      });

      if (!isValid) {
        return NextResponse.json(
          { success: false, error: 'Código incorrecto. Verifica que la hora de tu dispositivo esté sincronizada.' },
          { status: 401 },
        );
      }

      // Promote pending → active, clear pending, clear force-setup flag
      const { error: updateError } = await adminClient
        .from('company_users')
        .update({
          twofa_enabled: true,
          twofa_secret: companyUser.twofa_pending_secret,
          twofa_pending_secret: null,
          twofa_pending_at: null,
          force_2fa_setup: false,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', user.id);

      if (updateError) {
        console.error('[setup-2fa] Error updating user:', updateError.message);
        return NextResponse.json(
          { success: false, error: 'Error al activar 2FA' },
          { status: 500 },
        );
      }

      return NextResponse.json({ success: true, verified: true });
    }

    // Action: disable — disable 2FA (requires valid TOTP code)
    if (action === 'disable') {
      const { token } = body as { token?: string };

      if (!token || !/^\d{6}$/.test(token)) {
        return NextResponse.json(
          { success: false, error: 'Se requiere un código de 6 dígitos' },
          { status: 400 },
        );
      }

      // Get current secret
      const { data: companyUser } = await adminClient
        .from('company_users')
        .select('twofa_secret, twofa_enabled')
        .eq('user_id', user.id)
        .maybeSingle();

      if (!companyUser?.twofa_enabled || !companyUser.twofa_secret) {
        return NextResponse.json(
          { success: false, error: '2FA no está habilitado' },
          { status: 400 },
        );
      }

      // Verify the TOTP token
      const isValid = speakeasy.totp.verify({
        secret: companyUser.twofa_secret,
        encoding: 'base32',
        token,
        window: 1,
      });

      if (!isValid) {
        return NextResponse.json(
          { success: false, error: 'Código incorrecto' },
          { status: 401 },
        );
      }

      // Disable 2FA
      const { error: updateError } = await adminClient
        .from('company_users')
        .update({
          twofa_enabled: false,
          twofa_secret: null,
          twofa_pending_secret: null,
          twofa_pending_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', user.id);

      if (updateError) {
        return NextResponse.json(
          { success: false, error: 'Error al desactivar 2FA' },
          { status: 500 },
        );
      }

      return NextResponse.json({ success: true, disabled: true });
    }

    return NextResponse.json(
      { success: false, error: 'Acción no válida' },
      { status: 400 },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[setup-2fa] Unhandled error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
