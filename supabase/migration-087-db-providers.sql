-- Migración 087 — proveedores de base de datos por tenant (APLICADA).
--
-- Cada organización broker puede cargar los accesos SQL de SU MetaTrader 5
-- (réplica del Backup Server: MySQL/MariaDB/MSSQL/Postgres) y los de SU CRM
-- (Orion sobre MongoDB). Misma mecánica que las pasarelas: fila cifrada por
-- (company_id, provider) en api_credentials.
--   · mt5_sql     → secreto = JSON {engine, host, port, database, user, password}
--   · orion_mongo → secreto = connection string mongodb:// completa (+ database
--                   en extra_config si no va en la URI)
-- Exigencia: usuarios de SOLO LECTURA — el probe del superadmin lo verifica.
ALTER TABLE public.api_credentials DROP CONSTRAINT IF EXISTS api_credentials_provider_check;
ALTER TABLE public.api_credentials ADD CONSTRAINT api_credentials_provider_check
  CHECK (provider = ANY (ARRAY['sendgrid','coinsbuy','unipayment','fairpay','fairpay_banking','orion_crm','paypros','mt5_sql','orion_mongo']));
