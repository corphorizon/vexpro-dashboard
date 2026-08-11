import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import {
  TWOFA_COOKIE,
  mintTwofaSeal,
  twofaCookieOptions,
  twofaSealAvailable,
  verifyTwofaSeal,
} from '@/lib/auth/twofa-session';

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
    // Sentry tunnel route (configured in next.config.ts). Browser
    // error reports POST here; if middleware redirects to /login they
    // never reach Sentry.
    pathname.startsWith('/monitoring') ||
    pathname === '/favicon.ico' ||
    pathname === '/icon.svg' ||
    pathname === '/manifest.json' ||
    pathname === '/apple-touch-icon.png';

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

  // ── SELLO 2FA (auditoría 2026-08) ──────────────────────────────────────
  // Hasta acá el guardián sólo comprobaba que EXISTIERA un `user`. Una sesión
  // sacada directamente contra GoTrue con la anon key (pública) pasaba igual:
  // sin PIN, sin bloqueo de cuenta y sin throttle por IP. Ahora, si el usuario
  // tiene 2FA habilitado, además exigimos el sello firmado que sólo el
  // servidor emite (ver src/lib/auth/twofa-session.ts).
  //
  // COSTO: cero consultas extra en régimen. El camino rápido es puro HMAC
  // sobre una cookie. La consulta a la DB ocurre SÓLO cuando falta el sello
  // —sesiones emitidas antes de este deploy— y para los usuarios sin 2FA se
  // auto-cura en esa misma respuesta (se les emite el sello y no vuelve a
  // consultarse nunca más).
  if (user && !isPublicRoute && twofaSealAvailable()) {
    const sealed = await verifyTwofaSeal(request.cookies.get(TWOFA_COOKIE)?.value, user.id);

    if (!sealed) {
      // ¿Este usuario necesita segundo factor? Se resuelve igual que el
      // perfil en el resto de la app: company_users primero, platform_users
      // después (el superadmin no tiene fila en la primera).
      const { data: cu, error: cuErr } = await supabase
        .from('company_users')
        .select('twofa_enabled')
        .eq('user_id', user.id)
        .maybeSingle();

      let needs2fa: boolean | null = cuErr ? null : cu ? !!cu.twofa_enabled : null;

      if (needs2fa === null && !cuErr) {
        const { data: pu, error: puErr } = await supabase
          .from('platform_users')
          .select('twofa_enabled')
          .eq('user_id', user.id)
          .maybeSingle();
        needs2fa = puErr ? null : pu ? !!pu.twofa_enabled : false;
      }

      if (needs2fa === true) {
        // Sesión sin sello + 2FA habilitado ⇒ no vale. Se manda a /login,
        // que es ruta pública y NO auto-redirige cuando ya hay sesión: el
        // usuario vuelve a escribir su PIN y sale con sello. No hay bucle
        // posible. Se borra el sello (si venía uno vencido o adulterado)
        // para que no quede basura en el navegador.
        const url = request.nextUrl.clone();
        url.pathname = '/login';
        url.searchParams.set('reauth', '2fa');
        const redirect = NextResponse.redirect(url);
        redirect.cookies.set(TWOFA_COOKIE, '', { ...twofaCookieOptions(0), maxAge: 0 });
        return redirect;
      }

      if (needs2fa === false) {
        // Sin 2FA: entra exactamente igual que antes y se lleva el sello para
        // que la próxima navegación tome el camino rápido. Esto también
        // "cura" las sesiones que ya estaban abiertas cuando salió el deploy.
        const seal = await mintTwofaSeal(user.id);
        if (seal) supabaseResponse.cookies.set(TWOFA_COOKIE, seal, twofaCookieOptions());
      }
      // needs2fa === null ⇒ no pudimos leerlo (error de DB / usuario huérfano
      // sin perfil). Fail-open DELIBERADO y sin emitir sello: preferimos que
      // una caída de la base no eche a nadie, y que la decisión se reintente
      // en la próxima navegación. No abre el agujero: el atacante lee su
      // propia fila sin problema, así que no puede provocar este caso.
    }
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
