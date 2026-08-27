// ─────────────────────────────────────────────────────────────────────────────
// El bucle de tool use del asistente, con streaming.
//
// Vive acá y no dentro del route handler por una razón concreta: es lo único
// del asistente que hay que poder testear sin gastar API. La ruta se queda con
// autenticación, persistencia y el transporte SSE; toda la lógica de "pedir,
// ejecutar herramientas, volver a pedir" es este generador, que recibe el
// cliente del modelo por parámetro y en los tests recibe uno falso.
//
// ── POR QUÉ EL BUCLE ES MANUAL Y NO EL TOOL RUNNER DEL SDK ────────────────
// El tool runner del SDK (beta) resuelve el bucle solo, pero necesitamos tres
// cosas que quedan a mitad de camino con él: emitir un evento «consultando X»
// por cada herramienta ANTES de ejecutarla (la persona tiene que ver qué está
// pasando durante los segundos de consulta), volver a chequear el módulo en
// cada ejecución, y envolver cada resultado como dato no confiable. Con el
// bucle manual las tres cosas son tres líneas en el lugar obvio.
//
// ── EL TOPE DE TURNOS NO ES DECORATIVO ────────────────────────────────────
// Sin tope, un modelo que se equivoca de herramienta puede quedarse llamando
// en círculo hasta el timeout de la función, y el que pregunta ve un spinner
// eterno mientras se factura. Al llegar al tope se corta y se le dice al
// modelo que conteste con lo que tiene, en vez de cortar el stream y dejar a
// la persona sin respuesta.
// ─────────────────────────────────────────────────────────────────────────────

import type Anthropic from '@anthropic-ai/sdk';
import { runTool, toolsForContext, type AssistantContext } from './tools';
import { envolverResultado } from './prompt';

/** El modelo exacto. Sin sufijo de fecha: el id de la tabla es completo tal cual. */
export const MODELO = 'claude-opus-5';

/**
 * Tope de vueltas de herramienta por mensaje. 8 alcanza para la pregunta más
 * compuesta que tiene sentido acá («comparame el net deposit del mes con los
 * retiros pendientes y contame quién es el cliente que más pidió»), que usa
 * tres herramientas.
 */
export const MAX_TURNOS_HERRAMIENTA = 8;

/**
 * `max_tokens` deliberadamente por debajo del máximo del modelo. La razón es
 * dura y no de costo: la ruta corre con un presupuesto de 60 s en Vercel, y una
 * respuesta de 64k tokens no se termina de generar dentro de ese presupuesto —
 * el stream se cortaría a la mitad y la persona vería media frase. Las
 * respuestas de este asistente son resúmenes de tablero, no documentos.
 */
export const MAX_TOKENS = 16_000;

export type EventoAsistente =
  | { tipo: 'texto'; texto: string }
  | { tipo: 'herramienta'; nombre: string; entrada: Record<string, unknown> }
  | { tipo: 'limite'; turnos: number }
  | {
      tipo: 'fin';
      texto: string;
      herramientas: Array<{ nombre: string; entrada: Record<string, unknown> }>;
      usage: Record<string, number>;
    };

/**
 * Superficie mínima del cliente de Anthropic que este bucle usa. Se declara
 * estructuralmente para que el test pueda pasar un doble sin instanciar el SDK
 * ni tener una API key. `client.messages` del SDK real la satisface.
 */
export interface ClienteModelo {
  stream(params: Anthropic.MessageStreamParams): {
    on(evento: 'text', cb: (delta: string) => void): unknown;
    finalMessage(): Promise<Anthropic.Message>;
  };
}

/**
 * Puente entre el callback `on('text')` del SDK y un generador async.
 *
 * Hace falta porque un generador NO puede hacer `yield` desde dentro de un
 * callback sincrónico, y sin esto el texto sólo podría emitirse una vez
 * resuelto el mensaje entero — o sea, sin streaming. El último valor que
 * emite es el `Anthropic.Message` completo.
 */
async function* deltasYFinal(
  s: ReturnType<ClienteModelo['stream']>,
): AsyncGenerator<{ delta: string } | { final: Anthropic.Message }> {
  const cola: string[] = [];
  let despertar: (() => void) | null = null;
  const tocar = () => {
    const r = despertar;
    despertar = null;
    r?.();
  };

  s.on('text', (d) => {
    cola.push(d);
    tocar();
  });

  let terminado = false;
  let fallo: unknown = null;
  let final: Anthropic.Message | null = null;
  const promesa = s
    .finalMessage()
    .then((m) => {
      final = m;
    })
    .catch((e) => {
      fallo = e;
    })
    .finally(() => {
      terminado = true;
      tocar();
    });

  for (;;) {
    while (cola.length > 0) yield { delta: cola.shift() as string };
    if (terminado) break;
    await new Promise<void>((r) => {
      despertar = r;
    });
  }
  await promesa;
  if (fallo) throw fallo;
  // `finalMessage()` siempre resuelve con un mensaje o rechaza; si llegamos
  // acá sin mensaje y sin error, es un doble de test mal armado.
  if (!final) throw new Error('El stream terminó sin mensaje final.');
  yield { final };
}

function acumularUsage(acc: Record<string, number>, usage: Anthropic.Usage | undefined): void {
  if (!usage) return;
  const campos: Array<keyof Anthropic.Usage> = [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ];
  for (const c of campos) {
    const v = usage[c];
    if (typeof v === 'number') acc[c] = (acc[c] ?? 0) + v;
  }
}

/**
 * Corre la conversación completa emitiendo eventos a medida que pasan.
 *
 * `messages` se MUTA: al terminar contiene la conversación entera tal como se
 * le mandó al modelo, incluidos los bloques de herramienta. El llamador (y el
 * test de la puerta de módulos) puede inspeccionarlo para verificar qué entró
 * realmente al contexto.
 */
export async function* correrConversacion(opts: {
  client: ClienteModelo;
  ctx: AssistantContext;
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  maxTurnos?: number;
}): AsyncGenerator<EventoAsistente> {
  const { client, ctx, system, messages } = opts;
  const maxTurnos = opts.maxTurnos ?? MAX_TURNOS_HERRAMIENTA;

  // EL FILTRO QUE IMPORTA: las herramientas que este usuario no puede usar ni
  // siquiera se le nombran al modelo. Lo que no está acá no puede pedirse, así
  // que su dato no puede aparecer en ningún mensaje de la conversación.
  const disponibles = toolsForContext(ctx);
  const definiciones: Anthropic.ToolUnion[] = disponibles.map((t, i) =>
    // El breakpoint de caché va en la ÚLTIMA herramienta: `tools` se renderiza
    // antes que `system`, así que cachear acá cubre el bloque de herramientas
    // y el estable cubre la doctrina. Las dos son idénticas request a request.
    i === disponibles.length - 1
      ? ({ ...t.definition, cache_control: { type: 'ephemeral' } } as Anthropic.ToolUnion)
      : (t.definition as Anthropic.ToolUnion),
  );

  const usage: Record<string, number> = {};
  const herramientasUsadas: Array<{ nombre: string; entrada: Record<string, unknown> }> = [];
  let textoFinal = '';

  for (let turno = 0; ; turno++) {
    const stream = client.stream({
      model: MODELO,
      max_tokens: MAX_TOKENS,
      system,
      // Adaptivo explícito. NADA de `budget_tokens`: en Opus 5 devuelve 400.
      thinking: { type: 'adaptive' },
      ...(definiciones.length > 0 ? { tools: definiciones } : {}),
      messages,
    });

    let mensaje: Anthropic.Message | null = null;
    for await (const ev of deltasYFinal(stream)) {
      if ('delta' in ev) yield { tipo: 'texto', texto: ev.delta };
      else mensaje = ev.final;
    }
    if (!mensaje) break;
    acumularUsage(usage, mensaje.usage);

    const texto = mensaje.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (texto) textoFinal = textoFinal ? `${textoFinal}\n${texto}` : texto;

    if (mensaje.stop_reason !== 'tool_use') break;

    const llamadas = mensaje.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (llamadas.length === 0) break;

    messages.push({ role: 'assistant', content: mensaje.content });

    if (turno + 1 >= maxTurnos) {
      // Se corta el bucle pero NO la conversación: se le devuelve al modelo un
      // resultado de error por cada llamada pendiente (la API exige un
      // tool_result por cada tool_use) y se le pide que cierre con lo que
      // tiene. Cortar acá y ya dejaría el turno colgado.
      yield { tipo: 'limite', turnos: maxTurnos };
      messages.push({
        role: 'user',
        content: llamadas.map((l) => ({
          type: 'tool_result' as const,
          tool_use_id: l.id,
          is_error: true,
          content:
            'Se alcanzó el tope de consultas para este mensaje. Respondé con lo que ya tenés y ' +
            'aclarale a la persona que faltó consultar algo.',
        })),
      });
      const cierre = client.stream({
        model: MODELO,
        max_tokens: MAX_TOKENS,
        system,
        thinking: { type: 'adaptive' },
        messages,
      });
      let msgCierre: Anthropic.Message | null = null;
      for await (const ev of deltasYFinal(cierre)) {
        if ('delta' in ev) yield { tipo: 'texto', texto: ev.delta };
        else msgCierre = ev.final;
      }
      if (!msgCierre) break;
      acumularUsage(usage, msgCierre.usage);
      const tCierre = msgCierre.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (tCierre) textoFinal = textoFinal ? `${textoFinal}\n${tCierre}` : tCierre;
      break;
    }

    // Las llamadas paralelas se ejecutan en paralelo y sus resultados vuelven
    // TODOS en un solo mensaje de user: partirlos en varios mensajes le enseña
    // al modelo a dejar de pedir en paralelo (y es más lento).
    const resultados: Anthropic.ToolResultBlockParam[] = [];
    const ejecuciones = await Promise.all(
      llamadas.map(async (l) => {
        const entrada = (l.input ?? {}) as Record<string, unknown>;
        return { llamada: l, entrada, salida: await runTool(l.name, entrada, ctx) };
      }),
    );
    for (const { llamada, entrada } of ejecuciones) {
      yield { tipo: 'herramienta', nombre: llamada.name, entrada };
      herramientasUsadas.push({ nombre: llamada.name, entrada });
    }
    for (const { llamada, salida } of ejecuciones) {
      resultados.push({
        type: 'tool_result',
        tool_use_id: llamada.id,
        // Envuelto como dato no confiable SIEMPRE, sin excepción: acá adentro
        // hay texto que escribieron clientes del bróker.
        content: envolverResultado(salida),
      });
    }
    messages.push({ role: 'user', content: resultados });
  }

  yield { tipo: 'fin', texto: textoFinal, herramientas: herramientasUsadas, usage };
}
