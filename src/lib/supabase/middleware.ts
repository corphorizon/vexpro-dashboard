import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Perf: skip the Supabase auth round-trip for API routes and static paths.
  // Each /api/* route already enforces its own auth via verifyAuth /
  // verifyAdminAuth and returns 401 JSON when missing — the middleware's
  // only job here is to redirect HTML navigation when unauthenticated.
  // Running `supabase.auth.getUser()` on every fetch was adding ~150-300ms
  // per API call (a full RTT to the Supabase auth server).
  const skipAuthCheck =
    pathname.startsWith('/api') ||
    pathname.startsWith('/_next') ||
    pathname === '/favicon.ico' ||
    pathname === '/icon.png';

  if (skipAuthCheck) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: Do not add logic between createServerClient and supabase.auth.getUser().
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPublicRoute =
    pathname.startsWith('/login') ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/reset-password') ||
    pathname.startsWith('/reset-2fa');

  if (!user && !isPublicRoute) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // Defense in depth for /superadmin — the client-side guard in the layout
  // is the primary check, but we also do a quick server check so a non-
  // superadmin can't even hit the route (no layout flash).
  //
  // NOTE: checking `platform_users` requires a DB round-trip; we keep this
  // gated behind the pathname prefix so normal navigation stays fast.
  if (user && pathname.startsWith('/superadmin')) {
    const { data: pu } = await supabase
      .from('platform_users')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle();
    if (!pu) {
      const url = request.nextUrl.clone();
      url.pathname = '/';
      return NextResponse.redirect(url);
    }
  }

  return supabaseResponse;
}
