# Disaster Recovery · Smart Dashboard

Plan de contingencia para caídas parciales o totales de la plataforma.
Estado actual basado en infraestructura Vercel + Supabase, sin tercero de
observabilidad (todavía) más allá de los logs propios.

---

## 1. Inventario de sistemas

| Capa | Proveedor | Qué pasa si cae |
|---|---|---|
| Runtime | Vercel (plan Pro recomendado) | La app entera queda inaccesible. El DNS apunta a Vercel Edge, no hay fallback. |
| DB + Auth | Supabase (plan actual a confirmar) | Login falla + todas las queries fallan. UI monta y muestra `LoadingError` con botón "Reintentar" en vez de crashear. |
| Storage (logos, contratos) | Supabase Storage | Imágenes rotas pero la app sigue servible. Los componentes `<CompanyLogo>` muestran iniciales como fallback. |
| Email transaccional | SendGrid | Password resets, invitaciones y login-notifications no salen — usuarios existentes siguen operando. |
| APIs externas | Coinsbuy / UniPayment / FairPay | `/balances` muestra el último snapshot persistido. `/movimientos` muestra los manuales cargados. La app no crashea. |

---

## 2. Backups de Supabase

**Qué tenemos hoy:**
- Backups diarios automáticos (retención depende del plan).
  - Plan Free: 7 días, sin PITR.
  - Plan Pro: 7 días con PITR (Point-in-Time Recovery a granularidad de minutos).
  - Plan Team+: 30 días con PITR.
- Los backups están en infraestructura de Supabase; no hay export off-site periódico.

**TODO para verificar:** confirmar el tier actual del proyecto
en Supabase Dashboard → Settings → Billing.

**Si es Free y manejamos datos financieros reales → upgrade a Pro
es requisito antes de onboardar un cliente externo.**

---

## 3. Storage backups (bucket `company-logos` + `contracts`)

Supabase Storage **no tiene versioning habilitado por default.** El upload
de logo borra el archivo anterior antes de subir el nuevo, lo cual es
permanente.

Para activar versioning en `company-logos` (recomendado):

1. Supabase Dashboard → Storage → bucket `company-logos`
2. Settings (ícono engranaje) → habilitar "Versioning"
3. Repetir para `contracts`

Con versioning, cada overwrite queda como revisión anterior accesible vía
`storage.from('bucket').listObjectVersions()`.

---

## 4. Procedimiento de restore

### Escenario A — Rollback a un punto específico (PITR, plan Pro+)

1. Supabase Dashboard → Database → Backups → Point-in-Time Recovery
2. Elegir timestamp (granularidad de minutos).
3. Supabase crea un proyecto nuevo con el estado restaurado.
4. Verificar datos críticos en el proyecto nuevo (login, tablas de periods,
   deposits, partners).
5. Actualizar connection strings en Vercel Environment Variables:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_DB_*` (si usas los scripts de db-admin)
6. Redeploy en Vercel para que la app tome los nuevos envs.
7. Confirmar que el login funciona con un usuario conocido.
8. Notificar a usuarios del rollback (qué datos podrían haberse perdido).

### Escenario B — Corrupción de una tabla específica

1. No hacer rollback completo — usar el backup diario.
2. Supabase Dashboard → Database → Backups → descargar el dump SQL del día.
3. Importar solo la tabla afectada en un proyecto Supabase staging.
4. Copiar los rows perdidos vía SQL desde staging a prod.
5. Verificar integridad referencial (FKs).
6. Documentar en audit_logs.

### Escenario C — Pérdida de un logo/contrato específico

1. Si bucket tiene versioning (post-fix de sección 3):
   - Listar versiones: `supabase storage ls --bucket=company-logos --versions`
   - Restaurar versión: `supabase storage cp --version=<id> ...`
2. Si no tiene versioning: ir al backup diario de Supabase Storage
   (incluye todos los buckets) y recuperar manualmente.

---

## 5. Checklist de drill semestral

**Frecuencia:** 2× al año (abril + octubre). Owner: Kevin o el DBA designado.

- [ ] Confirmar plan actual de Supabase (Pro o superior si hay clientes pagando).
- [ ] Crear un proyecto Supabase temporal (staging).
- [ ] Ejecutar PITR con timestamp de 24 hs atrás → proyecto staging.
- [ ] Validar que las tablas críticas (companies, company_users, deposits,
      partners, periods) tienen data consistente.
- [ ] Validar que los RLS policies están en su lugar post-restore.
- [ ] Simular pérdida de un logo: borrarlo del bucket prod → recuperar desde
      backup → validar que vuelve a mostrar correctamente.
- [ ] Medir el tiempo total (debería ser < 45 min).
- [ ] Destruir el proyecto staging.
- [ ] Documentar hallazgos en `docs/disaster-recovery-drills/YYYY-MM.md`.

---

## 6. Contactos de emergencia

| Rol | Persona | Contacto |
|---|---|---|
| Owner | Kevin Shark | TODO |
| DBA / Infra | TODO | TODO |
| Soporte Supabase Pro | Email support@supabase.com | (SLA según plan) |
| Soporte Vercel | https://vercel.com/help | (SLA según plan) |
| DNS (Horizon Consulting) | TODO | TODO |

---

## 7. Notas pendientes

- Ningún monitoring externo hoy (no Sentry, no Datadog). La detección de
  caídas depende de que un usuario reporte. Sentry está configurado en
  código (sentry.{client,server,edge}.config.ts) pero requiere DSN en
  Vercel para activarse.
- Sin uptime monitor externo. Recomendado: UptimeRobot (free) pingeando
  `/api/health` cada 5 min una vez que se cree ese endpoint (INF-R5).
- Sin runbook escrito para escalación a 4am. Definir turnos si la
  plataforma crece más allá de 10 tenants.

---

**Última revisión:** 2026-04-21
