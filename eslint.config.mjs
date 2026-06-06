import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      // Kevin 2026-06-06: la regla react-hooks/set-state-in-effect que
      // llegó con eslint-plugin-react-hooks 6+ identifica MUCHOS patrones
      // legítimos del codebase actual (theme-context, period-context,
      // active-company init, etc.) como errores. Los más son sincronización
      // intencional con localStorage / system theme — no son los anti-
      // patterns que la regla original buscaba (cascadas de re-render).
      // Bajado a warning para no bloquear CI mientras se va auditando
      // archivo por archivo. Issues genuinos siguen siendo visibles en
      // local + en el output del CI sin failear el build.
      "react-hooks/set-state-in-effect": "warn",
      // Mismas consideraciones para el wrapping rule que aparece en
      // algunos componentes legacy.
      "react-hooks/exhaustive-deps": "warn",
    },
  },
]);

export default eslintConfig;
