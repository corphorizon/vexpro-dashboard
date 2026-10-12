import { NotFoundScreen } from '@/components/system-screen';

// LNK-04: 404 con la identidad del dashboard en vez del fallback genérico de
// Next. Server component — se renderiza para cualquier ruta inexistente.
// «Libro mayor» (2026-10-12): la vista vive en components/system-screen.tsx
// (client, para i18n y el toggle de tema); acá sólo se monta.
export default function NotFound() {
  return <NotFoundScreen />;
}
