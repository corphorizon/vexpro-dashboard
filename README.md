# Smart Dashboard

Multi-tenant financial dashboard for brokers, prop firms, and hedge funds.
Built by **Horizon Consulting**.

## Tech Stack

- **Framework:** Next.js 16 (App Router, TypeScript)
- **Styling:** Tailwind CSS v4
- **Database:** Supabase (PostgreSQL + Auth + RLS)
- **Charts:** Recharts
- **Icons:** Lucide React
- **i18n:** Custom (EN/ES)

## Getting Started

### Prerequisites

- Node.js >= 22
- npm >= 10
- A Supabase project (see [Supabase Setup](#supabase-setup))

### 1. Clone the repository

```bash
git clone git@github.com:YOUR_ORG/smart-dashboard.git
cd smart-dashboard
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy the example file and fill in your Supabase credentials:

```bash
cp .env.local.example .env.local
```

Edit `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

### 4. Run the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Supabase Setup

1. Create a project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** and run the contents of `supabase/schema.sql`
3. Copy your project URL and anon key from **Settings > API**

## Project Structure

```
src/
  app/
    (dashboard)/          # Protected dashboard routes
      page.tsx            # Financial overview
      movimientos/        # Deposits & withdrawals
      egresos/            # Operating expenses
      liquidez/           # Liquidity movements
      inversiones/        # Investment portfolio
      socios/             # Partner distributions
      rrhh/               # HR & commercial profiles
      rrhh/perfil/        # Individual profile detail
      auditoria/          # Audit log
      usuarios/           # User management
      upload/             # CSV data upload
      periodos/           # Period management
      perfil/             # User profile & settings
    login/                # Authentication
  components/
    ui/                   # Reusable UI components
    charts/               # Chart components
    sidebar.tsx           # Navigation sidebar
    period-selector.tsx   # Month/year selector
  lib/
    supabase/             # Supabase client (browser, server, middleware)
    types.ts              # TypeScript interfaces
    i18n.tsx              # Translations (EN/ES)
    demo-data.ts          # Demo/seed data
    hr-data.ts            # HR demo data
    auth-context.tsx      # Authentication context
    period-context.tsx    # Period selection context
    theme-context.tsx     # Theming & white-label
supabase/
  schema.sql              # Complete database schema (20 tables + RLS)
```

## Git Workflow

We use a **Git Flow** strategy with three levels of branches:

### Branches

| Branch | Purpose | Deploys to |
|--------|---------|------------|
| `main` | Production-ready code | Production (Vercel) |
| `develop` | Integration branch for next release | Preview (Vercel) |
| `feature/*` | Individual features or fixes | Preview (Vercel) |

### How to work on a new feature

```bash
# 1. Make sure you're on develop and up to date
git checkout develop
git pull origin develop

# 2. Create your feature branch
git checkout -b feature/my-feature

# 3. Make your changes, commit often
git add src/app/(dashboard)/my-new-page.tsx
git commit -m "feat: add new page for X"

# 4. Push your branch
git push -u origin feature/my-feature

# 5. Open a Pull Request on GitHub
#    - Base: develop
#    - Compare: feature/my-feature
#    - Add description and request review

# 6. After approval, merge via GitHub (squash or merge commit)

# 7. Delete your feature branch
git branch -d feature/my-feature
```

### Commit message conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` new feature
- `fix:` bug fix
- `refactor:` code restructure without behavior change
- `style:` formatting, missing semicolons, etc.
- `docs:` documentation only
- `chore:` build/tooling changes

### Releasing to production

```bash
# On GitHub, create a PR: develop -> main
# After review and approval, merge it
# Vercel auto-deploys main to production
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anonymous/public key |

## Available Scripts

```bash
npm run dev       # Start development server (Turbopack)
npm run build     # Production build
npm run start     # Start production server
npm run lint      # Run ESLint
```

## License

Private and confidential. All rights reserved by Horizon Consulting.
