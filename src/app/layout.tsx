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
        url: "/og-image.png",
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
    images: ["/og-image.png"],
  },
  // Robots + manifest — the platform is behind auth, so no indexing.
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
  manifest: "/manifest.json",
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
