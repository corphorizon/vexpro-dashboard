import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';
import { canonicalRedirectUrl } from '@/lib/app-domain';
import { archiveBlock } from '@/lib/archive-mode';

export async function middleware(request: NextRequest) {
  // Modo archivo (src/lib/archive-mode.ts, 2026-10-20): crons, ingesta en vivo
  // y toda escritura de /api se cortan con 410 ANTES de llegar a la ruta y sin
  // refrescar sesión. Es la defensa real; la UI sólo deja de dibujar botones.
  const archived = archiveBlock(request.method, request.nextUrl.pathname);
  if (archived) return archived;

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
