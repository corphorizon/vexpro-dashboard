import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// ─────────────────────────────────────────────────────────────────────────────
// Security headers
//
// Applied to every response via Next.js `headers()` config. Most of these
// are low-risk hardening; CSP is the one that needs care because it can
// silently break runtime behaviour if too strict.
//
// CSP notes:
//   · `'unsafe-inline'` on script-src + style-src is unfortunate but
//     currently required by Next.js App Router (hydration script, font
//     injection, theme bootstrap). Moving to nonces would require a full
//     middleware overhaul — out of scope for this fix.
//   · `'unsafe-eval'` kept because speakeasy / QR generation use Function
//     constructors under the hood in some code paths.
//   · connect-src lists only the origins the BROWSER talks to directly.
//     Server-side calls (Coinsbuy / UniPayment / FairPay APIs) run inside
//     /api/** routes and never cross the CSP boundary.
//   · img-src allows data: URIs because QR codes and the login logo fallback
//     emit them, and https: because tenant logos come from any public bucket.
//   · frame-ancestors 'none' duplicates X-Frame-Options DENY but newer
//     browsers prefer the CSP form. Belt-and-suspenders is fine.
// ─────────────────────────────────────────────────────────────────────────────
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const SECURITY_HEADERS = [
  // HSTS is already set by Vercel (max-age=63072000). No need to duplicate
  // here — duplicated Strict-Transport-Security headers cause some CDNs to
  // emit a warning. We set the rest that Vercel does NOT supply.
  { key: 'Content-Security-Policy', value: CSP_DIRECTIVES },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    // Disable hardware we never need. Geolocation / camera / microphone
    // could surprise a user on a compromised page; payment / usb are
    // high-impact if the app is ever embedded.
    value: [
      'camera=()',
      'microphone=()',
      'geolocation=()',
      'payment=()',
      'usb=()',
      'interest-cohort=()',
    ].join(', '),
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

// Wrap with Sentry so source maps are uploaded on build and the SDK is
// injected. If SENTRY_* env vars aren't set (local dev), withSentryConfig
// is a no-op for runtime — it only emits a build-time warning.
export default withSentryConfig(nextConfig, {
  // Silent in local dev, verbose in CI. Org/project pulled from env
  // (SENTRY_ORG, SENTRY_PROJECT) set in Vercel.
  silent: !process.env.CI,
  // Tunnel browser events through a Next.js rewrite to dodge ad blockers.
  tunnelRoute: '/monitoring',
  // Strip Sentry SDK logger calls from the browser build.
  disableLogger: true,
});
