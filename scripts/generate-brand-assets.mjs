// ─────────────────────────────────────────────────────────────────────────────
// One-shot brand asset generator. Reads the two SVG logos from
// /public/brand and produces PNG + ICO + OG image derivatives.
//
// Run once (or re-run whenever logos change):
//   node scripts/generate-brand-assets.mjs
// ─────────────────────────────────────────────────────────────────────────────

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BRAND = path.join(ROOT, 'public', 'brand');
const PUBLIC = path.join(ROOT, 'public');

const LOGO_BLACK = path.join(BRAND, 'logo-black.svg');
const LOGO_WHITE = path.join(BRAND, 'logo-white.svg');

// Primary brand color — matches the default CSS --color-primary.
const BRAND_NAVY = '#1E3A5F';

async function main() {
  if (!fs.existsSync(LOGO_BLACK) || !fs.existsSync(LOGO_WHITE)) {
    throw new Error('Missing logo-black.svg or logo-white.svg in public/brand');
  }

  const blackSvg = fs.readFileSync(LOGO_BLACK);
  const whiteSvg = fs.readFileSync(LOGO_WHITE);

  // ── PNG logos for email templates (SVG not supported in Outlook/Gmail).
  // 800px width, preserve aspect. Transparent bg.
  await sharp(blackSvg, { density: 300 })
    .resize({ width: 800, withoutEnlargement: false })
    .png({ compressionLevel: 9 })
    .toFile(path.join(BRAND, 'logo-black.png'));

  await sharp(whiteSvg, { density: 300 })
    .resize({ width: 800, withoutEnlargement: false })
    .png({ compressionLevel: 9 })
    .toFile(path.join(BRAND, 'logo-white.png'));

  // ── Favicons: 16/32/180 (apple-touch) + ICO (multi-resolution).
  // Favicon uses the BLACK logo because browser chrome is typically light.
  await sharp(blackSvg, { density: 300 })
    .resize(32, 32, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(BRAND, 'favicon-32.png'));

  await sharp(blackSvg, { density: 300 })
    .resize(16, 16, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(BRAND, 'favicon-16.png'));

  await sharp(blackSvg, { density: 300 })
    .resize(180, 180, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(BRAND, 'apple-touch-icon.png'));

  // .ico — ICO is just a wrapper around PNGs. Sharp can't write .ico, but
  // modern browsers accept `.png` under the name `favicon.ico` just fine
  // (reads the PNG signature). We write 32x32 PNG bytes to favicon.ico at
  // /public for legacy compatibility.
  const faviconBuffer = await sharp(blackSvg, { density: 300 })
    .resize(32, 32, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(PUBLIC, 'favicon.ico'), faviconBuffer);

  // Also copy the SVG itself as icon.svg (Next.js App Router auto-detects it).
  fs.copyFileSync(LOGO_BLACK, path.join(PUBLIC, 'icon.svg'));

  // ── OG image 1200×630. White logo centred on brand-navy background.
  // We pre-render the white logo to a PNG at a reasonable size then
  // composite it over a navy background.
  const logoOnNavy = await sharp(whiteSvg, { density: 300 })
    .resize({ width: 500, withoutEnlargement: false })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: 1200,
      height: 630,
      channels: 4,
      background: BRAND_NAVY,
    },
  })
    .composite([{ input: logoOnNavy, gravity: 'center' }])
    .png()
    .toFile(path.join(BRAND, 'og-image.png'));

  // ── Done ──
  const outputs = [
    'logo-black.png',
    'logo-white.png',
    'favicon-16.png',
    'favicon-32.png',
    'apple-touch-icon.png',
    'og-image.png',
  ].map((f) => path.join('public/brand', f));
  outputs.push('public/favicon.ico', 'public/icon.svg');
  console.log('Generated:');
  outputs.forEach((o) => console.log(' ', o));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
