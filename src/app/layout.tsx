import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";

// Production URL used for every canonical link, Open Graph URL, and
// metadataBase. Override in dev/preview via NEXT_PUBLIC_APP_URL.
const SITE_URL = process.env.NEXT_PUBLIC_APP_URL || "https://dashboard.horizonconsulting.ai";
const SITE_NAME = "Smart Dashboard";
const SITE_DESCRIPTION = "The all-in-one financial and operations dashboard";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_NAME,
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: "Horizon Consulting" }],
  alternates: {
    canonical: SITE_URL,
  },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    images: [
      {
        url: "/brand/og-image.png",
        width: 1200,
        height: 630,
        alt: SITE_NAME,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    images: ["/brand/og-image.png"],
  },
  // Robots + manifest — the platform is behind auth, so no indexing.
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/brand/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/brand/apple-touch-icon.png", sizes: "180x180" }],
    shortcut: "/favicon.ico",
  },
};

export const viewport: Viewport = {
  themeColor: "#0f172a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className="h-full" suppressHydrationWarning>
      <body className="h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
