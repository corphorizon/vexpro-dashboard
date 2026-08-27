<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Antes de tocar código de este repo

Leé **[docs/reglas-del-proyecto.md](docs/reglas-del-proyecto.md)**: el mapa de los
módulos, las reglas que no se rompen y las trampas conocidas.

Lo mínimo que hay que saber:

- **El enemigo es el fallo que no da error.** Los bugs graves de acá no lanzaron
  excepciones: devolvieron un número plausible y equivocado. Toda exclusión y
  todo recorte de filas tiene que **contarse y avisarse** — un recorte silencioso
  es indistinguible de "no hay más".
- **Listas duplicadas que se desincronizan en silencio son el modo de falla
  número uno.** Módulos, roles, proveedores y categorías tienen **un solo**
  registro canónico. Nunca crees una segunda lista.
- **Leer lo decide el módulo; escribir lo sigue decidiendo el rol.**
  `company_id` sale siempre del token, y con el admin client (service role) el
  `.eq('company_id', …)` es obligatorio: RLS no te cubre.
- **El dinero no se toca sin leer la sección 2.** Cada regla de ahí es un bug que
  ya pagó mal.
- **`null` y `0` no son lo mismo**: "no lo sabemos" y "es cero" son datos
  distintos.
- Cuando arregles algo no obvio, dejá la cabecera con **el porqué, la medición y
  lo que descartaste**. Es el estándar del repo y es lo que hace que esto se
  pueda mantener.
