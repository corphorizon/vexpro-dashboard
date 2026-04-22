import { NextRequest } from 'next/server';
import { handleReportCron } from '@/lib/reports/cron-handler';

// Vercel Cron: "5 0 1 * *" — runs 00:05 UTC on the 1st of every month.
// Reports on the prior calendar month.
export async function GET(request: NextRequest) {
  return handleReportCron(request, 'monthly');
}
