-- Migración 075 — Índice por unidad en location_business_units
--
-- La 071 dejó un solo índice: (company_id, channel_key). Sirve para la
-- pregunta "quiénes son dueños de ESTA ubicación", que es la que hace la
-- pantalla de clasificación. Pero la consulta natural del libro por unidad es
-- la inversa —"qué ubicaciones tiene ESTA unidad y en qué proporción"— y con
-- el índice existente no hay por dónde entrar: filtrar por business_unit_id
-- obliga a recorrer todas las filas de la empresa.
--
-- Hoy se nota poco porque son pocas ubicaciones por empresa; se nota cuando el
-- reporte por unidad corre para todas las unidades y repite el escaneo una vez
-- por unidad. Un índice compuesto es más barato que descubrirlo después.
--
-- No reemplaza al de la 071: las dos consultas existen y cada una quiere su
-- orden de columnas.

create index if not exists location_business_units_unit_idx
  on public.location_business_units (company_id, business_unit_id);

comment on index public.location_business_units_unit_idx is
  'Libro/desglose por unidad de negocio: filtra por unidad, no por channel_key.';
