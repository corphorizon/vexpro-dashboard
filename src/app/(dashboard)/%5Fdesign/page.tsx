import { notFound } from 'next/navigation';
import { DesignShowcase } from './showcase';

// ─────────────────────────────────────────────────────────────────────────────
// /_design — muestra de las primitivas «Libro mayor», SÓLO en desarrollo.
//
// La carpeta se llama `%5Fdesign` y no `_design` a propósito: en el App Router
// una carpeta que empieza con `_` es PRIVADA (queda fuera del ruteo, ver
// node_modules/next/dist/docs/01-app/01-getting-started/02-project-structure.md
// «Private folders»), así que `_design/page.tsx` nunca se podría abrir. `%5F`
// es el `_` codificado: la URL queda `/_design`.
//
// En producción responde 404 (`notFound()`): la página usa datos inventados y
// no tiene guardián de módulo. No aparece en el menú.
// ─────────────────────────────────────────────────────────────────────────────

export default function DesignPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <DesignShowcase />;
}
