-- Migración 072 — Isotipo (logo cuadrado) por empresa
--
-- El sidebar contraído mide 64px: el logo horizontal no entra y, cuando la
-- empresa sube una versión blanca, lo que se ve arriba del rail es un cuadrado
-- en blanco. Un logo ancho no se puede "recortar" a cuadrado con CSS sin
-- inventar el encuadre, así que la marca compacta es un archivo aparte.
--
-- Tercer slot, no reemplazo: los tres conviven y cada uno tiene su superficie.
--   · logo_url        → fondos claros (login, reportes, emails, PDFs)
--   · logo_url_white  → fondos oscuros y anchos (cabecera del sidebar)
--   · logo_icon_url   → isotipo cuadrado (sidebar contraído, favicon a futuro)
--
-- Nullable a propósito: sin isotipo el sidebar sigue mostrando la inicial de
-- la empresa, que es el comportamiento actual y no rompe a nadie.

alter table public.companies
  add column if not exists logo_icon_url text;

comment on column public.companies.logo_icon_url is
  'Isotipo cuadrado para superficies angostas (sidebar contraído). Null = se usa la inicial del nombre.';
