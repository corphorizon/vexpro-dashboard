import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendLoginNotificationEmail } from '@/services/emailService';

// ---------------------------------------------------------------------------
// User-Agent parser (simple regex, no external dependency)
// ---------------------------------------------------------------------------

function parseBrowser(ua: string): string {
  if (!ua) return 'Unknown Device';

  // Order matters — check more specific patterns first
  if (/Edg\//i.test(ua)) {
    const m = ua.match(/Edg\/([\d.]+)/);
    return `Microsoft Edge ${m?.[1] ?? ''}`.trim();
  }
  if (/OPR\//i.test(ua) || /Opera/i.test(ua)) {
    const m = ua.match(/OPR\/([\d.]+)/);
    return `Opera ${m?.[1] ?? ''}`.trim();
  }
  if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) {
    const m = ua.match(/Chrome\/([\d.]+)/);
    return `Google Chrome ${m?.[1] ?? ''}`.trim();
  }
  if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) {
    const m = ua.match(/Version\/([\d.]+)/);
    return `Safari ${m?.[1] ?? ''}`.trim();
  }
  if (/Firefox\//i.test(ua)) {
    const m = ua.match(/Firefox\/([\d.]+)/);
    return `Firefox ${m?.[1] ?? ''}`.trim();
  }

  return 'Unknown Browser';
}

function parseOS(ua: string): string {
  if (!ua) return '';

  if (/Windows NT 10/i.test(ua)) return 'Windows';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac OS X/i.test(ua)) return 'macOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad/i.test(ua)) return 'iOS';
  if (/Linux/i.test(ua)) return 'Linux';

  return '';
}

function getDeviceLabel(ua: string): string {
  const browser = parseBrowser(ua);
  const os = parseOS(ua);
  return os ? `${browser} on ${os}` : browser;
}

// ---------------------------------------------------------------------------
// POST /api/auth/login-notification
//
// Requires an active Supabase session. Only sends notification for the
// authenticated user — ignores userName/userEmail from the body to prevent
// spoofing.
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

    // Use the authenticated user's data — never trust body for identity
    const userName = user.user_metadata?.name || user.email?.split('@')[0] || 'Usuario';
    const userEmail = user.email;

    if (!userEmail) {
      return NextResponse.json(
        { success: false, error: 'Usuario sin email' },
        { status: 400 },
      );
    }

    // Extract IP
    const forwarded = request.headers.get('x-forwarded-for');
    const ipAddress = forwarded?.split(',')[0]?.trim() || 'Unknown IP';

    // Extract & parse User-Agent
    const ua = request.headers.get('user-agent') || '';
    const browser = getDeviceLabel(ua);

    // Format date & time
    const now = new Date();
    const loginDate = now.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const loginTime = now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });

    // Dashboard URL
    const dashboardUrl =
      process.env.NEXT_PUBLIC_DASHBOARD_URL ||
      request.nextUrl.origin;

    // Look up the user's company_id so we can send via that company's
    // SendGrid credentials when configured.
    const adminClient = createAdminClient();
    const { data: profile } = await adminClient
      .from('company_users')
      .select('company_id')
      .eq('user_id', user.id)
      .maybeSingle();

    // Send email
    const result = await sendLoginNotificationEmail(userEmail, userName, {
      loginDate,
      loginTime,
      browser,
      ipAddress,
      dashboardUrl,
    }, profile?.company_id);

    if (!result.success) {
      console.error('[LoginNotification] Failed to send');
    }

    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[LoginNotification] Unhandled error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
