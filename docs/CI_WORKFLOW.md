# GitHub Actions CI workflow (manual setup)

Kevin: el workflow file abajo no puedo pushearlo desde aquí porque mi
OAuth no tiene el scope `workflow`. Te dejo el contenido para que lo
crees manualmente desde la UI de GitHub en
**Actions → New workflow → set up a workflow yourself**, o por terminal:

```bash
mkdir -p .github/workflows
# pega el contenido abajo en .github/workflows/ci.yml
```

## Contenido de `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  typecheck-lint-test:
    name: Type-check, lint, and test
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci --no-audit --no-fund
      - run: npx tsc --noEmit
      - run: npm run lint
      - run: npm test

  build:
    name: Next build
    runs-on: ubuntu-latest
    timeout-minutes: 20
    needs: typecheck-lint-test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci --no-audit --no-fund
      - env:
          NEXT_PUBLIC_SUPABASE_URL: https://example.supabase.co
          NEXT_PUBLIC_SUPABASE_ANON_KEY: anonkey_placeholder_for_ci_only_must_be_long_enough
          SUPABASE_SERVICE_ROLE_KEY: servicerole_placeholder_for_ci_only_must_be_long_enough
          API_CREDENTIALS_MASTER_KEY: '0000000000000000000000000000000000000000000000000000000000000000'
          NEXT_PUBLIC_APP_URL: https://dashboard.horizonconsulting.ai
        run: npm run build
```

Una vez agregado, cada PR a `main` correrá automáticamente:
1. `tsc --noEmit` (type errors)
2. `npm run lint` (eslint)
3. `npm test` (vitest — los 26 tests que ya escribí)
4. `npm run build` (Next build con env dummy)

El job de build espera a que el primero pase para no quemar minutos
de CI cuando hay typo errors triviales.
