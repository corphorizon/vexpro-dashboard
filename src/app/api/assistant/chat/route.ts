// ─────────────────────────────────────────────────────────────────────────────
// POST /api/assistant/chat — el asistente de IA del dashboard.
//
// Pedido de Kevin (2026-08-27, textual): «una herramienta DE IA POTENCIADA POR
// ANTHROPIC para admins DE BROKERS, que funcione como un chat privado de cada
// admin o socio, donde pueda hacer preguntas específicas de un cliente o
// generales de todo el broker, cosas del módulo de recursos humanos, de
// finanzas, de riesgo de trading, etc».
//
// ── RUNTIME NODE, NO EDGE ─────────────────────────────────────────────────
// El SDK de Anthropic no corre en edge (arrastra `node:fs`). Es una lección ya
// pagada en este ecosistema: la primera versión del asistente de VexPro se
// desplegó en edge y reventó en runtime, no en build.
//
// ── CÓMO FUNCIONA ─────────────────────────────────────────────────────────
//   1. `verifyAdminAuth` resuelve quién pregunta y de qué empresa. El
//      `company_id` sale del TOKEN y no se vuelve a tocar.
//   2. `resolverContexto` agrega módulos del usuario, módulos de la empresa y
//      modelo de negocio: con eso se decide qué herramientas existen.
//   3. Se carga el historial del chat (sólo texto — ver prompt.ts).
//   4. `correrConversacion` corre el bucle de tool use y emite eventos.
//   5. Cada evento sale por SSE al navegador: texto incremental y
//      «consultando X» por cada herramienta.
//   6. Al terminar se persisten los dos mensajes (el de la persona y el del
//      asistente) con el rastro de herramientas y el usage.
//
// ── POR QUÉ SE PERSISTE AL FINAL Y NO AL PRINCIPIO ────────────────────────
// Si el mensaje del usuario se guardara antes de correr el modelo, un fallo de
// la API dejaría en la conversación una pregunta sin respuesta que en el
// próximo request se re-mandaría como último turno de `user` — dos mensajes de
// user seguidos y un historial que miente. Se guardan los dos juntos o
// ninguno.
//
// ── QUÉ NO SE LOGUEA ──────────────────────────────────────────────────────
// El contenido de los mensajes NO se escribe por consola, ni en éxito ni en
// error. Los logs de Vercel los ve más gente que la que puede ver este chat, y
// el chat es privado por diseño. Se loguea el nombre de la herramienta que
// falló y nada más.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { verifyAdminAuth } from '@/lib/api-auth';
import { ASSISTANT_ROLES } from '@/lib/roles';
import { apiError } from '@/lib/api-error';
import { resolveAnthropicCredentials } from '@/lib/api-integrations/credentials';
import { resolverContexto } from '@/lib/assistant/context';
import { correrConversacion } from '@/lib/assistant/loop';
import { toolsForContext } from '@/lib/assistant/tools';
import {
  buildSystem,
  construirHistorial,
  tituloDesdeMensaje,
  MAX_TURNOS_HISTORIAL,
  type MensajeGuardado,
} from '@/lib/assistant/prompt';

// Node, no edge. Ver cabecera.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 60 s es el techo del plan. `MAX_TOKENS` en loop.ts está calibrado para que
// una respuesta entre en ese presupuesto incluso con dos vueltas de
// herramienta.
export const maxDuration = 60;

/** Tope del mensaje de entrada. Nadie escribe una pregunta de 8.000 caracteres. */
const MAX_MENSAJE = 4_000;

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, {
      roles: ASSISTANT_ROLES,
      modules: ['assistant'],
    });
    if (auth instanceof NextResponse) return auth;

    const body = (await request.json().catch(() => null)) as {
      chatId?: unknown;
      message?: unknown;
      locale?: unknown;
    } | null;

    const mensaje = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!mensaje) {
      return NextResponse.json(
        { success: false, error: 'Falta el mensaje.' },
        { status: 400 },
      );
    }
    if (mensaje.length > MAX_MENSAJE) {
      return NextResponse.json(
        { success: false, error: `El mensaje supera los ${MAX_MENSAJE} caracteres.` },
        { status: 400 },
      );
    }
    const locale: 'es' | 'en' = body?.locale === 'en' ? 'en' : 'es';

    // ── La credencial ──────────────────────────────────────────────────
    // Por empresa primero, env como fallback (ver credentials.ts). Sin
    // ninguna de las dos, el asistente no está configurado: se dice claro y
    // con un código propio para que la pantalla muestre la ayuda correcta en
    // vez de un error genérico.
    const cred = await resolveAnthropicCredentials(auth.companyId);
    if (!cred) {
      return NextResponse.json(
        {
          success: false,
          code: 'assistant_not_configured',
          error:
            'El asistente no está configurado para esta empresa. Un administrador tiene que cargar ' +
            'la API key de Anthropic en el panel de credenciales.',
        },
        { status: 503 },
      );
    }

    const { ctx, companyName } = await resolverContexto(auth, locale);
    const db = ctx.db;

    // ── El chat ────────────────────────────────────────────────────────
    // Un chatId ajeno no da error distinto de uno inexistente: las dos
    // condiciones responden lo mismo para no confirmar la existencia del chat
    // de otra persona.
    let chatId = typeof body?.chatId === 'string' ? body.chatId : null;
    let historial: MensajeGuardado[] = [];

    if (chatId) {
      const { data: chat, error } = await db
        .from('ai_chats')
        .select('id')
        .eq('id', chatId)
        .eq('company_id', auth.companyId)
        .eq('user_id', auth.userId)
        .maybeSingle();
      if (error) throw error;
      if (!chat) {
        return NextResponse.json(
          { success: false, error: 'La conversación no existe.' },
          { status: 404 },
        );
      }
      const { data: msgs, error: msgErr } = await db
        .from('ai_chat_messages')
        .select('role, content')
        .eq('chat_id', chatId)
        .eq('company_id', auth.companyId)
        .eq('user_id', auth.userId)
        .order('created_at', { ascending: true })
        // Se trae un poco más de lo que se va a usar para que el recorte de
        // `construirHistorial` (que descarta vacíos y turnos huérfanos) tenga
        // material y no devuelva menos turnos de los que corresponde.
        .limit(MAX_TURNOS_HISTORIAL * 2);
      if (msgErr) throw msgErr;
      historial = (msgs ?? []) as MensajeGuardado[];
    } else {
      const { data: nuevo, error } = await db
        .from('ai_chats')
        .insert({
          company_id: auth.companyId,
          user_id: auth.userId,
          title: tituloDesdeMensaje(mensaje),
        })
        .select('id')
        .single();
      if (error) throw error;
      chatId = nuevo.id as string;
    }

    const disponibles = toolsForContext(ctx);
    const system = buildSystem({
      companyName,
      hoyUtc: new Date().toISOString().slice(0, 10),
      locale: ctx.locale,
      modulosDisponibles: disponibles.map((t) => t.name),
    });
    const messages = construirHistorial(historial, mensaje);

    const client = new Anthropic({ apiKey: cred.apiKey });

    // ── SSE ────────────────────────────────────────────────────────────
    const encoder = new TextEncoder();
    const chatIdFinal = chatId;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const mandar = (evento: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(evento)}\n\n`));
        };
        mandar({ tipo: 'inicio', chatId: chatIdFinal });

        try {
          for await (const ev of correrConversacion({ client: client.messages, ctx, system, messages })) {
            if (ev.tipo === 'fin') {
              // Persistencia atómica-en-intención: los dos turnos juntos. Si
              // el insert falla, la persona YA vio la respuesta en pantalla;
              // lo que se pierde es el historial, no la respuesta. Por eso el
              // fallo se traga y se avisa por el evento, sin romper el stream.
              const base = {
                chat_id: chatIdFinal,
                company_id: auth.companyId,
                user_id: auth.userId,
              };
              const { error: insErr } = await db.from('ai_chat_messages').insert([
                { ...base, role: 'user', content: mensaje },
                {
                  ...base,
                  role: 'assistant',
                  content: ev.texto,
                  tool_calls: ev.herramientas.length > 0 ? ev.herramientas : null,
                  usage: { ...ev.usage, credencial: cred.source },
                },
              ]);
              if (insErr) {
                console.warn('[assistant] no se pudo guardar el turno:', insErr.message);
              }
              await db
                .from('ai_chats')
                .update({ updated_at: new Date().toISOString() })
                .eq('id', chatIdFinal)
                .eq('company_id', auth.companyId)
                .eq('user_id', auth.userId);

              mandar({
                tipo: 'fin',
                chatId: chatIdFinal,
                herramientas: ev.herramientas.map((h) => h.nombre),
                guardado: !insErr,
              });
            } else {
              mandar(ev);
            }
          }
        } catch (err) {
          // Errores tipados, del más específico al menos: cada uno manda a
          // arreglar una cosa distinta y un mensaje genérico los aplana.
          let texto = 'El asistente no pudo responder. Probá de nuevo en un momento.';
          if (err instanceof Anthropic.AuthenticationError) {
            texto =
              'La API key de Anthropic de esta empresa no es válida. Hay que revisarla en el panel ' +
              'de credenciales.';
          } else if (err instanceof Anthropic.RateLimitError) {
            texto = 'Se alcanzó el límite de consultas de la API. Esperá un momento y volvé a preguntar.';
          } else if (err instanceof Anthropic.BadRequestError) {
            texto = 'La consulta fue rechazada por la API. Probá reformulando la pregunta.';
          } else if (err instanceof Anthropic.APIConnectionError) {
            texto = 'No se pudo contactar a la API de Anthropic.';
          }
          // NUNCA el contenido del mensaje ni el detalle crudo al log.
          console.warn(
            '[assistant] fallo del modelo:',
            err instanceof Error ? err.name : 'desconocido',
          );
          mandar({ tipo: 'error', mensaje: texto });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        // Sin esto algunos proxies bufferizan el SSE entero y el streaming
        // deja de ser streaming: la persona ve todo de golpe al final.
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    return apiError('assistant/chat', err, { status: 500 });
  }
}
