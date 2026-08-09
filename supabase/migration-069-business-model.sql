-- Migración 069 — Modelo de negocio por empresa
--
-- No todas las empresas del dashboard son brokers. Horizon es una consultora:
-- factura servicios, no tiene depósitos de clientes ni retiros, no necesita
-- gestión de riesgo, y en RRHH solo lleva la ficha de empleados (no hay
-- equipo comercial con comisiones ni rebates de IB).
--
-- Mostrarle esas pantallas vacías no es solo ruido: invita a cargar datos
-- donde no corresponde y ensucia la cadena de distribución.
--
-- El default es 'broker' A PROPÓSITO — todo lo que existía antes de esta
-- distinción opera cuentas de clientes, y una migración no puede cambiar en
-- silencio lo que esas empresas ven.
--
-- Qué apaga cada modelo vive en src/lib/business-model.ts, no acá: la base
-- guarda el modelo, el registro decide qué implica.

alter table public.companies
  add column if not exists business_model text not null default 'broker';

alter table public.companies
  drop constraint if exists companies_business_model_check;
alter table public.companies
  add constraint companies_business_model_check
  check (business_model in ('broker', 'company'));

comment on column public.companies.business_model is
  'broker = depositos/retiros/P&L de clientes. company = factura servicios (Horizon). Registro en src/lib/business-model.ts.';

update public.companies set business_model = 'company' where name = 'Horizon';
