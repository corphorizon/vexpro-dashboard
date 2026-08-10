-- Migración 073 — El primer detalle de ingresos ya no pisa el "Otros ingresos" manual
--
-- EL BUG (auditoría 2026-08, A4)
-- `replace_income_lines` (migración 068) cierra con:
--     on conflict (company_id, period_id)
--       do update set other = excluded.other
-- o sea: el total de las líneas REEMPLAZA `operating_income.other`. Eso es
-- correcto una vez que el período se opera con líneas —el total tiene que ser
-- derivado, no editable por separado— pero es destructivo en la PRIMERA carga.
--
-- Caso real: un broker que viene cargando `other = 5.000` a mano en /upload
-- agrega su primera línea de detalle de $100. La RPC borra (no hay nada que
-- borrar), inserta la línea, suma lo cobrado = 100, y pisa other: 5.000 → 100.
-- Se evaporan $4.900 de ingreso real, y con ellos la base distribuible del mes:
-- la cadena de socios reparte sobre un número que nadie escribió.
--
-- LA CORRECCIÓN
-- Si el período NO tenía ni una línea previa y `operating_income.other > 0`,
-- ese monto es ingreso CARGADO A MANO que todavía no está representado en
-- ninguna línea. Antes de insertar el detalle nuevo se lo convierte en una
-- línea más — 'Otros ingresos (histórico)' con sort_order -1, así queda
-- primera y visiblemente distinta— y a partir de ahí el total derivado vuelve
-- a dar exactamente lo mismo que antes de la migración. No se pierde plata y
-- no hay dos fuentes de verdad: el monto manual pasa a ser detalle.
--
-- Por qué SOLO en la primera carga: si el período ya tenía líneas, `other` ES
-- el total derivado de esas líneas. Preservarlo entonces duplicaría cada
-- guardado (el total viejo entraría como línea y se volvería a sumar), que es
-- justo el error contrario.
--
-- amount = received = el monto manual (y pending = 0): lo que estaba cargado
-- en `other` era, por definición, plata ya COBRADA — es lo que la cadena venía
-- repartiendo. Registrarlo como facturado-y-no-cobrado cambiaría el reparto.
--
-- El resto de la función es idéntico a la 068.

create or replace function public.replace_income_lines(
  p_company_id uuid,
  p_period_id  uuid,
  p_lines      jsonb
) returns numeric language plpgsql set search_path = public as $$
declare
  v_received     numeric(14,2);
  v_had_lines    boolean;
  v_manual_other numeric(14,2);
begin
  -- Estado ANTES de tocar nada: si se lee después del delete, "tenía líneas"
  -- siempre daría falso y el monto manual se preservaría en cada guardado.
  select exists (
    select 1 from public.income_lines
     where company_id = p_company_id and period_id = p_period_id
  ) into v_had_lines;

  select coalesce(other, 0) into v_manual_other
    from public.operating_income
   where company_id = p_company_id and period_id = p_period_id;

  delete from public.income_lines
   where company_id = p_company_id and period_id = p_period_id;

  -- Primera carga de detalle sobre un período con "otros ingresos" manual:
  -- ese monto se convierte en línea en vez de desaparecer.
  if not v_had_lines and coalesce(v_manual_other, 0) > 0 then
    insert into public.income_lines (
      company_id, period_id, concept, amount, received, pending, sort_order
    ) values (
      p_company_id, p_period_id, 'Otros ingresos (histórico)',
      v_manual_other, v_manual_other, 0, -1
    );
  end if;

  insert into public.income_lines (
    company_id, period_id, concept, client, amount, received, pending,
    category, reference, income_date, sort_order
  )
  select p_company_id, p_period_id,
         coalesce(r->>'concept', ''),
         nullif(r->>'client', ''),
         coalesce((r->>'amount')::numeric, 0),
         coalesce((r->>'received')::numeric, 0),
         coalesce((r->>'pending')::numeric, 0),
         nullif(r->>'category', ''),
         nullif(r->>'reference', ''),
         nullif(r->>'income_date', '')::date,
         coalesce((r->>'sort_order')::int, 0)
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as r
   where coalesce(r->>'concept', '') <> '';

  select coalesce(sum(received), 0) into v_received
    from public.income_lines
   where company_id = p_company_id and period_id = p_period_id;

  insert into public.operating_income (company_id, period_id, other)
  values (p_company_id, p_period_id, v_received)
  on conflict (company_id, period_id)
    do update set other = excluded.other, updated_at = now();

  return v_received;
end; $$;

comment on function public.replace_income_lines(uuid, uuid, jsonb) is
  'Reemplaza el detalle de ingresos del período y materializa lo COBRADO en operating_income.other. En la PRIMERA carga preserva el "other" manual previo como línea "Otros ingresos (histórico)" (migración 073) para no borrar ingreso ya cargado a mano.';
