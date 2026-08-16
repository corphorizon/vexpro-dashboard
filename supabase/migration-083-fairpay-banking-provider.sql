-- Migración 083 — 'fairpay_banking' como proveedor de credenciales (APLICADA).
--
-- banking.fairpay.online es un sistema SEPARADO del portal de cobros
-- (portal.fairpay.online): login propio, API Key propia, y es donde FairPay
-- muestra el BALANCE de la cuenta. Sin esta ampliación del CHECK, guardar la
-- credencial desde el panel revienta en la DB aunque el código la acepte.
ALTER TABLE public.api_credentials DROP CONSTRAINT IF EXISTS api_credentials_provider_check;
ALTER TABLE public.api_credentials ADD CONSTRAINT api_credentials_provider_check
  CHECK (provider = ANY (ARRAY['sendgrid','coinsbuy','unipayment','fairpay','fairpay_banking','orion_crm','paypros']));
