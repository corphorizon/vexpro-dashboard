// Stub de `server-only` para vitest.
//
// `server-only` es un paquete que Next.js provee para que un módulo falle el
// build si se importa desde un componente cliente. En el entorno de test (node)
// no está instalado y su import revienta la resolución. Este stub vacío lo
// reemplaza vía alias en vitest.config.ts; la protección real sigue vigente en
// el build de Next, que es donde importa.
export {};
