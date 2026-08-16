-- ---------------------------------------------------------------------------
-- Migration 081 — paypros_webhook_events
--
-- POR QUÉ EXISTE ESTA TABLA (y por qué guarda el body CRUDO):
--
-- Pay-Pros es un proveedor PUSH puro. No tiene endpoint de listado ni de
-- consulta de transacciones: la ÚNICA forma de enterarse de un depósito es
-- la notificación que ellos nos POSTean. Si perdemos un aviso —bug de
-- parseo, cambio de formato, deploy a mitad de camino, firma que no
-- valida— NO HAY API PARA RECUPERARLO. La plata simplemente no existe
-- para el dashboard.
--
-- Por eso el handler guarda acá el POST entero ANTES de procesarlo, tal
-- cual llegó (texto plano, sin normalizar). Es el respaldo del que se
-- puede reprocesar a mano, y también la evidencia forense cuando alguien
-- empieza a mandarnos firmas inválidas.
--
-- Idempotencia de ENTREGA: UNIQUE (company_id, notify_reference).
-- `notifyReference` es el id único de la notificación del lado de Pay-Pros,
-- así que un reintento suyo choca contra el índice y el handler responde
-- el mismo ingoing OK sin volver a tocar api_transactions. (La idempotencia
-- de DATOS es aparte: el upsert sobre api_transactions va por
-- company_id + provider + external_id = uid.)
--
-- Además: api_credentials.provider tiene un CHECK con la lista de proveedores
-- (migr. 016, ampliado en la 033). Sin sumar 'paypros' el upsert de la
-- credencial revienta en la DB aunque el código lo acepte.
-- ---------------------------------------------------------------------------

BEGIN;

-- 0. Habilitar 'paypros' como proveedor de credenciales.
ALTER TABLE public.api_credentials DROP CONSTRAINT IF EXISTS api_credentials_provider_check;
ALTER TABLE public.api_credentials ADD CONSTRAINT api_credentials_provider_check
  CHECK (provider = ANY (ARRAY['sendgrid','coinsbuy','unipayment','fairpay','orion_crm','paypros']));

CREATE TABLE IF NOT EXISTS public.paypros_webhook_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  received_at       timestamptz NOT NULL DEFAULT now(),
  -- Body tal cual llegó: 'datetime&notifyReference&uid&amount&currencyCode&status&signature'.
  raw_body          text NOT NULL,
  -- x-forwarded-for / x-real-ip del POST. Sin sesión que auditar, la IP es
  -- lo único que tenemos para correlacionar un flood de firmas inválidas.
  remote_ip         text,
  -- NULL mientras no se pudo ni parsear el body; true/false una vez verificada.
  signature_valid   boolean,
  -- Extraídos del body SOLO si parseó. NULL = body ilegible (igual se guarda).
  notify_reference  text,
  uid               text,
  status_code       smallint,
  -- Se sella cuando la fila terminó de procesarse (upsert en api_transactions
  -- hecho, o descarte deliberado). NULL = quedó a medias → candidata a
  -- reproceso manual.
  processed_at      timestamptz,
  error             text,
  CONSTRAINT paypros_webhook_events_notify_unique UNIQUE (company_id, notify_reference)
);

-- Consulta típica del operador: "los últimos avisos de esta empresa".
CREATE INDEX IF NOT EXISTS idx_paypros_webhook_events_company_received
  ON public.paypros_webhook_events (company_id, received_at DESC);

-- Barrido de pendientes de reproceso (los que nunca cerraron).
CREATE INDEX IF NOT EXISTS idx_paypros_webhook_events_unprocessed
  ON public.paypros_webhook_events (company_id, received_at DESC)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- RLS
--
-- Escribe SOLO el service role (el handler del webhook). No hay policy de
-- INSERT/UPDATE/DELETE a propósito: con RLS habilitada y sin policy, ningún
-- rol de cliente (anon / authenticated) puede escribir, y el service role
-- pasa por encima igual.
--
-- SELECT: admins y auditores de la empresa dueña de la credencial (más el
-- superadmin de plataforma, que no tiene fila en company_users y entra por
-- `is_superadmin()`, igual que en la migración 074). El body crudo NO
-- contiene secretos (la sign key nunca viaja en el webhook; lo que viaja es
-- un hash), pero sí datos de transacciones del tenant, así que va acotado a
-- la empresa como el resto de las tablas api_*.
-- ---------------------------------------------------------------------------

ALTER TABLE public.paypros_webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS paypros_webhook_events_select ON public.paypros_webhook_events;
CREATE POLICY paypros_webhook_events_select ON public.paypros_webhook_events
  FOR SELECT USING (
    is_superadmin()
    OR company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role IN ('admin','auditor')
    )
  );

COMMENT ON TABLE public.paypros_webhook_events IS
  'Respaldo crudo de cada POST del webhook de Pay-Pros. Modelo push sin API de listado: si se pierde un aviso no hay forma de recuperarlo, así que el body se guarda antes de procesarlo. UNIQUE(company_id, notify_reference) = idempotencia de entrega.';

COMMENT ON COLUMN public.paypros_webhook_events.raw_body IS
  'Body textual exacto: datetime&notifyReference&uid&amount&currencyCode&status&signature.';
COMMENT ON COLUMN public.paypros_webhook_events.signature_valid IS
  'NULL = no se pudo parsear el body. false = firma inválida (posible ataque). true = verificada.';
COMMENT ON COLUMN public.paypros_webhook_events.processed_at IS
  'NULL = el aviso no terminó de procesarse; candidato a reproceso manual.';

COMMIT;

-- Verificación después de aplicar:
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'paypros_webhook_events';  -- true
--   SELECT polname, polcmd FROM pg_policy
--     WHERE polrelid = 'public.paypros_webhook_events'::regclass;                  -- solo el SELECT
