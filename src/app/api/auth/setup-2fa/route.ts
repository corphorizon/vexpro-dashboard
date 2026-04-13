import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';

// ---------------------------------------------------------------------------
// POST /api/auth/setup-2fa
//
// Actions:
//   generate — Creates a TOTP secret + QR code (not stored until verified)
//   verify   — Verifies a TOTP code and activates 2FA
//   disable  — Disables 2FA (requires valid TOTP code)
// ---------------------------------------------------------------------------

const APP_NAME = 'VexPro FX';

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
      // Get user email for the QR label
      const { data: companyUser } = await adminClient
        .from('company_users')
        .select('email, twofa_enabled')
        .eq('user_id', user.id)
        .maybeSingle();

      if (!companyUser) {
        return NextResponse.json(
          { success: false, error: 'Usuario no encontrado' },
          { status: 404 },
        );
      }

      // Generate a new TOTP secret
      const secretObj = speakeasy.generateSecret({
        name: `${APP_NAME}:${companyUser.email}`,
        issuer: APP_NAME,
        length: 20,
      });

      const otpauthUrl = secretObj.otpauth_url!;

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
        secret: secretObj.base32,
        qrCode: qrCodeDataUrl,
        otpauthUrl,
      });
    }

    // Action: verify — verify a TOTP code and activate 2FA
    if (action === 'verify') {
      const { secret, token } = body as { secret?: string; token?: string };

      if (!secret || !token) {
        return NextResponse.json(
          { success: false, error: 'Se requiere secret y token' },
          { status: 400 },
        );
      }

      // Verify the TOTP token against the provided secret
      const isValid = speakeasy.totp.verify({
        secret,
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

      // Token is valid — store the secret and enable 2FA
      const { error: updateError } = await adminClient
        .from('company_users')
        .update({
          twofa_enabled: true,
          twofa_secret: secret,
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

      if (!token) {
        return NextResponse.json(
          { success: false, error: 'Se requiere el código de verificación' },
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
