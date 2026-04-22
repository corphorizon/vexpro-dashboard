'use client';

import { useRef, useState } from 'react';
import { Upload, Trash2, Loader2, AlertCircle } from 'lucide-react';
import { CompanyLogo } from './company-logo';

// ─────────────────────────────────────────────────────────────────────────────
// LogoUploader
//
// Drag-and-drop + click-to-browse uploader for tenant logos. Talks to
// POST/DELETE /api/superadmin/companies/:id/logo. On create (no companyId yet)
// the parent can hand us an onSelectLocal callback to preview the file
// without uploading — we only upload once the entity has an id.
//
// Accepts PNG/SVG/JPG/WEBP, max 2MB. Server does authoritative validation.
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
  /** 'color' (default, for light backgrounds) or 'white' (for dark surfaces
   *  like the sidebar). Controls which column the API writes to. */
  variant?: 'color' | 'white';
  /** Preview background — the white logo needs a dark preview to be visible. */
  previewTone?: 'light' | 'dark';
}

export function LogoUploader({
  companyId,
  companyName,
  colorPrimary,
  logoUrl,
  onChange,
  variant = 'color',
  previewTone = 'light',
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const res = await fetch(
        `/api/superadmin/companies/${companyId}/logo?variant=${variant}`,
        { method: 'POST', body: fd },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      onChange(json.url as string);
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
      const res = await fetch(
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
    if (file) void upload(file);
  };

  return (
    <div>
      <div className="flex items-start gap-4">
        <div className="shrink-0">
          {previewTone === 'dark' ? (
            // White logo preview — render on a dark surface so the logo is
            // actually visible (otherwise white-on-white = blank square).
            <div className="w-20 h-20 rounded-md bg-slate-900 flex items-center justify-center overflow-hidden p-2">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoUrl} alt={companyName} className="w-full h-full object-contain" />
              ) : (
                <span className="text-white text-xs text-center opacity-60">
                  Versión blanca
                </span>
              )}
            </div>
          ) : (
            <CompanyLogo
              name={companyName || '?'}
              logoUrl={logoUrl}
              colorPrimary={colorPrimary}
              className="w-20 h-20"
              initialsClassName="text-xl"
            />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`rounded-lg border-2 border-dashed p-4 text-center text-sm transition-colors ${
              dragging
                ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5'
                : 'border-border hover:bg-muted/50'
            }`}
          >
            <div className="flex items-center justify-center gap-2 text-muted-foreground">
              <Upload className="w-4 h-4" />
              <span>
                Arrastra una imagen aquí o{' '}
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="text-[var(--color-primary)] hover:underline font-medium"
                >
                  elige un archivo
                </button>
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              PNG, SVG, JPG o WEBP — máx 2MB
            </p>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT_ATTR}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                // Reset so re-selecting the same file fires onChange.
                e.target.value = '';
              }}
            />
          </div>

          <div className="mt-2 flex items-center gap-2">
            {busy && (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Procesando…
              </span>
            )}
            {logoUrl && !busy && (
              <button
                type="button"
                onClick={handleRemove}
                className="inline-flex items-center gap-1.5 text-xs text-red-700 dark:text-red-400 hover:underline"
              >
                <Trash2 className="w-3.5 h-3.5" /> Quitar logo
              </button>
            )}
          </div>
        </div>
      </div>

      {!companyId && (
        <p className="text-xs text-muted-foreground mt-2">
          Podrás subir el logo después de crear la organización.
        </p>
      )}

      {error && (
        <div className="mt-2 flex items-start gap-2 text-xs text-red-700 dark:text-red-400">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
