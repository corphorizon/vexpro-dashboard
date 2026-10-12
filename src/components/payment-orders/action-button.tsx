// Ruta vieja de ActionButton. La primitiva vive desde el 2026-10-12 (barrido
// final del rediseño «Libro mayor») en `@/components/ui/action-button`: la
// usaban Riesgo, RRHH, Superadmin, Liquidez… no sólo Órdenes de pago. Este
// re-export queda para que una rama en vuelo que todavía importe de acá no se
// rompa al mergear; los imports del repo ya apuntan a la ruta nueva.
export * from '@/components/ui/action-button';
