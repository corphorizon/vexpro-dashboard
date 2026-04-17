import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { sendNotificationEmail } from '@/services/emailService';

// ---------------------------------------------------------------------------
// GET /api/send-email/test?to=email@example.com
//
// Sends a test email to verify SendGrid is configured correctly.
// Disabled in production for safety.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await verifyAdminAuth();
  if (auth instanceof NextResponse) return auth;

  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { success: false, error: 'Test endpoint is disabled in production' },
      { status: 403 },
    );
  }

  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL;

  // Config check (without sending)
  const configStatus = {
    SENDGRID_API_KEY: apiKey && apiKey !== 'your_sendgrid_api_key_here' ? 'configured' : 'missing',
    SENDGRID_FROM_EMAIL: fromEmail ?? 'missing',
    SENDGRID_FROM_NAME: process.env.SENDGRID_FROM_NAME ?? 'missing',
  };

  const to = request.nextUrl.searchParams.get('to');

  // If no "to" param, just return config status
  if (!to) {
    return NextResponse.json({
      success: true,
      message: 'SendGrid configuration status. Add ?to=email@example.com to send a test email.',
      config: configStatus,
    });
  }

  // Send a real test email — uses the caller's company credentials if set.
  const result = await sendNotificationEmail(
    to,
    'Smart Dashboard — Test Email',
    'This is a test email to verify that SendGrid is configured correctly. If you received this, the integration is working!',
    auth.companyId,
  );

  return NextResponse.json({
    ...result,
    config: configStatus,
  });
}
