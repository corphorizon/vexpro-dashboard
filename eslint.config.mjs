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
  {
    // «Libro mayor» (2026-10-12): aviso en el editor para lo más común —
    // paleta cruda, `dark:` de color y 10/11 px en un literal. LA guardia es
    // src/lib/design-guard.test.ts (cubre además los tokens legados, tiene la
    // allowlist con motivo y da archivo:línea); esto es sólo el refuerzo
    // temprano. Ver docs/diseno-libro-mayor.md §9.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "src/lib/design-guard.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/(^|[\\s:'\"`!])(bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|placeholder|shadow)-(red|rose|pink|fuchsia|purple|violet|indigo|blue|sky|cyan|teal|emerald|green|lime|yellow|amber|orange|slate|gray|zinc|neutral|stone)-[0-9]{2,3}/]",
          message:
            "Paleta cruda de Tailwind: usá tokens (text-pos/neg/pend/info/stale, *-bg, text-text-2/3, surface-2, border-strong, brand-*). docs/diseno-libro-mayor.md §2.1 y §9.",
        },
        {
          selector:
            "TemplateElement[value.raw=/(^|[\\s:'\"`!])(bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|placeholder|shadow)-(red|rose|pink|fuchsia|purple|violet|indigo|blue|sky|cyan|teal|emerald|green|lime|yellow|amber|orange|slate|gray|zinc|neutral|stone)-[0-9]{2,3}/]",
          message:
            "Paleta cruda de Tailwind: usá tokens (text-pos/neg/pend/info/stale, *-bg, text-text-2/3, surface-2, border-strong, brand-*). docs/diseno-libro-mayor.md §2.1 y §9.",
        },
        {
          selector: "Literal[value=/(^|[\\s'\"`])dark:([a-z-]+:)*(bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|placeholder|shadow)-/]",
          message: "Variante dark: de color: los tokens flipan solos en .dark. docs/diseno-libro-mayor.md §2.1.",
        },
        {
          selector: "TemplateElement[value.raw=/(^|[\\s'\"`])dark:([a-z-]+:)*(bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|placeholder|shadow)-/]",
          message: "Variante dark: de color: los tokens flipan solos en .dark. docs/diseno-libro-mayor.md §2.1.",
        },
        {
          selector: "Literal[value=/text-\\[1[01]px\\]/]",
          message: "text-[10px]/text-[11px]: el piso es 11.5 (badge, cabecera) o 12 (text-xs, metadato). docs/diseno-libro-mayor.md §3.",
        },
        {
          selector: "TemplateElement[value.raw=/text-\\[1[01]px\\]/]",
          message: "text-[10px]/text-[11px]: el piso es 11.5 (badge, cabecera) o 12 (text-xs, metadato). docs/diseno-libro-mayor.md §3.",
        },
      ],
    },
  },
]);

export default eslintConfig;
