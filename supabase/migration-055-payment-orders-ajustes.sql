-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 055 — Órdenes de Pago: aprobación abierta + comprobante adjunto
--
-- 1) APROBACIÓN ABIERTA (decisión de Kevin, 2026-08-05)
--    La 054 imponía segregación de funciones: quien emitía no podía aprobar.
--    Kevin decidió que apruebe cualquier usuario con acceso al módulo,
--    incluida su propia orden — el equipo es chico y el circuito de dos
--    personas frenaba la operación.
--
--    Se quita la validación del trigger, PERO la trazabilidad se conserva:
--    approved_by/approved_at siguen sellándose, así que una autoaprobación
--    queda visible en el historial (approved_by = created_by). Es el registro
--    lo que sostiene la auditoría ahora, no el bloqueo.
--
--    SIGUE VIGENTE la inmutabilidad post-aprobación: montos, beneficiario y
--    datos de pago quedan congelados al aprobar. Ese control no se toca.
--
-- 2) COMPROBANTE DE PAGO ADJUNTO (opcional)
--    Además de la referencia en texto (txid / referencia bancaria), se puede
--    adjuntar el comprobante real: PDF del banco, captura de la transferencia.
--    El archivo vive en el bucket PRIVADO `payment-proofs`; la tabla guarda el
--    PATH (nunca una URL pública) y se sirve con URL firmada de 10 min, igual
--    que los contratos de RRHH.
--
--    Estas columnas son metadata operativa, NO contenido económico: por eso
--    quedan fuera de la lista de campos congelados del trigger — se puede
--    adjuntar o corregir el comprobante de una orden ya pagada.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1) Trigger sin segregación de funciones ──────────────────────────────────
create or replace function public.payment_orders_guard()
returns trigger
language plpgsql
as $$
begin
  -- (La validación approved_by <> created_by se eliminó a propósito — ver
  --  cabecera. La autoaprobación es válida y queda registrada.)

  -- Inmutabilidad post-aprobación: aprobada/pagada solo admite avanzar de
  -- estado y completar campos operativos (pago, anulación, comprobante).
  -- Los montos, el beneficiario y los datos bancarios quedan congelados.
  if tg_op = 'UPDATE' and old.status in ('approved','paid') then
    if new.total is distinct from old.total
       or new.subtotal is distinct from old.subtotal
       or new.fees is distinct from old.fees
       or new.lines is distinct from old.lines
       or new.currency is distinct from old.currency
       or new.beneficiary_name is distinct from old.beneficiary_name
       or new.beneficiary_tax_id is distinct from old.beneficiary_tax_id
       or new.payment_method is distinct from old.payment_method
       or new.crypto_wallet is distinct from old.crypto_wallet
       or new.crypto_network is distinct from old.crypto_network
       or new.bank_account_number is distinct from old.bank_account_number
       or new.bank_swift is distinct from old.bank_swift
       or new.order_number is distinct from old.order_number
    then
      raise exception 'Una orden aprobada es inmutable: anulala y emití una nueva';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- ── 2) Comprobante de pago ───────────────────────────────────────────────────
alter table payment_orders
  add column if not exists payment_proof_path text,
  add column if not exists payment_proof_name text,
  add column if not exists payment_proof_mime text,
  add column if not exists payment_proof_size int,
  add column if not exists payment_proof_uploaded_at timestamptz;

-- El bucket privado `payment-proofs` se crea aparte (Storage), no por SQL.
