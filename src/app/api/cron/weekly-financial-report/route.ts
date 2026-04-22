import { NextRequest } from 'next/server';
import { handleReportCron } from '@/lib/reports/cron-handler';

// Vercel Cron: "5 0 * * 1" — runs 00:05 UTC every Monday.
// Reports on the prior Mon→Sun.
export async function GET(request: NextRequest) {
  return handleReportCron(request, 'weekly');
}
