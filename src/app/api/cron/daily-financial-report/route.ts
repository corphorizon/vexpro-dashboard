import { NextRequest } from 'next/server';
import { handleReportCron } from '@/lib/reports/cron-handler';

// Vercel Cron: "5 0 * * *" — runs 00:05 UTC every day.
// Reports on the PRIOR calendar day.
export async function GET(request: NextRequest) {
  return handleReportCron(request, 'daily');
}
