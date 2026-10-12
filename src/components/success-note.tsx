import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// SuccessNote — confirmación breve de una acción que salió bien («Libro
// mayor», 2026-10-12, tanda de Usuarios / Perfil).
//
// POR QUÉ: `Notice` (ui/notice.tsx) no tiene variante `ok` a propósito («todo
// bien» de un DATO no necesita banner). Pero «contraseña actualizada» no es
// estado del dato: es el acuse de una acción que la persona acaba de pedir, y
// sin él no sabe si el clic hizo algo. Socios lo resolvió con un div local;
// acá se repetía en tres lugares (perfil ×2, usuarios), así que vive una vez.
// Receta: `pos-bg` + borde `pos` al 35 % + ícono `pos`, texto `foreground`
// (igual que el banner, para que el texto no dependa del verde).
// ─────────────────────────────────────────────────────────────────────────────

export function SuccessNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-start gap-2 rounded-ui-md border border-pos/35 bg-pos-bg px-3.5 py-2.5 text-[13px] font-medium leading-5 text-foreground',
        className,
      )}
    >
      <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-pos" strokeWidth={2} />
      <span className="min-w-0">{children}</span>
    </div>
  );
}
