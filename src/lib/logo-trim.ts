'use client';

// ─────────────────────────────────────────────────────────────────────────────
// logo-trim — recorta el margen transparente de un logo subido por la empresa.
//
// POR QUÉ (2026-10-12, sidebar oscuro de marca): los logos que suben las
// empresas traen lienzos con mucho aire. Medido en prod: el logo blanco de
// Exura Prime es un PNG de 2250×2250 con la palabra ocupando ~70 % del ancho y
// ~15 % del alto; contenido en 28 px de alto queda una marca de 20×4 px,
// ilegible. El de Vex es 1200×600 con margen. `object-contain` no puede saber
// dónde está el dibujo; esto sí: lee el canal alfa una vez en el cliente y
// devuelve un data: URL recortado al dibujo (con un margen chico).
//
// Seguro por defecto: si la imagen no permite CORS (canvas «tainted»), no
// carga, no tiene transparencia o el margen es chico, se usa la URL original
// tal cual. Nunca rompe el logo; en el peor caso se ve como antes.
// CSP: `img-src` ya permite `data:` (next.config.ts). Supabase Storage
// responde `Access-Control-Allow-Origin: *` (verificado 2026-10-12).
//
// Descartado: recortar al subir (logo-cropper.tsx) — sólo arregla los logos
// nuevos y Exura ya está cargado; `object-view-box` — no existe en Safari.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Caja de los píxeles con alfa ≥ `alphaMin` en un buffer RGBA. null si la
 * imagen es toda transparente. Pura (test en logo-trim.test.ts).
 */
export function opaqueBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alphaMin = 12,
): Bounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] >= alphaMin) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Sólo vale la pena recortar si el dibujo ocupa < 85 % del lienzo. */
export function worthTrimming(b: Bounds, width: number, height: number): boolean {
  return (b.w * b.h) / (width * height) < 0.85;
}

/** Caja con margen (fracción del lado menor del dibujo), dentro del lienzo. */
export function padBounds(b: Bounds, width: number, height: number, pad = 0.06): Bounds {
  const p = Math.round(Math.min(b.w, b.h) * pad);
  const x = Math.max(0, b.x - p);
  const y = Math.max(0, b.y - p);
  return { x, y, w: Math.min(width, b.x + b.w + p) - x, h: Math.min(height, b.y + b.h + p) - y };
}

const cache = new Map<string, Promise<string>>();
/** Lado máximo del análisis: el alfa no necesita resolución completa. */
const PROBE = 512;
/** Lado máximo del recorte que se devuelve (data: URL liviano). */
const OUT_MAX = 640;

function trim(src: string): Promise<string> {
  const hit = cache.get(src);
  if (hit) return hit;
  const job = new Promise<string>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onerror = () => resolve(src);
    img.onload = () => {
      try {
        const { naturalWidth: W, naturalHeight: H } = img;
        if (!W || !H) return resolve(src);
        const k = Math.min(1, PROBE / Math.max(W, H));
        const pw = Math.max(1, Math.round(W * k));
        const ph = Math.max(1, Math.round(H * k));
        const probe = document.createElement('canvas');
        probe.width = pw;
        probe.height = ph;
        const pctx = probe.getContext('2d', { willReadFrequently: true });
        if (!pctx) return resolve(src);
        pctx.drawImage(img, 0, 0, pw, ph);
        const box = opaqueBounds(pctx.getImageData(0, 0, pw, ph).data, pw, ph);
        if (!box || !worthTrimming(box, pw, ph)) return resolve(src);
        const padded = padBounds(box, pw, ph);
        // De vuelta a píxeles del original.
        const sx = padded.x / k;
        const sy = padded.y / k;
        const sw = padded.w / k;
        const sh = padded.h / k;
        const o = Math.min(1, OUT_MAX / Math.max(sw, sh));
        const out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(sw * o));
        out.height = Math.max(1, Math.round(sh * o));
        const octx = out.getContext('2d');
        if (!octx) return resolve(src);
        octx.drawImage(img, sx, sy, sw, sh, 0, 0, out.width, out.height);
        resolve(out.toDataURL('image/png'));
      } catch {
        // Canvas «tainted» (sin CORS) u otro fallo: el original, como antes.
        resolve(src);
      }
    };
    img.src = src;
  });
  cache.set(src, job);
  return job;
}

/**
 * URL del logo sin su margen transparente. Mientras se calcula (o si no se
 * puede) devuelve la original. null → null.
 */
export function useTrimmedLogo(src: string | null): string | null {
  const [done, setDone] = useState<{ src: string; out: string } | null>(null);
  useEffect(() => {
    if (!src) return;
    let alive = true;
    trim(src).then((out) => {
      if (alive) setDone({ src, out });
    });
    return () => {
      alive = false;
    };
  }, [src]);
  if (!src) return null;
  return done && done.src === src ? done.out : src;
}
