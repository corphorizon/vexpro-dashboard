import Link from 'next/link';

// LNK-04: 404 con la identidad del dashboard en vez del fallback genérico de
// Next. Server component — se renderiza para cualquier ruta inexistente.
export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="max-w-md w-full text-center rounded-2xl border border-border bg-card p-8 shadow-sm">
        <p className="text-5xl font-bold text-[var(--color-primary)] tabular-nums">404</p>
        <h1 className="mt-3 text-lg font-semibold text-foreground">Página no encontrada</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          La página que buscás no existe o fue movida.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex items-center justify-center rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
        >
          Volver al inicio
        </Link>
      </div>
    </div>
  );
}
