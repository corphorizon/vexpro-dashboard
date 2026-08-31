-- ═════════════════════════════════════════════════════════════════════════════
-- FairPay · conciliación del monto en USD.   NO APLICAR SIN LEER ESTA CABECERA.
--
-- Este archivo NO es una migración. Es (1) el informe que desarma la hipótesis
-- de la que nació y (2) el ensayo, listo pero SIN CORRER, de la corrección que
-- sí hace falta. La decide Kevin: la que se pidió el 2026-08-31 estaba basada
-- en un hecho que no es cierto.
--
-- ── LA HIPÓTESIS QUE SE PIDIÓ CORREGIR ─────────────────────────────────────
-- «`api_transactions` de FairPay suma montos en COP/MXN/CLP/CRC/PEN/BRL a valor
--  nominal como si fueran USD; de los $70.250,60 «Completed» sólo $9.798,44 son
--  USD reales, la fila está inflada ~$60.450.»
--
-- ── POR QUÉ NO ES CIERTA (medido contra producción el 2026-08-31) ──────────
-- El fetcher guarda `amount_usd` de la API de FairPay, NO `amount`
-- (src/lib/api-integrations/fairpay/transactions.ts:171). La columna `currency`
-- es el RAIL de pago local; el importe ya viene en dólares. Tres mediciones
-- independientes lo confirman:
--
--   1. Las magnitudes. Las 204 filas Completed en COP suman $41.216,60, con
--      mediana $94,80. Si fueran pesos colombianos nominales, la mediana de un
--      depósito sería de 3 centavos de dólar. Los mínimos de TODAS las monedas
--      son 10,40 — que es un depósito de $10 con el 4% que FairPay agrega.
--
--   2. El cruce con el CRM. 1.142 de las 1.225 filas (93,2%) cruzan contra
--      `crm_deposits` por `raw->>'depositId'`. En 694 de ellas el importe
--      guardado es EXACTAMENTE `crm_deposits.deposit_value × 1,04`, y el resto
--      cae entre 1,01 y 1,24 (redondeos sobre importes chicos). Si el importe
--      fuera COP nominal, ese ratio sería ~4.000, no 1,04.
--
--   3. Los estados coinciden. De las 402 filas Completed que cruzan, 401 están
--      `completed` en el CRM. No hay dos poblaciones distintas mezcladas.
--
-- Convertir por tasa de cambio DIVIDIRÍA por 4.000 un importe que ya está en
-- dólares. Sería exactamente el modo de falla que este repo persigue: un número
-- plausible y equivocado, esta vez introducido a propósito.
--
-- ── LO QUE SÍ ESTÁ MAL, Y ES CHICO ─────────────────────────────────────────
-- FairPay informa el importe con un ~4% de recargo que el cliente paga pero que
-- NUNCA se acredita en su billetera. Lo acreditado está en
-- `crm_deposits.amount_paid`. Sobre las filas Completed:
--
--     mes        api_transactions   CRM acreditado      delta   período
--     2026-04         4.313,72         4.145,41       -168,31   CERRADO
--     2026-05         9.547,00         9.165,99       -381,01   CERRADO
--     2026-06        20.821,00        20.068,25       -752,75   CERRADO  (*)
--     2026-07        29.089,68        27.828,97     -1.260,71   abierto
--     2026-08         6.479,20         6.047,15       -432,05   abierto
--     ─────────────────────────────────────────────────────────────────────
--     TOTAL          70.250,60        67.255,77     -2.994,83
--
--     (*) 2026-06 tiene 24 filas Completed por $4.383,00 SIN cruce en el CRM.
--         Esas NO se tocan: quedan con su importe actual. `null` no es 0 y un
--         cruce que falta no autoriza a inventar un número. Son las únicas
--         Completed sin cruce de toda la serie.
--
-- Impacto sobre lo YA DISTRIBUIDO: los tres meses cerrados suman -$1.302,07.
-- Nada de eso se toca — el cierre congela los insumos y son inmutables por
-- trigger. Lo que cambiaría es la serie viva de julio y agosto: -$1.692,76.
--
-- Consumidores del monto de FairPay, todos leen `api_transactions.amount`:
-- `loadPersistedTotals` (Movimientos / Resumen General, filtra a 'Completed'),
-- las RPC `get_period_totals_by_month` y `get_channel_day_movements`, el libro
-- del canal (`channel_ledger`, vía `balance_delta`) y los reportes por correo.
-- Pisar `amount` los corrige a todos a la vez; agregar `amount_usd` obligaría a
-- tocar los cinco y dejaría dos columnas que se desincronizan en silencio, que
-- es el modo de falla número uno de este repo. Por eso el ensayo pisa `amount`.
--
-- OJO — el libro del canal (migración 108) NO se recalcula solo. Si esto se
-- aplica, hay que volver a correr `scripts/backfill-channel-ledger.ts` para los
-- meses tocados, o el libro y los totales dirán cosas distintas.
-- ═════════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────────
-- PARTE 1 — INFORME (sólo lectura, se puede correr en producción sin miedo)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1.a  Cobertura del cruce: cuántas filas cruzan y cuánto queda sin convertir.
select
  t.status,
  count(*)                                                        filas,
  count(*) filter (where d.id is null)                            sin_cruce,
  round(sum(t.amount), 2)                                         monto_actual,
  round(sum(t.amount) filter (where d.id is null), 2)             monto_sin_cruce,
  round(sum(d.amount_paid), 2)                                    crm_acreditado
from api_transactions t
left join crm_deposits d
       on d.company_id = t.company_id
      and d.raw->>'depositId' = t.external_id
where t.provider = 'fairpay'
group by 1
order by 1;

-- 1.b  Conciliación vieja → nueva, por mes, SÓLO sobre lo que cuenta
--      ('Completed' es el único estado que suma en loadPersistedTotals).
--      Es una SIMULACIÓN: no escribe nada.
select
  to_char(t.transaction_date, 'YYYY-MM')                                   mes,
  count(*)                                                                 filas,
  count(*) filter (where d.id is null)                                     sin_cruce,
  round(sum(t.amount), 2)                                                  suma_vieja,
  round(sum(coalesce(d.amount_paid, t.amount)), 2)                         suma_nueva,
  round(sum(coalesce(d.amount_paid, t.amount)) - sum(t.amount), 2)         delta
from api_transactions t
left join crm_deposits d
       on d.company_id = t.company_id
      and d.raw->>'depositId' = t.external_id
where t.provider = 'fairpay'
  and t.status = 'Completed'
group by 1
order by 1;

-- 1.c  Las filas SIN cruce posible, una por una. Se listan, no se cuentan
--      nada más: una exclusión silenciosa es indistinguible de un cruce roto.
select t.external_id, t.currency, t.status, t.amount, t.transaction_date
from api_transactions t
left join crm_deposits d
       on d.company_id = t.company_id
      and d.raw->>'depositId' = t.external_id
where t.provider = 'fairpay'
  and t.status = 'Completed'
  and d.id is null
order by t.transaction_date;

-- 1.d  El control que desarma la hipótesis del cambio de moneda: el ratio
--      entre lo guardado y lo que dice el CRM. Si el importe fuera moneda
--      local, acá saldrían miles. Sale 1,04.
select
  round(t.amount / nullif(d.deposit_value, 0), 4) ratio,
  count(*) filas
from api_transactions t
join crm_deposits d
  on d.company_id = t.company_id
 and d.raw->>'depositId' = t.external_id
where t.provider = 'fairpay'
group by 1
order by filas desc
limit 10;


-- ─────────────────────────────────────────────────────────────────────────────
-- PARTE 2 — ENSAYO DE LA CORRECCIÓN.   NO SE CORRIÓ EN PRODUCCIÓN.
--
-- Está comentado a propósito: el `ROLLBACK` protege sólo si el bloque entero
-- llega junto al servidor, y ejecutarlo por partes desde una herramienta que
-- corta las sentencias dejaría el UPDATE confirmado. Se descomenta y se pega
-- ENTERO en psql, o no se corre.
--
-- El filtro es simétrico y server-authoritative (regla de la migración 079):
-- las mismas condiciones del WHERE en la simulación y en el UPDATE.
-- ─────────────────────────────────────────────────────────────────────────────

-- BEGIN;
--
-- create temporary table _fp_antes on commit drop as
-- select to_char(transaction_date,'YYYY-MM') mes,
--        count(*) filas, round(sum(amount),2) suma
--   from api_transactions
--  where provider = 'fairpay' and status = 'Completed'
--  group by 1;
--
-- update api_transactions t
--    set amount = d.amount_paid
--   from crm_deposits d
--  where t.provider   = 'fairpay'
--    and t.status     = 'Completed'
--    and d.company_id = t.company_id
--    and d.raw->>'depositId' = t.external_id
--    -- `amount_paid` nulo o 0 en una fila Completed sería un dato roto del
--    -- CRM: no se pisa un importe bueno con un cero.
--    and d.amount_paid is not null
--    and d.amount_paid > 0
--    and abs(t.amount - d.amount_paid) > 0.005;
--
-- select a.mes, a.filas, a.suma suma_vieja,
--        round(sum(t.amount),2) suma_nueva,
--        round(sum(t.amount) - a.suma, 2) delta
--   from _fp_antes a
--   join api_transactions t
--     on t.provider = 'fairpay' and t.status = 'Completed'
--    and to_char(t.transaction_date,'YYYY-MM') = a.mes
--  group by a.mes, a.filas, a.suma
--  order by a.mes;
--
-- ROLLBACK;
