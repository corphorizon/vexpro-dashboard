-- ─────────────────────────────────────────────────────────────────────────────
-- migration-047: hardening de RLS en tablas de auth (SEC-02, 2026-07-12)
--
-- PROBLEMA (drift migraciones ↔ DB): las migraciones 014 y 015 dejaron
-- `password_reset_tokens`, `twofa_reset_codes` y `twofa_attempts` con
-- `DISABLE ROW LEVEL SECURITY`. El hardening (RLS on + REVOKE de anon) se
-- aplicó luego en producción vía SQL directo, pero NUNCA quedó en un archivo
-- de migración → reconstruir la DB desde migraciones (staging, DR, entorno
-- nuevo) reintroducía la vulnerabilidad: con RLS off y los grants por defecto
-- de Supabase a anon/authenticated, cualquier usuario autenticado podía leer
-- `twofa_reset_codes` (código de 6 dígitos → brute offline → bypass reset 2FA)
-- o borrar filas de `twofa_attempts` (anula el rate-limiting antibruteforce).
--
-- Esta migración captura el estado correcto. Idempotente: en prod ya está
-- aplicado (no-op); en un entorno nuevo deja las tablas seguras.
--
-- Sin CREATE POLICY → deny-all salvo service_role, que es el único uso real
-- (el admin client server-side). REVOKE quita los grants por defecto.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.twofa_reset_codes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.twofa_attempts       ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.password_reset_tokens FROM anon, authenticated;
REVOKE ALL ON public.twofa_reset_codes     FROM anon, authenticated;
REVOKE ALL ON public.twofa_attempts        FROM anon, authenticated;
