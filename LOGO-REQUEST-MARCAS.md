# Especificaciones del logo para Smart Dashboard

Para que el logo de la marca se vea impecable en el dashboard (sidebar, login, reportes, PDFs, email), necesitamos **dos versiones** del logo con las siguientes características:

---

## 1. Versión sobre fondo CLARO (colores normales de la marca)

Esta es la que se usa en la mayoría de lugares: login, reportes PDF, emails, etc.

- **Formato preferido:** `SVG` (vectorial)
- **Alternativa aceptable:** `PNG` con fondo **transparente**
- **Resolución mínima (si es PNG):** 800 px en el lado más largo — idealmente 1200 px o más
- **Fondo:** transparente (ni blanco ni de color)
- **Uso previsto:** fondos blancos / claros

---

## 2. Versión sobre fondo OSCURO (monocromo blanco)

Esta es la que se usa en el sidebar del dashboard (fondo slate oscuro). Es la misma forma del logo pero en **blanco sólido**.

- **Formato preferido:** `SVG`
- **Alternativa aceptable:** `PNG` transparente
- **Fondo:** transparente
- **Color:** blanco puro (`#FFFFFF`) o un blanco ligeramente grisáceo si la identidad lo requiere
- **Uso previsto:** sidebar, headers oscuros, overlays

---

## 3. Especificaciones generales (aplican a ambas versiones)

| Criterio | Recomendación |
|---|---|
| **Proporción** | Cualquiera, pero preferimos entre cuadrado (1:1) y horizontal 3:1. Evitar logos extremadamente angostos o muy anchos |
| **Espacio de respeto** | Que el logo venga con un pequeño margen interno (padding) para que no quede pegado a los bordes |
| **Colores** | Deben ser los oficiales de la marca. Si tienen guía de marca / manual, mejor — nos la comparten |
| **Textos dentro del logo** | Que sean nítidos y legibles incluso a tamaño pequeño (h-40 / 40px de alto) |
| **Versiones para diferentes tamaños** | Opcional. Si el logo tiene mucho detalle, también aceptamos una versión simplificada para tamaños chicos (favicon 32×32) |

---

## 4. Formatos que NO usamos

- ❌ `JPG` / `JPEG` — no tiene transparencia
- ❌ `PDF` — difícil de renderizar en web
- ❌ `AI` / `EPS` — formatos nativos de Illustrator (necesitamos export a SVG)
- ❌ Logos con fondo blanco sólido "pegado" — tiene que ser transparente
- ❌ Logos con sombra paralela, brillos o efectos de profundidad que no se traduzcan bien a SVG

---

## 5. Cómo exportar desde Illustrator / Figma / etc.

**Desde Illustrator:**
- File → Export → Export As → formato **SVG**
- Styling: "Inline Style"
- Font: "Convert to Outlines" (importante si el logo tiene tipografía custom)
- Object IDs: "Layer Names"
- Minify: ✔

**Desde Figma:**
- Seleccionar el frame del logo → Export → Format **SVG** → Export

**Desde Photoshop (solo si no hay otra opción):**
- File → Export As → **PNG**
- Transparency: ✔
- Image Size: mínimo 1200 px en el lado más largo

---

## 6. Qué nos mandan

Un `.zip` (o carpeta compartida) con estos archivos:

```
marca-logo-color.svg         ← versión colores, fondo transparente
marca-logo-blanco.svg        ← versión blanca, fondo transparente
marca-logo-color.png         ← (opcional) PNG fallback 1200px
marca-logo-blanco.png        ← (opcional) PNG fallback 1200px
guia-de-marca.pdf            ← (opcional) si tienen manual de marca
```

Si tienen dudas sobre qué versión exactamente, manden las dos (color + blanco) en SVG y nosotros lo configuramos.

---

**Dashboard:** https://dashboard.horizonconsulting.ai
**Contacto:** Kevin — Horizon Consulting
