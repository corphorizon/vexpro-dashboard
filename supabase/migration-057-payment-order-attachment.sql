-- Migración 057 — Documento de respaldo en la orden de pago
-- (Recuperada del historial de Supabase el 2026-08-06: se aplicó vía MCP y el
--  archivo nunca se commiteó. Auditoría A5.)
--
-- Distinto del comprobante de PAGO (payment_proof_*, migración 055): esto es
-- el documento que JUSTIFICA la orden — factura, contrato, cotización.
-- Bucket PRIVADO (payment-attachments), se guarda el PATH, URL firmada.
-- Fuera de los campos congelados del trigger.

alter table payment_orders
  add column if not exists attachment_path text,
  add column if not exists attachment_name text,
  add column if not exists attachment_mime text,
  add column if not exists attachment_size int,
  add column if not exists attachment_uploaded_at timestamptz;
