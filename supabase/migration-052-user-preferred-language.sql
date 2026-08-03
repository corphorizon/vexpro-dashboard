-- ─────────────────────────────────────────────────────────────────────────────
-- migration-052-user-preferred-language.sql
--
-- Idioma preferido por usuario para los correos transaccionales.
--
-- Por qué: hoy los emails del sistema salen en un mix de inglés y español
-- fijo en el código, sin importar quién los recibe. Con clientes white-label
-- que operan en ambos idiomas necesitamos que CADA correo (bienvenida,
-- reset de contraseña, código 2FA, invitación, notificación de login,
-- reportes financieros, apertura de período) salga en el idioma configurado
-- por el destinatario.
--
-- Regla de negocio: usuarios sin preferencia (usuarios nuevos, filas
-- existentes al momento de aplicar esta migración) reciben INGLÉS. Por eso
-- el DEFAULT es 'en' y la columna es NOT NULL.
--
-- La preferencia se edita vía PATCH /api/user/language (el propio usuario
-- actualiza su fila). Solo se aceptan 'en' y 'es' — el CHECK lo garantiza
-- a nivel de base de datos.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE company_users
  ADD COLUMN preferred_language text NOT NULL DEFAULT 'en'
  CHECK (preferred_language IN ('en', 'es'));

ALTER TABLE platform_users
  ADD COLUMN preferred_language text NOT NULL DEFAULT 'en'
  CHECK (preferred_language IN ('en', 'es'));

-- Backfill (decisión de negocio 2026-08-03): los usuarios EXISTENTES siempre
-- usaron la UI en español (default histórico) → sus emails salen en español.
-- Solo los usuarios NUEVOS (filas creadas después de esta migración) heredan
-- el DEFAULT 'en' de la columna, según la regla "si es nuevo se manda en inglés".
update company_users set preferred_language = 'es';
update platform_users set preferred_language = 'es';
