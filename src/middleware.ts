import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';
import { canonicalRedirectUrl } from '@/lib/app-domain';

export async function middleware(request: NextRequest) {
  // Mudanza a dashboard.exuraglobal.com (src/lib/app-domain.ts): sólo con
  // CANONICAL_HOST definida, y nunca para /api.
  const target = canonicalRedirectUrl({
    host: request.headers.get('host'),
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    canonicalHost: process.env.CANONICAL_HOST,
  });
  if (target) return NextResponse.redirect(target, 308);
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, icon.png (metadata files)
     * - public assets
     */
    '/((?!_next/static|_next/image|favicon.ico|icon.png|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
