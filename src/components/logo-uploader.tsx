'use client';

import { useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { Upload, Trash2, Loader2, AlertCircle } from 'lucide-react';
import { CompanyLogo } from './company-logo';
import { LogoCropper } from './logo-cropper';
import { DARK_BG } from '@/lib/brand-color';

// ─────────────────────────────────────────────────────────────────────────────
// LogoUploader
//
// Drag-and-drop + click-to-browse uploader for tenant logos. Talks to
// POST/DELETE /api/superadmin/companies/:id/logo. On create (no companyId yet)
// the parent can hand us an onSelectLocal callback to preview the file
// without uploading — we only upload once the entity has an id.
//
// Accepts PNG/SVG/JPG/WEBP, max 2MB. Server does authoritative validation.
//
// Antes de subir se abre el recorte (LogoCropper): los archivos llegan con
// márgenes enormes y el isotipo TIENE que ser cuadrado. Se saltea para SVG
// (rasterizar un vector es perderlo) y el modal ofrece "subir sin recortar".
//
// «Libro mayor» (2026-10-12): la vista previa oscura era `bg-slate-900` fijo
// con `text-white`; ahora es el fondo del sidebar oscuro DE ESA MARCA
// (`previewBg`, derivado en brand-preview.ts) — un logo blanco que se lee
// sobre slate puede no leerse sobre el navy de la empresa. Zona de arrastre y
// acciones con tokens (brand-ink / neg). Subida, recorte y endpoints sin cambios.
// ─────────────────────────────────────────────────────────────────────────────

const ACCEPTED = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml'];
const ACCEPT_ATTR = '.png,.jpg,.jpeg,.webp,.svg,image/*';
const MAX_BYTES = 2 * 1024 * 1024;

interface Props {
  companyId?: string | null;
  companyName: string;
  colorPrimary: string;
  logoUrl: string | null;
  onChange: (nextUrl: string | null) => void;
  /** 'color' (default, for light backgrounds), 'white' (dark surfaces like the
   *  sidebar) or 'icon' (isotipo cuadrado). Controls which column the API
   *  writes to. */
  variant?: 'color' | 'white' | 'icon';
  /** Preview background — the white logo needs a dark preview to be visible. */
  previewTone?: 'light' | 'dark';
  /** Proporción del recorte. El isotipo va cuadrado sí o sí. */
  aspect?: 'free' | 'square';
  /**
   * Fondo de la vista previa oscura (hex). Es un DATO de la marca: el sidebar
   * oscuro derivado del primario (brand-preview.ts). Sin él, el fondo
   * oscuro fijo de la app (DARK_BG de brand-color.ts).
   */
  previewBg?: string;
  /** Texto sobre `previewBg` (blanco o negro, elegido por contraste). */
  previewFg?: string;
}

export function LogoUploader({
  companyId,
  companyName,
  colorPrimary,
  logoUrl,
  onChange,
  variant = 'color',
  previewTone = 'light',
  aspect = 'free',
  previewBg = DARK_BG,
  previewFg = '#FFFFFF',
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Archivo elegido esperando recorte. Null = no hay modal abierto. */
  const [pending, setPending] = useState<File | null>(null);

  /** Valida y decide: SVG va directo, el resto pasa por el recorte. */
  const pick = (file: File) => {
    if (!companyId) {
      setError('Guarda la organización antes de subir un logo.');
      return;
    }
    if (!ACCEPTED.includes(file.type.toLowerCase()) && !/\.(png|jpe?g|webp|svg)$/i.test(file.name)) {
      setError('Solo PNG, SVG, JPG o WEBP.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('El archivo supera 2MB.');
      return;
    }
    setError(null);
    const isSvg = file.type.toLowerCase() === 'image/svg+xml' || /\.svg$/i.test(file.name);
    if (isSvg) {
      void upload(file);
      return;
    }
    setPending(file);
  };

  const upload = async (file: File) => {
    if (!companyId) {
      setError('Guarda la organización antes de subir un logo.');
      return;
    }
    if (!ACCEPTED.includes(file.type.toLowerCase()) && !/\.(png|jpe?g|webp|svg)$/i.test(file.name)) {
      setError('Solo PNG, SVG, JPG o WEBP.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('El archivo supera 2MB.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiFetch(
        `/api/superadmin/companies/${companyId}/logo?variant=${variant}`,
        { method: 'POST', body: fd },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      onChange(json.url as string);
      setPending(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error subiendo logo');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    if (!companyId) {
      onChange(null);
      return;
    }
    if (!confirm('¿Eliminar el logo actual? Se mostrarán las iniciales como fallback.')) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/superadmin/companies/${companyId}/logo?variant=${variant}`,
        { method: 'DELETE' },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      onChange(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error eliminando logo');
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) pick(file);
  };

  return (
    <div>
      <div className="flex items-start gap-3">
        <div className="shrink-0">
          {previewTone === 'dark' ? (
            // White logo preview — render on a dark surface so the logo is
            // actually visible (otherwise white-on-white = blank square).
            <div
              className="flex size-20 items-center justify-center overflow-hidden rounded-ui-md border border-border p-2"
              style={{ background: previewBg }}
            >
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoUrl} alt={companyName} className="size-full object-contain" />
              ) : (
                <span className="text-center text-[12px] opacity-70" style={{ color: previewFg }}>
                  {variant === 'icon' ? 'Sin isotipo' : 'Sin versión blanca'}
                </span>
              )}
            </div>
          ) : (
            <CompanyLogo
              name={companyName || '?'}
              logoUrl={logoUrl}
              colorPrimary={colorPrimary}
              className="size-20 border border-border"
              initialsClassName="text-xl"
            />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`rounded-ui-md border border-dashed p-3 text-center text-[13px] transition-colors motion-reduce:transition-none ${
              dragging ? 'border-solid border-brand-ink bg-brand-tint' : 'border-border-strong hover:bg-surface-hover'
            }`}
          >
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-text-2">
              <Upload aria-hidden className="size-4" />
              <span>
                Arrastrá una imagen o{' '}
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  disabled={!companyId}
                  className="font-medium text-brand-ink hover:underline disabled:cursor-not-allowed disabled:text-text-3 disabled:no-underline"
                >
                  elegí un archivo
                </button>
              </span>
            </div>
            <p className="mt-1 text-[12px] text-text-3">PNG, SVG, JPG o WEBP — máx 2MB</p>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT_ATTR}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pick(f);
                // Reset so re-selecting the same file fires onChange.
                e.target.value = '';
              }}
            />
          </div>

          <div className="mt-2 flex items-center gap-2">
            {busy && (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-text-2">
                <Loader2 aria-hidden className="size-3.5 animate-spin" /> Procesando…
              </span>
            )}
            {logoUrl && !busy && (
              <button
                type="button"
                onClick={handleRemove}
                className="inline-flex items-center gap-1.5 text-[12px] font-medium text-neg hover:underline"
              >
                <Trash2 aria-hidden className="size-3.5" /> Quitar logo
              </button>
            )}
          </div>
        </div>
      </div>

      {!companyId && (
        <p className="mt-2 text-[12px] text-text-3">Podrás subir el logo después de crear la organización.</p>
      )}

      {error && (
        <div role="alert" className="mt-2 flex items-start gap-1.5 text-[12px] text-neg">
          <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {pending && (
        <LogoCropper
          file={pending}
          aspect={aspect}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={(cropped) => void upload(cropped)}
          onUseOriginal={() => void upload(pending)}
        />
      )}
    </div>
  );
}
