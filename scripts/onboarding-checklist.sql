-- ───────────────────────────────────────────────────────────────────────────
-- Check List Onboarding — estado del proceso de contratación por comercial.
-- Correr en Supabase → SQL Editor.
--
-- Una fila por (empresa, perfil comercial). Los 5 booleanos son el checklist
-- (Propuesta, Acepto propuesta, Contrato, Acepto contrato, Accesos).
-- salario_fijo / sponsor son OVERRIDES opcionales: si quedan en NULL, la UI
-- muestra el salario y el HEAD del perfil; si se editan, guardan el override.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists onboarding_checklist (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id) on delete cascade,
  profile_id        uuid not null references commercial_profiles(id) on delete cascade,
  propuesta         boolean not null default false,
  acepto_propuesta  boolean not null default false,
  contrato          boolean not null default false,
  acepto_contrato   boolean not null default false,
  accesos           boolean not null default false,
  salario_fijo      numeric,       -- override; NULL = usar salary del perfil
  sponsor           text,          -- override; NULL = usar HEAD del perfil
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (company_id, profile_id)
);

create index if not exists onboarding_checklist_company_idx
  on onboarding_checklist (company_id);

-- El acceso es exclusivamente vía la API interna (service_role, que bypassa
-- RLS). Habilitamos RLS sin políticas para bloquear lectura directa anon/auth.
alter table onboarding_checklist enable row level security;
