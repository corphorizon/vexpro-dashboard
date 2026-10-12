'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, X, ZoomIn } from 'lucide-react';
import { ActionButton } from '@/components/ui/action-button';

// ─────────────────────────────────────────────────────────────────────────────
// LogoCropper — recorte previo a la subida, con canvas y sin dependencias.
//
// POR QUÉ: los logos llegan con márgenes gigantes o en el encuadre equivocado,
// y el sidebar contraído necesita un isotipo CUADRADO. Recortar del lado del
// servidor obligaría a meter una librería de imágenes; el canvas del navegador
// ya sabe hacerlo y el archivo viaja liviano.
//
// Se exporta SIEMPRE a PNG y sin pintar el fondo: así un logo con transparencia
// la conserva (pintar blanco dejaría un recuadro visible sobre el slate del
// sidebar).
//
// Los SVG no pasan por acá — rasterizarlos sería perder el vector. El uploader
// los sube tal cual.
//
// «Libro mayor» (2026-10-12): modal con shadow-3 / rounded-ui-xl, botones con
// ActionButton (el primario ya no arma `bg-[var(--color-primary)]` a mano) y
// damero sobre `surface-2`. Recorte y exportación sin cambios.
// ─────────────────────────────────────────────────────────────────────────────

/** Lado del recorte cuadrado en pantalla. */
const SQUARE_VIEW = 288;
/** Ancho del recorte libre en pantalla. */
const FREE_VIEW_W = 320;
/** Alto máximo/mínimo del recorte libre — evita marcos absurdos. */
const FREE_VIEW_H_MAX = 260;
const FREE_VIEW_H_MIN = 120;
/** Lado mayor del PNG exportado. Suficiente para retina sin inflar el archivo. */
const OUTPUT_MAX = 512;

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;

interface Props {
  file: File;
  /** 'square' fuerza 1:1 (isotipo); 'free' respeta la proporción del archivo. */
  aspect: 'free' | 'square';
  onCancel: () => void;
  /** Devuelve el PNG recortado, listo para subir. */
  onConfirm: (file: File) => void;
  /** Subir el archivo original sin recortar. */
  onUseOriginal: () => void;
  busy?: boolean;
}

export function LogoCropper({ file, aspect, onCancel, onConfirm, onUseOriginal, busy }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState({ w: SQUARE_VIEW, h: SQUARE_VIEW });
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  /** Zoom que hace entrar la imagen completa: el 100% del slider. */
  const [fitZoom, setFitZoom] = useState(1);

  // Carga la imagen y calcula el encuadre inicial: entera y centrada, que es
  // el estado que el admin espera ver al abrir (no un recorte sorpresa).
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const vw = aspect === 'square' ? SQUARE_VIEW : FREE_VIEW_W;
      const natural = img.naturalHeight / Math.max(1, img.naturalWidth);
      const vh =
        aspect === 'square'
          ? SQUARE_VIEW
          : Math.round(Math.min(FREE_VIEW_H_MAX, Math.max(FREE_VIEW_H_MIN, vw * natural)));
      const fit = Math.min(vw / img.naturalWidth, vh / img.naturalHeight);
      imgRef.current = img;
      setView({ w: vw, h: vh });
      setFitZoom(fit);
      setZoom(fit);
      setOffset({
        x: (vw - img.naturalWidth * fit) / 2,
        y: (vh - img.naturalHeight * fit) / 2,
      });
      setReady(true);
    };
    img.onerror = () => setError('No se pudo leer la imagen.');
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file, aspect]);

  /** Pinta el marco visible. Sin fillRect: el fondo transparente se ve. */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    canvas.width = view.w * dpr;
    canvas.height = view.h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, view.w, view.h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, offset.x, offset.y, img.naturalWidth * zoom, img.naturalHeight * zoom);
  }, [view, offset, zoom]);

  useEffect(() => {
    if (ready) draw();
  }, [ready, draw]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const start = dragRef.current;
    if (!start) return;
    setOffset({ x: e.clientX - start.x, y: e.clientY - start.y });
  };
  const endDrag = () => {
    dragRef.current = null;
  };

  /** Zoom con la rueda anclado al puntero: si no, la imagen se escapa. */
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const img = imgRef.current;
    if (!img) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const next = clamp(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), fitZoom * MIN_ZOOM, fitZoom * MAX_ZOOM);
    const k = next / zoom;
    setOffset({ x: px - (px - offset.x) * k, y: py - (py - offset.y) * k });
    setZoom(next);
  };

  /** Zoom del slider: ancla el centro del marco. */
  const setZoomFromSlider = (pct: number) => {
    const next = clamp((pct / 100) * fitZoom, fitZoom * MIN_ZOOM, fitZoom * MAX_ZOOM);
    const k = next / zoom;
    const cx = view.w / 2;
    const cy = view.h / 2;
    setOffset({ x: cx - (cx - offset.x) * k, y: cy - (cy - offset.y) * k });
    setZoom(next);
  };

  const confirm = () => {
    const img = imgRef.current;
    if (!img) return;
    // Se re-dibuja a resolución de salida desde la imagen original (no se
    // escala el canvas de pantalla), así el PNG no sale pixelado.
    const factor = OUTPUT_MAX / Math.max(view.w, view.h);
    const out = document.createElement('canvas');
    out.width = Math.round(view.w * factor);
    out.height = Math.round(view.h * factor);
    const ctx = out.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      img,
      offset.x * factor,
      offset.y * factor,
      img.naturalWidth * zoom * factor,
      img.naturalHeight * zoom * factor,
    );
    out.toBlob((blob) => {
      if (!blob) {
        setError('No se pudo generar el recorte.');
        return;
      }
      const name = file.name.replace(/\.[^.]+$/, '') || 'logo';
      onConfirm(new File([blob], `${name}.png`, { type: 'image/png' }));
    }, 'image/png');
  };

  const zoomPct = Math.round((zoom / fitZoom) * 100);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Recortar imagen"
    >
      <div className="w-full max-w-md rounded-ui-xl border border-border bg-card p-4 text-foreground shadow-3 vex-pop-in">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[15px] font-semibold">
            {aspect === 'square' ? 'Recortar isotipo (1:1)' : 'Recortar logo'}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cerrar"
            className="-mr-2 flex size-10 items-center justify-center rounded-ui-md text-text-2 hover:bg-surface-hover hover:text-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error ? (
          <p role="alert" className="py-6 text-center text-[13px] text-neg">{error}</p>
        ) : (
          <>
            {/* Damero: sin él, un PNG transparente parece un recuadro vacío. */}
            <div
              className="mx-auto overflow-hidden rounded-ui-md border border-border"
              style={{
                width: view.w,
                height: view.h,
                backgroundImage:
                  'linear-gradient(45deg, var(--surface-2) 25%, transparent 25%), linear-gradient(-45deg, var(--surface-2) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--surface-2) 75%), linear-gradient(-45deg, transparent 75%, var(--surface-2) 75%)',
                backgroundSize: '16px 16px',
                backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
              }}
            >
              <canvas
                ref={canvasRef}
                style={{ width: view.w, height: view.h, touchAction: 'none' }}
                className="cursor-grab active:cursor-grabbing"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onWheel={onWheel}
              />
            </div>

            <div className="flex items-center gap-3 mt-3">
              <ZoomIn aria-hidden className="size-4 shrink-0 text-text-3" />
              <input
                type="range"
                min={MIN_ZOOM * 100}
                max={MAX_ZOOM * 100}
                value={zoomPct}
                aria-label="Zoom"
                onChange={(e) => setZoomFromSlider(Number(e.target.value))}
                className="h-11 flex-1 cursor-pointer accent-brand-ink"
              />
              <span className="num w-12 text-right text-[12px] tabular-nums text-text-2">
                {zoomPct}%
              </span>
            </div>

            <p className="mt-1 text-[12px] text-text-3">
              Arrastrá la imagen para encuadrarla y usá la rueda o el control para acercar.
              El fondo transparente se conserva.
            </p>

            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <ActionButton variant="ghost" onClick={onUseOriginal} disabled={busy}>
                Subir sin recortar
              </ActionButton>
              <ActionButton variant="secondary" onClick={onCancel} disabled={busy}>
                Cancelar
              </ActionButton>
              <ActionButton variant="primary" onClick={confirm} disabled={busy || !ready}>
                <Check aria-hidden className="size-4" /> Recortar y subir
              </ActionButton>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
