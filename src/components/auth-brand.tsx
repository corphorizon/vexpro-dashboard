// ─────────────────────────────────────────────────────────────────────────────
// AuthBrand — logo de Smart Dashboard para las pantallas que corren ANTES de
// saber a qué empresa pertenece el visitante (login, recuperación, 2FA,
// arranque, 404/error). La marca de la empresa toma el control dentro del
// dashboard, cuando `company` carga. No hay login por subdominio: no hay
// empresa que mostrar acá (verificado 2026-10-12, sin lógica de host en
// src/app/login ni en auth-context).
//
// POR QUÉ (2026-10-12, «Libro mayor»):
//   · Antes: SVG de 420 KB (`/brand/logo-black.svg`, export de Illustrator con
//     capas ocultas) a 160 px en el login, y otro PNG distinto de 2000 px
//     (113 KB, `/smart-dashboard-dark.png`) en la pantalla de arranque. Mismo
//     dibujo, dos archivos, dos tamaños. Ahora un solo asset: el PNG de 800 px
//     (26 KB, con alfa) de /brand, que alcanza para 160 px a 3x.
//   · El tamaño lo decide quien lo usa (`className`); ya no trae `mb-6` ni
//     centrado propios: el AuthShell lo pone arriba a la izquierda en
//     escritorio y centrado en móvil.
//   · `dark:hidden` / `dark:block` cambian de ARCHIVO, no de color: es la única
//     forma de tener el logo negro/blanco sin un SVG inline de 400 KB.
//
// DESCARTADO: inline SVG con `currentColor` — el SVG exportado pesa 420 KB y
// trae capas de otra marca ocultas («Atlas»); limpiarlo es trabajo de diseño.
// ─────────────────────────────────────────────────────────────────────────────

'use client';

import { cn } from '@/lib/utils';

interface AuthBrandProps {
  /** Clases de tamaño (alto = ancho, el logo es cuadrado). Default 64 px. */
  className?: string;
  /** Texto alternativo. Vacío si al lado ya está escrito «Smart Dashboard». */
  alt?: string;
}

export function AuthBrand({ className = 'size-16', alt = 'Smart Dashboard' }: AuthBrandProps) {
  return (
    <span className={cn('relative block shrink-0', className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/logo-black.png"
        alt={alt}
        width={160}
        height={160}
        className="block size-full object-contain dark:hidden"
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/logo-white.png"
        alt={alt}
        width={160}
        height={160}
        className="hidden size-full object-contain dark:block"
      />
    </span>
  );
}
