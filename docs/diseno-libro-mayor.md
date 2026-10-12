# Diseño «Libro mayor» — especificación

> Decisión del dueño (Kevin, **2026-10-12**). Este documento es la fuente para
> los agentes que hagan las fases siguientes: **tiene que alcanzar sin abrir
> las maquetas.** Si algo de acá contradice una maqueta, manda este documento;
> si contradice `docs/reglas-del-proyecto.md`, mandan las reglas.

---

## 1. La dirección

**«Libro mayor»** (propuesta A) más dos piezas de la propuesta B:

1. la **barra de distribución** por canal en Balances (§7), y
2. las **filas que se vuelven tarjetas** en móvil (< 720 px) en las tablas
   financieras (§5.3).

Lo que define la dirección, en una línea cada cosa:

- **Una pantalla es un libro contable, no un tablero de tarjetas.** Pocas
  superficies, grandes, con bordes de 1 px; los números alineados en columna.
- **El color es significado, nunca decoración** (§2.1) — en los DATOS. La
  estructura (navegación, encabezados, acentos, selección) lleva el color de la
  marca de cada empresa desde el 2026-10-12 (§10).
- **Cada número dice de cuándo es.** Un saldo viejo se ve viejo (`stale`), un
  canal que no respondió se avisa y se cuenta — nunca se suma en silencio como
  cero (`reglas-del-proyecto.md` §1.2 y §1.3).
- **Densidad de escritorio, tacto en móvil**: filas de 36 px con mouse, 44 px
  con puntero grueso; en < 720 px la tabla pasa a tarjetas.
- **Tipografía: Inter se mantiene** (no Geist). Cifras tabulares siempre.
- **Migración incremental**, sin big-bang: los tokens nuevos conviven con los
  viejos; cada pantalla se migra en su propio cambio.

---

## 2. Tokens

Viven en `src/app/globals.css`. Los valores crudos van en `:root` (claro) y en
`.dark` (oscuro); el bloque `@theme inline` los expone como utilidades de
Tailwind. Hay un test (`src/lib/design-tokens.test.ts`) que fija los valores,
recalcula el contraste y falla si alguien «ajusta un tono» y rompe AA.

### 2.1 La regla del color

| Token | Significa | Ejemplos |
|---|---|---|
| `pos` | ganancia, entrada, completado, al día | depósito neto +, «Pagado», punto de frescura |
| `neg` | pérdida, salida, error, deuda | resultado −, «Rechazado», deuda en Balances |
| `pend` | pendiente, requiere acción | «Abierto», «Por aprobar», contador en el menú |
| `info` | informativo, fuente automática | etiqueta «API», avisos neutros |
| `stale` | **dato viejo o sin sincronizar que sigue sumando** | saldo de hace 26 h, carga manual del 1 sep |

- Si un color no significa una de estas cinco cosas, **va en gris**
  (`text-text-2` / `text-text-3`).
- Cada color trae su fondo `*-bg`: un badge es `text-pos bg-pos-bg`.
- **Nada de paleta cruda** (`text-emerald-600`, `bg-red-50`, `#hex` en
  `className`) **ni variantes `dark:` de color** en código nuevo: los tokens
  flipan solos.
- Un número **no** se pinta de verde por ser positivo en una columna donde
  todos son positivos (p. ej. saldos). Se pinta cuando el signo es la noticia
  (resultado del mes, variación).

### 2.2 Tabla de tokens

Contraste medido con la fórmula WCAG 2.x. Superficie claro = `#FFFFFF`;
superficie oscuro = `#111723` (la de la maqueta) y, entre paréntesis, la
tarjeta legada `#1E293B` sobre la que caen hoy. AA texto = 4,5:1; componentes
(bordes de control, rellenos) = 3:1.

| Token (utilidad) | Claro | Oscuro | Contraste | Uso |
|---|---|---|---|---|
| `surface-2` (`bg-surface-2`) | `#F0F2F5` | `#172031` | — | segmented control, hover de nav, avatar |
| `surface-sunk` (`bg-surface-sunk`) | `#EBEEF2` | `#0D121C` | — | pista de barras de participación |
| `border-strong` (`border-border-strong`) | `#C9D0DA` | `#33405A` | — | botones, cabecera de tabla, chips |
| `control-border` (`border-control-border`) | `#8A94A3` | `#5E6B82` | 3,07 / 3,33 | **inputs** (3:1 de componente) |
| `text-2` (`text-text-2`) | `#465264` | `#AAB4C5` | 7,92 / 8,58 (7,00) | texto secundario, cifras de apoyo |
| `text-3` (`text-text-3`) | = `muted-foreground` | = `muted-foreground` | 4,76 / 8,28 | terciario, metadatos — ver §2.3 |
| `brand-tint` (`bg-brand-tint`) | deriva de la marca (§10); respaldo `#E7EEFA` | respaldo `#172848` | `brand-ink` encima ≥ 4,5 (test) | chip activo, cuadro de ícono |
| `pos` / `pos-bg` | `#047857` / `#D7F0E4` | `#3CCB8F` / `#113524` | sobre blanco 5,48 · sobre su bg ≥ 4,5 (test) | `*-bg` más saturados desde 2026-10-12 (§10) |
| `neg` / `neg-bg` | `#B42318` / `#FADCD8` | `#F97066` / `#421B18` | 6,57 · ≥ 4,5 | |
| `pend` / `pend-bg` | `#A15C07` / `#FCEED8` | `#F2B13A` / `#3D2C0C` | 5,19 · ≥ 4,5 | |
| `info` / `info-bg` | `#1D5BD6` / `#DCE7FC` | `#6EA3FF` / `#18305C` | 5,97 · ≥ 4,5 | |
| `stale` / `stale-bg` | `#6B5FA8` / `#EBE8F8` | `#B3A6F0` / `#2C2550` | 5,49 · ≥ 4,5 | |
| `row-hover` (`bg-row-hover`) | `#F3F5F8` | `#151D2C` | — | hover de fila |
| `row-selected` (`bg-row-selected`) | `#EEF3FB` | `#16233A` | — | fila seleccionada (+ barra 3 px `brand-ink`) |
| `group-row` (`bg-group-row`) | `#F7F8FA` | `#0E141F` | — | fila de grupo/subtotal |
| `shadow-1` | `0 1px 2px rgb(13 21 36/.05)` | `0 1px 2px rgb(0 0 0/.4)` | — | paneles en reposo |
| `shadow-2` | `0 1px 2px …/.06, 0 6px 16px -6px …/.12` | `0 2px 4px …/.4, 0 8px 20px -8px …/.6` | — | menús, popovers |
| `shadow-3` | `0 12px 32px -8px rgb(13 21 36/.28)` | `0 16px 40px -8px rgb(0 0 0/.7)` | — | modales, drawer móvil |
| `r-sm/md/lg/xl` (`rounded-ui-sm…xl`) | 4 / 6 / 10 / 14 px | igual | — | sm: tags · md: botones, inputs · lg: paneles · xl: modales |
| `row-h` (`h-row`, `min-h-row`) | 36 px; 44 px con `pointer: coarse` | igual | — | alto de fila de tabla |
| `scrim` (`bg-scrim`) | `rgb(0 0 0 / .45)` | igual | — | velo de modales y del drawer móvil (§6.1). Desde el barrido final (2026-10-12); antes 24 `bg-black/40…60` sueltos |

Superficies y texto principales de la maqueta (todavía **no** aplicados; ver
fase 3): `bg #F5F6F8 / #0A0E15`, `surface #FFFFFF / #111723`, `border #E2E6EC /
#232D3F`, `text #0D1524 / #E7EBF2` (18,26 / 15,00), `brand #1E3A5F / #2B4C78`,
`focus #2563EB / #6EA3FF`.

### 2.3 Alias, choques de nombre y decisiones

- **Cómo se resuelve el tema.** La maqueta define el oscuro con
  `@media (prefers-color-scheme: dark)` + `[data-theme="dark"]`. Este repo no:
  `src/lib/theme-context.tsx` resuelve «system» en JS y pone/quita la clase
  `.dark` en `<html>` (clave `fd_theme` en localStorage). Por eso los valores
  oscuros viven **sólo en `.dark`**. Un bloque `@media` le daría tokens oscuros
  a quien eligió «claro» con el sistema en oscuro. El test lo prohíbe.
- **`text-3` es alias de `muted-foreground`** (`--text-3: var(--muted-foreground)`).
  Así el código nuevo se ve igual que el legado mientras conviven. El valor
  final (`#5F6B7D` / `#8B96AA`, 5,40 / 6,01) entra en la fase 3 cambiando
  `--muted-foreground`: los dos nombres se mueven juntos.
- **`info` ya existía**: se reusó el nombre con el valor de la maqueta porque
  el viejo `#2563EB` daba 4,48:1 sobre `info-bg`. Es el único token existente
  que cambió de valor fuera de la fase 0.
- **`border`, `accent`, `brand-ink`** ya existen y **no se tocaron**.
  `brand-ink` deriva del color de cada empresa (`brand-color.ts`), que es mejor
  que el navy fijo de la maqueta. `brand-tint` también deriva de la marca desde
  el 2026-10-12 (§10, en `brand-color.ts`, nunca en un componente).
- **Radios `rounded-ui-*`**: `rounded-r-md` ya es de Tailwind (radio del lado
  derecho). No se pisan `rounded-sm/md/lg/xl` porque cambiaría el aspecto de
  toda la app.
- **Sombras**: `shadow-card/raised/overlay` (legadas) siguen; las nuevas son
  `shadow-1/2/3`. En la fase 3 las legadas pasan a ser alias de las nuevas.

### 2.4 Mapa legado → nuevo (para migrar)

| Legado | Nuevo |
|---|---|
| `bg-background` | `bg-bg` *(fase 3)* |
| `bg-card` | `bg-surface` *(fase 3)* |
| `bg-muted` | `bg-surface-2` |
| `text-foreground` | `text-text` *(fase 3)* |
| `text-muted-foreground` | `text-text-2` (secundario) o `text-text-3` (terciario) |
| `text-positive`, `bg-positive/10` | `text-pos`, `bg-pos-bg` |
| `text-negative`, `bg-negative/10` | `text-neg`, `bg-neg-bg` |
| `text-warning`, `bg-warning/10` | `text-pend`, `bg-pend-bg` |
| `text-info`, `bg-info/10` | `text-info`, `bg-info-bg` |
| `shadow-card` / `raised` / `overlay` | `shadow-1` / `2` / `3` |
| `rounded-lg` en paneles | `rounded-ui-lg` |
| `bg-[var(--color-primary)] text-white` | `bg-primary text-brand-on-primary` |
| `text-primary`, `text-[var(--color-primary)]`, `text-primary dark:text-accent` | `text-brand-ink` |
| `bg-primary/10` (chip/cuadro de ícono) | `bg-brand-tint` |
| `bg-black/40…60` (velo) | `bg-scrim` |
| relleno sólido `bg-negative text-white` (botón/toast) | `border border-neg/35 bg-neg-bg text-neg` (receta `danger` de `ui/action-button.tsx`) |
| `text-[10px]` / `text-[11px]` | `text-[11.5px]` (badge, cabecera) o `text-xs` (metadato, hint) |

---

## 3. Tipografía

**Inter** (ya cargada con `next/font`, `--font-inter`), `font-feature-settings:
"cv11"` (1 con serifa, ya global). Para cifras: `tabular-nums` +
`slashed-zero` y `white-space: nowrap` (clase `.num` en la maqueta; en Tailwind
`tabular-nums slashed-zero whitespace-nowrap`). Monoespaciada sólo para
identificadores (wallets, IDs, nombres de función): 12 px, `font-mono`.

| Rol | Tamaño / interlineado | Peso | Extra |
|---|---|---|---|
| Cuerpo | 14 / 1.5 | 400 | |
| Título de página (h1) | 22 / 28 (20 en < 640) | 650 | `tracking -0.015em` |
| Bajada de página | 13.5 | 400 | `text-text-2` |
| Título de panel (h2) | 15 | 600 | `tracking -0.005em` |
| Hint de panel | 12.5 | 400 | `text-text-3` |
| Valor KPI | 22 / 30 (hero 26) — móvil 18 / 26 (hero 24) | 600 | `tracking -0.02em`, tabular |
| Etiqueta KPI | 12 | 500 | `text-text-2` |
| Celda de tabla | 13 | 400 (montos 500) | tabular |
| Cabecera de tabla | 11.5 | 600 | MAYÚSCULAS, `tracking .03em`, `text-text-3` |
| Metadato bajo un nombre | 12 / 1.3 | 400 | `text-text-3` |
| Badge | 11.5 | 600 | |
| Nav ítem / grupo | 13.5 · 500 / 11 · 600 MAYÚSCULAS `tracking .06em` | | |
| Botón | 13 | 500 | |

---

## 4. Dinero (fase 2 — hecha)

`src/lib/money.ts` → **`formatMoney(n, { signed?, compact?, currency? })` es el
ÚNICO formateador de dinero.** `formatCurrency` (utils) y `pdfMoney` delegan en
él.

- Locale en **una** constante: `MONEY_LOCALE` (hoy `'en-US'`: el dueño no
  decidió). Ponerla en `'es-AR'` cambia **toda** la app a `$45.205,00`.
- Signo **antes** del símbolo: `-$1,234.00`, nunca `$-1,234.00`.
- `signed: true` (tablas): `+$1,234.00` / `−$1,234.00` con U+2212. **No** en
  PDF (jsPDF/Helvetica no tiene el glifo).
- `compact: true` (KPIs, ejes): `$45.2K`, `$1.3M`. Nunca donde se concilia.
- Lo que redondea a cero es `$0.00`, nunca `-$0.00`.
- No acepta `null`: «sin dato» lo decide el llamador (`—`, «sin dato»), nunca
  `$0.00` (`reglas-del-proyecto.md` §1.3).
- **Prohibido** en código nuevo: `toLocaleString`/`Intl.NumberFormat` para
  dinero, y `` `$${x}` `` armado a mano.

---

## 5. Componentes

Todas las medidas en px. «Superficie» = `bg-card` hoy, `surface` desde la fase 3.

### 5.1 Botón

- Alto 32, padding 0 12, `rounded-ui-md`, borde 1 `border-strong`, fondo
  superficie, 13/500, ícono 15 con `stroke 1.75`, gap 6. Hover: `surface-2`.
- **Primario**: fondo `brand` (hoy `bg-primary`), borde igual, texto
  `brand-on-primary`; hover = 86 % brand + negro. **Uno por pantalla.**
- **Ghost**: sin borde ni fondo, `text-text-2`.
- Botón-ícono: 32×32, mismo borde. Siempre con `aria-label`.
- En < 640 los botones no primarios de la cabecera muestran sólo el ícono.

### 5.2 Panel

- Superficie, borde 1 `border`, `rounded-ui-lg`, `shadow-1`, margen inferior 16.
- Cabecera: padding 12 16, borde inferior; `h2` 15/600 + hint 12.5 `text-3`;
  acciones a la derecha. En < 640 el hint baja a su propia línea.
- Pie (`foot-note`): 12.5 `text-3`, borde superior. **Si la lista está
  recortada, el pie lo dice con números**: «Mostrando 21 de 1.284. Los totales
  de arriba usan los 1.284.» (regla de §1.2: un recorte silencioso es
  indistinguible de «no hay más»).
- Dos paneles lado a lado: grilla 2 columnas gap 16; una columna en < 1100.

### 5.3 Tabla financiera

Escritorio:
- `border-collapse: separate`, 13 px. Cabecera **sticky** sobre la superficie,
  alto 34, 11.5/600 MAYÚSCULAS `text-3`, borde inferior `border-strong`.
- Celdas: alto `h-row`, padding 0 12 (16 en la primera y la última), borde
  inferior `border`. **Números a la derecha**, tabulares, montos 500.
- Celda de nombre: nombre 500 + metadato 12 `text-3` debajo.
- Hover `row-hover`; seleccionada `row-selected` + `box-shadow: inset 3px 0 0
  brand-ink` en la primera celda.
- **Fila de grupo**: `group-row`, alto 32, 12/600 `text-2`, con conteo
  («Pasarelas · 4») y subtotal alineado en la columna de monto.
- **Pie (total)**: sticky abajo, borde superior 1.5 `text` (la «doble raya» del
  libro), alto 42, 650. Si el total excluye algo, lo dice en la etiqueta:
  «Total retiros (4 de 5 canales)».
- Columna de participación: % tabular + barra 64×6 (`surface-sunk` con relleno
  `brand-ink` al 75 %).
- Acciones de fila: aparecen en hover (opacidad), siempre accesibles por teclado.
- Contenedor con `overflow-x: auto`; en < 640 la primera columna puede quedar
  sticky a la izquierda (tablas anchas tipo resultado mensual).
- Columnas secundarias con `hide-sm` (se ocultan < 640 / < 720 en modo tarjeta).

**Móvil < 720 px — filas-tarjeta** (pieza de la propuesta B):

```css
@media (max-width: 720px) {
  .fin thead { display: none; }
  .fin, .fin tbody, .fin tfoot { display: block; }
  .fin tbody tr, .fin tfoot tr {
    display: grid; grid-template-columns: minmax(0,1fr) auto;
    gap: 2px 12px; padding: 12px 16px; border-bottom: 1px solid var(--border);
    align-items: center;
  }
  .fin td { display: block; height: auto; padding: 0; border: 0; }
  .fin tbody tr:hover td { background: transparent; }
  .fin tr.grp { display: block; padding: 0; }        /* el grupo ocupa todo el ancho */
  .fin tr.grp td { padding: 8px 16px; }
  .fin tfoot td { position: static; background: transparent; }
  .fin tfoot tr { background: var(--surface-2); }
  .hide-sm { display: none !important; }
  .sm-only { display: flex !important; }             /* estado + frescura bajo el nombre */
}
```

Cada fila queda: **izquierda** nombre + metadato + (sólo móvil) badge de estado
y «hace 4 min»; **derecha** el monto. Lo que en escritorio son columnas
(estado, actualizado) se repite dentro de la celda de nombre con `sm-only`, no
se pierde.

### 5.4 Franja de KPIs

**Una sola superficie dividida**, no N tarjetas: grilla
`repeat(var(--kc,5), minmax(0,1fr))`, borde, `rounded-ui-lg`, `shadow-1`; cada
KPI con padding 14 18 y borde izquierdo 1 (salvo el primero).

- Etiqueta 12/500 `text-2` · valor 22/600 tabular · sub 12 `text-3` (conteo,
  variación «▲ 4,1 % vs. 31 ago» con `pos`/`neg`).
- Un KPI **hero** (el número que importa) a 26 px.
- Responsive: < 1100 → 3 columnas; < 640 → 2 columnas con el hero ocupando
  toda la fila. Los bordes se recalculan para no duplicar líneas.
- Un KPI **sin dato** muestra `—` y el sub explica por qué; **nunca $0.00**.
  Si un total excluye un canal que no respondió, el sub lo dice («1 canal sin
  dato») y hay un banner `pend` arriba.

### 5.5 Badge de estado

Píldora alto 20, padding 0 7, 11.5/600, punto de 6 px `currentColor` antes.

| Variante | Clases | Para |
|---|---|---|
| pos | `text-pos bg-pos-bg` | Pagado, Completado, Al día |
| neg | `text-neg bg-neg-bg` | Rechazado, Error |
| pend | `text-pend bg-pend-bg` | Abierto, Pendiente, Por aprobar |
| info | `text-info bg-info-bg` | En revisión, informativo |
| **stale** | `text-stale bg-stale-bg` | fecha del último dato: «hace 26 h», «1 sep» |
| neutro | `text-text-2 bg-surface-2` | Cerrado, Borrador |

**Valor desactualizado** (el monto mismo): `text-text-2` + subrayado punteado
color `stale` (`text-decoration: underline dotted var(--stale)`, offset 3) y
debajo «desactualizado» en metadato. Sigue sumando al total; el banner lo
cuantifica.

**Etiqueta de fuente** (`.src`): 10.5/600 MAYÚSCULAS, borde 1 `border-strong`,
`rounded-ui-sm`; variante API en `info`. «API», «On-chain», «Manual».

**Banner de estado del dato**: padding 10 14, `rounded-ui-md`, borde 1 del
color al 35 %, fondo `*-bg`, texto `text`, ícono 16 del color. Variantes
`stale` («2 canales sin sincronizar… siguen sumando $60.180,12») y `pend`
(«Retiros de Binance sin dato: ese canal **no está sumado**»). Siempre con la
cifra afectada y un enlace «Revisar».

### 5.6 Formularios y filtros

- Input/select: alto 32, padding 0 10, borde 1 **`control-border`** (3:1, no
  el `border` de las superficies), `rounded-ui-md`, 13 px; placeholder `text-3`.
- Foco: anillo 2 px `focus`, offset 2 (ya global en `globals.css`).
- Búsqueda: ícono 15 `text-3` + input sin borde propio; min 220, max 320; en
  < 640 ocupa el ancho.
- **Segmented control** (`seg`): fondo `surface-2`, borde, padding 2; botones
  26 de alto 12.5/500 `text-2`; el activo: superficie + `shadow-1` + 600 y
  `aria-pressed="true"`. Conteo opcional en `text-3`.
- **Chip de filtro**: alto 28, borde 1 **punteado** `border-strong`,
  `rounded-full`; activo: borde sólido `brand-ink`, fondo `brand-tint`, 600.
- Errores de formulario: texto `neg` + borde `neg`, mensaje debajo, nunca sólo
  color (ícono o texto).

---

## 6. Layout

### 6.1 Sidebar (oscuro de marca — ver §10)

- **Reemplazado el 2026-10-12** (Kevin): el sidebar **no** sigue el tema; es
  **siempre oscuro, del color de la marca** de la empresa activa (§10.2). Lo
  que sigue de esta sección vale para medidas y comportamiento; los colores
  salen de los tokens `sidebar-*`.
- Ancho 232, sticky a alto completo, padding 14 10.
- Bloque de empresa arriba: logo 30×30 `rounded 8` en `brand`, nombre 13/600,
  sub 12 `text-3` («Bróker · USD»), selector a la derecha; borde inferior.
- Grupos: 11/600 MAYÚSCULAS `text-3`. Ítems: alto 34, 13.5/500 `text-2`, ícono
  16; hover `surface-2`; **activo** `brand-tint` + `brand-ink` 600 + barra de 3
  px a la izquierda; `aria-current="page"`.
- Contador en un ítem (pendientes): píldora `pend` / `pend-bg`.
- Pie: avatar + nombre + rol.
- < 960: drawer fijo de 272 con `shadow-3`, scrim `rgb(0 0 0/.45)`, botón de
  menú en la topbar.

### 6.2 Topbar (período y frescura)

- Sticky, alto 52, padding 0 24 (16 en < 960), fondo `bg` al 88 % con
  `backdrop-filter: blur(8px)`, borde inferior.
- Izquierda: migas («Finanzas / **Balances**»; en < 640 sólo la última).
- Derecha, en orden: **frescura** (punto 7 px `pos` con halo `pos-bg` +
  «Actualizado hace 3 min»; si el dato es viejo el punto pasa a `stale`; en
  < 640 sólo el punto) · **selector de período** (‹ Sep 2026 ›, alto 32, borde
  `border-strong`, 13/600) · notificaciones · tema.
- El período de la topbar es **el** período de la pantalla: nada de un segundo
  selector dentro del contenido.

### 6.3 Página

- Contenido máx. 1360, centrado, padding 24 24 64 (16 16 48 en < 640).
- Cabecera de página: h1 + bajada a la izquierda, acciones a la derecha
  (alineadas abajo, envuelven).
- Orden típico: cabecera → franja de KPIs → banners de estado del dato →
  paneles.
- Cortes: 1100 (KPIs 3, grillas a 1 col), 960 (sidebar drawer), 720 (tablas
  tarjeta), 640 (móvil), 420 (topbar compacta).
- `prefers-reduced-motion`: sin transiciones.

---

## 7. Barra de distribución (Balances)

Pieza de la propuesta B. Va en un panel propio «Distribución del disponible»,
arriba de la tabla de saldos por canal.

```css
.dist { display:flex; height:8px; border-radius:999px; overflow:hidden; gap:2px;
        background:var(--surface-2); }
.dist i { display:block; height:100%; }
.legend { display:flex; gap:16px; flex-wrap:wrap; font-size:12px; color:var(--text-2);
          padding:12px 16px 16px; }
.legend span { display:inline-flex; align-items:center; gap:6px; }
.legend i { width:10px; height:10px; border-radius:2px; }
```

Reglas:
- Base = **activos líquidos**, antes de restar deuda. Las deudas (negativas) y
  «Prestado» **no** entran a la barra; el subtítulo lo dice.
- Máximo 5 segmentos con nombre + «Otros» (todo lo < 2 % se agrupa ahí).
- Colores: rampa **secuencial de la marca** (`brand-ink` al 100 / 75 / 55 /
  40 / 28 %) y «Otros» en `border-strong`. **No** se usan `pos/neg/pend` —
  serían color con significado falso. Un canal `stale` lleva su segmento con
  rayado (`repeating-linear-gradient`) del mismo tono, no otro color.
- Cada segmento: `title` con nombre y monto (`formatMoney`); la barra completa
  `role="img"` con `aria-label` que enumera los porcentajes. La leyenda repite
  nombre + % en 600 `text`: la barra nunca es la única fuente del dato.
- Los % se calculan sobre los mismos números que la tabla (`tallyCash`): una
  sola fórmula.

---

## 8. Plan de fases

| Fase | Qué | Estado |
|---|---|---|
| 0 | Bugs visuales existentes: `--positive` `#047857`, `--warning` `#A15C07` (AA); 20 clases `bg-x/10/30` inválidas → `bg-x/10` | **Hecha** (2026-10-12) |
| 1 | Tokens nuevos en `globals.css` + utilidades Tailwind + test de valores y contraste | **Hecha** (2026-10-12) |
| 2 | `formatMoney` único (`src/lib/money.ts`), `formatCurrency`/`pdfMoney` delegan, 19 `toLocaleString` de dinero reemplazados | **Hecha** (2026-10-12) |
| 3 | Superficies y neutros: `background/card/foreground/border/muted-foreground` a los valores de la maqueta; `negative` → `neg`; legados como alias de los nuevos; anillo de foco a `--focus`. (`brand-tint` derivado y sidebar: hechos en §10, el sidebar NO sigue el tema) | Pendiente |
| 4 | Componentes base en `src/components/ui/`: `Button`, `Panel`, `KpiStrip`, `Badge`, `Banner`, `FinTable` (con modo tarjeta), `DistBar`, `Seg`, `Chip` | Pendiente |
| 5 | Pantallas, de a una: **Balances** y **Movimientos** primero (las maquetas), después Socios, Comisiones, Órdenes de pago | Pendiente |
| 6 | Lint (§9) en modo error; borrar los tokens legados sin uso | **Guardia hecha** (2026-10-12, `design-guard.test.ts` + eslint): 1-2 de §9.3 y legados; quedan 4-5 y borrar los tokens legados |

Cada fase deja `tsc`, `eslint`, `vitest` y `build` en verde, y no cambia el
aspecto de lo que no le toca.

### Pendientes detectados en las fases 0-2 (no arreglados)

- **Rojo legado sobre `muted`**: `#DC2626` sobre `#F1F5F9` = 4,41:1. Lo cierra
  la fase 3 (`neg`). Fijado en `design-tokens.test.ts` como brecha conocida.
- **Paleta cruda junto a tokens**: varios avisos tienen `bg-negative/10` con
  `text-red-700 dark:text-red-300` (los mismos 20 lugares de la fase 0 y
  muchos más). Fase 3/5. **Resuelto** en el barrido final (2026-10-12, §9.1).
- **Formateadores de dinero fuera de `toLocaleString`**: `src/lib/risk/rules.ts`
  (`$${x.toFixed(2)}` en el detalle de violaciones) y
  `src/lib/payment-orders/delete.ts` (`USD 1234.00` en el audit). Fase 5/6.
- Saldos en cripto (`balances/page.tsx`, cantidades en la moneda de la wallet
  con hasta 8 decimales) **no son dinero en USD** y no pasan por `formatMoney`.

---

## 9. Guardia (hecha el 2026-10-12) y lint

### 9.1 La guardia: `src/lib/design-guard.test.ts`

Después de migrar todas las pantallas, el barrido final encontró igual **443
ocurrencias en 59 archivos** que se habían colado pantalla por pantalla. Sin
una guardia, cada PR nuevo vuelve a meter un `text-emerald-600 dark:…` y el
sistema se degrada en silencio. Por eso el test es obligatorio y corre con
`npx vitest run`.

**Cómo funciona** (`src/lib/design-guard.ts`):

- Recorre `src/app`, `src/components` y `src/lib` (`.ts`/`.tsx`), salvo los
  `*.test.ts(x)` y la propia guardia.
- Parsea cada archivo con el compilador de TypeScript y mira **sólo los
  literales** de string y de template: ahí viven las clases. Los comentarios y
  el texto de JSX quedan afuera sin heurísticas (un `//` de URL o un
  apóstrofe no lo confunden).
- Cuatro categorías:
  - **a) paleta cruda**: `(bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|placeholder|shadow|accent|caret)-(red|…|stone)-NN`, `bg-/border-…-white|black` y hex arbitrario (`bg-[#…]`).
  - **b) `dark:` que fija color**: `dark:(hover:)*<prefijo de color>-…`. (`dark:hidden` / `dark:block` para el logo claro/oscuro no es color y pasa.)
  - **c) `text-[10px]` / `text-[11px]`**.
  - **d) legados**: `*-muted-foreground`, `bg-muted`, `text-white`/`text-black`, `[var(--color-primary)]`, `text-primary`, `(text|bg|border[-lado]|ring|…)-(positive|negative|warning)`.
- Falla con `archivo:línea [categoría] clase` + la línea.
- **Allowlist** (`DESIGN_GUARD_ALLOWLIST`): archivo + clase + cantidad +
  porqué (≥ 40 caracteres). El test también falla si una entrada **ya no
  matchea** (o matchea otra cantidad): no se acumulan excepciones muertas.

**Allowlist vigente:**

| Archivo | Clase | Por qué |
|---|---|---|
| `src/app/(dashboard)/perfil/page.tsx` | `bg-white` | Placa del QR de 2FA: el lector necesita módulos oscuros sobre blanco puro, también en oscuro. |
| `src/components/company-logo.tsx` | `bg-white` | Placa del logo a color de una empresa cualquiera (superadmin). Mismo criterio que `--sidebar-plate`. |

El velo de modales (`bg-black/45` de la spec) **no** está en la allowlist:
pasó a ser el token `bg-scrim` (§2.2).

**Antes → después del barrido** (ocurrencias; una línea puede contar en dos
categorías, p. ej. `dark:bg-red-950` es a y b):

| Categoría | Antes | Después |
|---|---|---|
| a) paleta cruda | 109 | 2 (allowlist) |
| b) `dark:` de color | 38 | 0 |
| c) 10/11 px | 13 | 0 |
| d) legados | 283 | 0 |
| **Total** | **443** (59 archivos) | **2** |

Lo que se hizo con lo legado: `text-muted-foreground` → `text-text-3` (alias
exacto, no cambia el aspecto), `bg-muted` → `bg-surface-2`,
`positive/negative/warning` → `pos/neg/pend` (con `/10` → `*-bg`), y el resto
según la tabla de §2.4. `ui/button.tsx` (8 pantallas) quedó con tokens y sus
medidas; `ActionButton` se mudó a `src/components/ui/action-button.tsx` (la
ruta vieja `payment-orders/action-button` re-exporta). Los mapas de estado de
Riesgo (`risk-kinds.ts`) se mudaron a `STATUS_DOMAINS` en
`ui/status-kind.ts` con un test que compara cada mapa entero contra el de
antes; los de RRHH (`hr-view.ts`) se quedan porque cada estado es
`{ kind, labelKey }` y mudar el kind partiría el registro en dos.

### 9.2 Lint (refuerzo en el editor)

`eslint.config.mjs` tiene `no-restricted-syntax` (error) sobre `Literal` y
`TemplateElement` para a), b) y c). Avisa mientras se escribe; **la guardia es
el test** (cubre d), la allowlist y da el inventario). Los tests y
`design-guard.ts` están excluidos porque fijan clases a propósito.

### 9.3 Reglas que todavía no están automatizadas

Pendientes de la lista original (ESLint `no-restricted-syntax` / plugin propio
+ el test de tokens):

1. **Sin paleta cruda de color** en `className`: `(text|bg|border|ring|fill|stroke)-(red|rose|emerald|green|amber|yellow|orange|blue|sky|indigo|violet|purple|slate|gray|zinc|neutral)-\d{2,3}`.
2. **Sin `dark:` de color** (`dark:(text|bg|border)-…`): los tokens flipan solos.
3. **Sin doble opacidad** (`/\d+/\d+`) — ya lo verifica `design-tokens.test.ts`.
4. **Sin hex en `className`/`style`** de componentes (`#[0-9a-f]{3,8}`), salvo
   PDFs/emails que importan de `brand.ts`.
5. **Dinero sólo con `formatMoney`**: prohibido `toLocaleString`/`Intl.NumberFormat`
   con `style: 'currency'` o `minimumFractionDigits: 2` fuera de `money.ts`, y
   el template `` `$${…}` ``.
6. **Sin `@media (prefers-color-scheme)`** en CSS de la app (el tema es la
   clase `.dark`) — ya lo verifica el test.
7. Tablas financieras: números con `tabular-nums` y alineados a la derecha
   (regla de revisión, no de lint).

---

## 10. Color de marca y sidebar oscuro (decisión 2026-10-12)

> Kevin, al ver el diseño en producción: *«quedó bien, pero se ve muy plano, me
> gustaría agregarle más colores y que el menú del lado tenga un color oscuro.
> También recuerda que cada marca sube su isotipo y sus colores para que quede
> customizado».*

### 10.1 La regla, ajustada

- **La marca va en la estructura; la semántica, en los datos.** Navegación,
  encabezados, acentos, selección y series de gráfico *sin* significado llevan
  el color de la empresa. Montos, badges de estado, banners y deltas siguen en
  `pos / neg / pend / info / stale` (§2.1) y **ningún token de esta sección se
  usa para pintar un número** — un monto en el azul o el rojo de la marca se
  leería como «info» o como «pérdida». Hay un test que verifica que ningún
  token de significado depende de la marca.
- **Nunca el color crudo.** Todo sale de `color_primary` y `color_secondary`
  vía `src/lib/brand-color.ts` (única fuente de colores derivados) y se inyecta
  en `src/lib/theme-apply.ts` (`companyThemeVars`, lista única `VARS` que
  `resetCompanyTheme` limpia). `globals.css` elige la variante del tema y tiene
  como respaldo la marca del producto (`#1E3A5F / #3B82F6`), recalculada por
  `brand-theme.test.ts`. Sin empresa (login, superadmin) se ven los respaldos.
- **Secundario gris → primario** (`usableSecondary`). Un secundario blanco o
  negro (croma < 12 %) no sirve de acento: desaparece en uno de los dos temas.
  En prod: Exura Prime carga `#ffffff` y Exura Liquidez `#000000`; en las dos el
  acento (foco, chip/segmented activo, línea de la topbar, ítem activo del
  menú) es su rojo, corregido por contraste. Antes del cambio su `--accent` era
  un gris `#767676`.

### 10.2 Sidebar oscuro de marca

- Fondo `sidebar-bg` = primario mezclado ≥ 50 % hacia un casi-negro azulado
  (`#05080F`) y más si hace falta hasta **≥ 14:1 contra blanco**. Conserva el
  tono: navy → `#122137`, Exura Prime → `#52141F` (bordó), Exura Liquidez →
  `#5B0509`. Nunca `slate-900` ni un negro genérico. Igual en claro y oscuro:
  los tokens `sidebar-*` viven **sólo en `:root`**.
- `sidebar-fg` (texto principal, 94 % blanco), `sidebar-muted` (ítems y
  rótulos, ≥ 4,5:1 sobre fondo y hover), `sidebar-hover`, `sidebar-border`.
- **Activo**: fondo `sidebar-active-bg` (fondo teñido 24 % con el acento),
  texto `sidebar-fg` 600, ícono y barra de 3 px en `sidebar-accent` (acento
  usable aclarado: ≥ 4,5:1 sobre el fondo, ≥ 3:1 sobre el activo).
- **Grupos**: rótulo 12/600 MAYÚSCULAS `sidebar-muted` con el ícono del grupo
  coloreado: Finanzas = acento de marca, RRHH `#C4B5FD`, Riesgo `#5EEAD4`,
  General `#CBD5E1` (`nav-*`, ≥ 3:1). Nunca verde/rojo/ámbar. El acordeón, el
  localStorage y `NAV_ENTRIES` no cambiaron.
- **Foco**: `data-surface="brand-dark"` cambia el anillo a `sidebar-accent`
  (el `--accent` global no llega a 3:1 sobre un fondo bordó).
- **Logo** (URL vacía `''` = no hay; una imagen que no carga cae a la
  siguiente opción):
  - expandido: `logo_url_white`; si no hay, `logo_url` sobre una placa blanca;
    si no hay ninguno, isotipo/inicial + nombre. Debajo, modelo · moneda.
  - contraído: `logo_icon_url` sobre placa blanca; si no hay, la **inicial**
    en un cuadro `sidebar-accent` con texto `sidebar-bg`.
  - El margen transparente de los logos se recorta en el cliente
    (`src/lib/logo-trim.ts`, por canal alfa; si no hay CORS o no hay
    transparencia, se usa la URL tal cual). Motivo: el logo blanco de Exura
    Prime es una palabra ancha en un PNG de 2250×2250 y a 28 px de alto no se
    leía.
  - En prod: Vex Pro y AP Markets → logo blanco expandido, inicial contraído;
    Exura Prime → logo blanco, inicial (su `logo_icon_url` es `''`); Exura
    Liquidez y Horizon* / Vonix → inicial + nombre.
- Pastilla de pendientes: sigue `pend-bg` + `pend` (autocontenida, ≥ 4,5:1).

### 10.3 Tokens nuevos

| Token (utilidad) | Claro | Oscuro | Uso |
|---|---|---|---|
| `brand-tint` (`bg-brand-tint`) | tono del acento al 12 % sobre blanco, hasta que `brand-ink` encima ≥ 4,5 | acento al 20 % sobre `#0B1222`, ídem | chip activo, cuadro de ícono de panel/KPI |
| `brand-wash` (`bg-brand-wash`) | acento al 5 % sobre blanco | acento al 10 % sobre la tarjeta | cabecera de FinTable, cabecera de Panel `accent` |
| `sidebar-bg/fg/muted/hover/border/accent/active-bg` | igual en los dos temas | — | sidebar y columna de marca del login |
| `sidebar-plate` | `#FFFFFF` | — | placa de un logo a color sin versión blanca |
| `nav-finance/hr/risk/config` | ver §10.2 | — | ícono de cada grupo del menú y filete de cada área en el login |
| `chart-1…7` (CSS var) | acento, `brand-ink`, sus escalones al 55/50 % sobre la tarjeta, `#8B5CF6`, `#0891B2`, `#808DA1` | flipan con `--accent/--brand-ink/--card` | series sin significado (donut de departamentos) |

Variables inyectadas por empresa (además de las de `--brand-primary-*` /
`--brand-secondary-*`): `--brand-tint-{light,dark}`, `--brand-wash-{light,dark}`,
`--brand-sidebar-{bg,fg,muted,hover,border,accent,active-bg}`.

### 10.4 Dónde va el color (primitivas)

- **Topbar**: línea de 2 px al pie, degradé `brand-ink` → `accent` →
  transparente; el grupo de las migas en `brand-ink`. Frescura (pos/stale) y
  período no cambian.
- **PageHeader**: el cuadro del ícono es relleno de marca (`bg-primary` +
  `brand-on-primary`, 36 px).
- **KpiStrip**: filete superior 2 px `brand-ink` en toda la franja; `icon`
  opcional por KPI en un cuadro `brand-tint`. El valor nunca toma la marca.
- **Panel**: `accent` (destacado: filete superior 2 px `brand-ink` + cabecera
  `brand-wash`) e `icon` (cuadro `brand-tint`) opcionales.
- **FinTable**: cabecera `brand-wash` con texto `text-2` (el `text-3` quedaba
  al borde de AA sobre el lavado).
- **Segmented**: activo con texto `brand-ink` y filete inferior de 2 px de
  marca (además de superficie + sombra + 600). **Chip**: activo como antes
  (`brand-tint` + `brand-ink`), hover del inactivo en `brand-ink`.
- **StatusBadge / Notice**: los `*-bg` de significado son algo más saturados
  (tabla §2.2); el texto sigue ≥ 4,5:1.
- **Login** (`auth-shell.tsx`): la columna de marca usa `sidebar-bg` (sin
  empresa = respaldos del producto), logo blanco, lema y las tres áreas en
  texto con un filete del color de su grupo. Sin cifras de ejemplo.
- **Gráficos**: el donut de departamentos usa `chart-1…7`; las series con
  significado (ingresos, retiros, aprobadas…) siguen en tokens semánticos.

### 10.5 Contraste (fijado en `src/lib/brand-theme.test.ts`)

Con Vex (default), Exura Prime y Exura Liquidez, en claro y oscuro: `brand-ink`
≥ 4,5 sobre tarjeta, fondo y `brand-tint`; texto sobre el relleno de marca ≥
4,5; `text-2` y `foreground` sobre `brand-wash` ≥ 4,5; acento y filetes ≥ 3
sobre la tarjeta; sidebar: fondo ≥ 14:1 contra blanco y no gris, texto/apagado
≥ 4,5 sobre fondo, hover y activo, acento ≥ 4,5 sobre el fondo y ≥ 3 sobre el
activo, íconos de grupo ≥ 3. Valores medidos del sidebar:

| Marca | fondo | texto / fondo | apagado / fondo | acento / fondo | acento / activo |
|---|---|---|---|---|---|
| Vex (default) | `#122137` | 14,43 | 8,11 | 4,54 (`#3F85F6`) | 3,27 |
| Exura Prime | `#52141F` | 12,68 | 7,21 | 4,56 (`#DF707C`) | 3,64 |
| Exura Liquidez | `#5B0509` | 12,65 | 7,00 | 4,63 (`#EA6B6B`) | 3,69 |

### 10.6 Descartado

- Volver a `bg-slate-900` para el sidebar: un negro genérico, igual para todas
  las marcas — justo lo que se pidió evitar.
- Pintar el fondo del sidebar con el primario crudo: `#db0000` de fondo no deja
  leer nada y ninguna marca clara pasaría contraste.
- Usar el secundario tal cual: con blanco/negro el acento desaparece.
- Teñir la topbar entera o el fondo de la página: con el sidebar ya oscuro de
  marca, dos bloques de color compiten y el período pierde peso.
- Pintar el valor de los KPIs o los montos con la marca (ver §10.1).

### 10.x Marcas rojas: el rojo sólo en el menú (Kevin, 2026-10-12)

Si el primario o el secundario usable de una empresa es rojo (`clashesWithLoss`
en `src/lib/brand-color.ts`: tono 340°–20°, saturación ≥ 40 %), ese color se usa
**sólo en el sidebar y el login** (`buildSidebarPalette` con los colores
cargados). Todo el contenido —encabezados, KPIs, tablas, segmentos, línea de la
topbar— usa los colores del producto (`#1E3A5F` / `#3B82F6`), porque un cuadro
rojo al lado de números en `neg` se lee como alerta. Hoy aplica a Exura Prime
(#cf2738) y Exura Liquidez (#db0000). Superadmin lo avisa en la sección Marca.
