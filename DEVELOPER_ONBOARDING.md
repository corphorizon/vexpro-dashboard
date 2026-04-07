# Smart Dashboard — Guía de Onboarding para Desarrolladores

> **Copia y pega todo este documento como primer mensaje a Claude Code para que te guíe paso a paso.**

---

## Contexto del proyecto

Soy desarrollador y me dieron acceso al repositorio **Smart Dashboard** de **Horizon Consulting**. Es un dashboard financiero multi-tenant para brokers, prop firms y hedge funds. El primer cliente activo es Vex Pro.

### Stack tecnológico
- **Framework:** Next.js 16 (App Router, TypeScript)
- **Styling:** Tailwind CSS v4
- **Database:** Supabase (PostgreSQL + Auth + Row Level Security)
- **Charts:** Recharts
- **Icons:** Lucide React
- **i18n:** Custom EN/ES
- **Deploy:** Vercel (auto-deploy desde GitHub)

### Repositorio
- **URL:** https://github.com/corphorizon/vexpro-dashboard
- **Ramas:**
  - `main` → producción (protegida, no se puede hacer push directo)
  - `develop` → integración/staging
  - `feature/*` → ramas individuales de trabajo

### Estructura del proyecto
```
src/
  app/
    (dashboard)/          # Rutas protegidas del dashboard
      page.tsx            # Resumen financiero general
      movimientos/        # Depósitos y retiros
      egresos/            # Gastos operativos
      liquidez/           # Movimientos de liquidez
      inversiones/        # Portafolio de inversiones
      socios/             # Distribución de socios
      rrhh/               # RRHH y perfiles comerciales
      rrhh/perfil/        # Detalle de perfil individual
      auditoria/          # Log de auditoría
      usuarios/           # Gestión de usuarios
      upload/             # Carga de datos CSV
      periodos/           # Gestión de períodos
      perfil/             # Perfil y configuración del usuario
    login/                # Autenticación
  components/
    ui/                   # Componentes reutilizables (Card, Badge, etc.)
    charts/               # Componentes de gráficos
    sidebar.tsx           # Sidebar de navegación
    period-selector.tsx   # Selector de mes/año
  lib/
    supabase/             # Clientes Supabase (browser, server, middleware)
    types.ts              # Interfaces TypeScript (coinciden con schema DB)
    i18n.tsx              # Traducciones EN/ES (~500+ keys)
    demo-data.ts          # Datos demo para desarrollo
    hr-data.ts            # Datos demo de RRHH
    auth-context.tsx      # Contexto de autenticación
    period-context.tsx    # Contexto de selección de período
    theme-context.tsx     # Theming y white-label
supabase/
  schema.sql              # Schema completo (20 tablas + RLS + triggers)
```

### Convenciones de commits
Usamos Conventional Commits:
- `feat:` nueva funcionalidad
- `fix:` corrección de bug
- `refactor:` reestructura sin cambio de comportamiento
- `style:` formato, semicolons, etc.
- `docs:` solo documentación
- `chore:` cambios de build/tooling

---

## Lo que necesito que hagas

### Paso 1: Configurar mi entorno

1. Clonar el repositorio:
```bash
git clone https://github.com/corphorizon/vexpro-dashboard.git
cd vexpro-dashboard
```

2. Instalar dependencias:
```bash
npm install
```

3. Crear el archivo de variables de entorno:
```bash
cp .env.local.example .env.local
```

4. Editar `.env.local` con las credenciales de Supabase que me dieron:
```env
NEXT_PUBLIC_SUPABASE_URL=<url que me dio el admin>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<key que me dio el admin>
```

5. Verificar que el proyecto compila:
```bash
npm run dev
```

### Paso 2: Crear mi rama de trabajo

Cuando el admin me asigne una tarea:

```bash
git checkout develop
git pull origin develop
git checkout -b feature/nombre-de-mi-tarea
```

### Paso 3: Hacer cambios y commits

```bash
git add src/app/(dashboard)/archivo-modificado.tsx
git commit -m "feat: descripción clara del cambio"
```

### Paso 4: Subir mi rama y crear Pull Request

```bash
git push -u origin feature/nombre-de-mi-tarea
```

Luego ir a GitHub y crear un Pull Request:
- **Base:** `develop`
- **Compare:** `feature/nombre-de-mi-tarea`
- Agregar descripción de los cambios
- Solicitar review

### Paso 5: Después del merge

```bash
git checkout develop
git pull origin develop
git branch -d feature/nombre-de-mi-tarea
```

---

## Reglas importantes

1. **NUNCA hacer push directo a `main`** — siempre usar Pull Request
2. **NUNCA commitear archivos `.env`** — están en `.gitignore`
3. **Siempre partir desde `develop`** para crear feature branches
4. **Siempre hacer `git pull` antes de crear una rama nueva**
5. **Las traducciones están en `src/lib/i18n.tsx`** — si agregas texto visible, agrega keys en EN y ES
6. **Los tipos TypeScript van en `src/lib/types.ts`** — deben coincidir con `supabase/schema.sql`
7. **Producto:** "Smart Dashboard v1.0 — Horizon Consulting" (no usar nombres de clientes en el código)

---

## Ayúdame con lo siguiente

Guíame paso a paso para ejecutar los comandos anteriores. Si encuentras algún error, ayúdame a resolverlo. Cuando esté listo el entorno, explícame la estructura del proyecto para que pueda empezar a trabajar.
