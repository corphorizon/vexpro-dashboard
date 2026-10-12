'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /asistente — el chat privado con el asistente de IA.
//
// ── LA PANTALLA TIENE QUE DECIR TRES COSAS SIN QUE NADIE PREGUNTE ─────────
// 1. Que la conversación es PRIVADA. Si la persona no lo sabe, o no escribe lo
//    que realmente quiere preguntar, o lo escribe creyendo que nadie lo lee y
//    después se entera de que sí. Las dos son malas; la segunda es peor.
// 2. QUÉ está consultando el asistente mientras tarda. Una consulta a la cola
//    de retiros son segundos de silencio: sin el indicador, la persona no sabe
//    si el sistema está trabajando o colgado, y recarga.
// 3. Que la respuesta la generó una IA y hay que verificarla. Va en un pie
//    FIJO, siempre visible, no en un tooltip: la advertencia que hay que
//    buscar no es una advertencia.
//
// ── POR QUÉ SE LEE EL SSE A MANO Y NO CON EventSource ─────────────────────
// `EventSource` sólo hace GET y no manda cuerpo, y acá el mensaje va en el
// POST. Se lee el ReadableStream y se parte por `\n\n`, que es el separador de
// eventos de SSE. El buffer parcial se conserva entre chunks porque un evento
// puede llegar partido al medio — sin eso, un JSON.parse falla cada tanto de
// forma aparentemente aleatoria.
//
// ── «LIBRO MAYOR» (2026-10-12) ───────────────────────────────────────────
// Paneles con borde de 1 px (historial y conversación), ítem activo del
// historial en `brand-tint` / `brand-ink` (como el menú), burbuja del
// asistente en `surface-2`, aviso de «no configurado» con Notice `pend`,
// pie de IA y privacidad a 12 px (eran 11 px, por debajo del mínimo de la
// spec). Botones con ActionButton (el `Button` legado tiene `text-white` fijo).
// Y dos fallos que no daban error (chat-list.ts, con test): el historial
// decía «Todavía no hay conversaciones» si la carga fallaba o MIENTRAS
// cargaba, y el `truncated` que la API manda (50 chats / 200 mensajes) nunca
// llegaba a la pantalla. Ahora se dice. Mismos endpoints y payloads.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles, Send, Plus, Trash2, Lock, Wrench } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { Notice } from '@/components/ui/notice';
import { Textarea } from '@/components/ui/field';
import { useToasts } from '@/components/ui/toast';
import { ActionButton, ROW_ACTION_CLASS } from '@/components/ui/action-button';
import { useConfirm } from '@/lib/use-confirm';
import { useI18n } from '@/lib/i18n';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { cn } from '@/lib/utils';
import {
  INITIAL_CHAT_LIST,
  chatListFromResponse,
  chatListView,
  messagesTruncated,
  type ChatListState,
  type ChatResumen,
} from './chat-list';

interface Turno {
  role: 'user' | 'assistant';
  content: string;
  /** Nombres de herramienta consultadas para producir este turno. */
  tools?: string[];
  /** Turno todavía en curso: se dibuja el cursor y no se ofrece nada más. */
  enCurso?: boolean;
}


/**
 * Respuesta del asistente renderizada como Markdown (GFM: tablas incluidas).
 * Sin `rehype-raw`: el HTML embebido queda como texto, nunca como DOM — las
 * respuestas citan datos del CRM que son contenido no confiable.
 */
function MarkdownRespuesta({ texto }: { texto: string }) {
  return (
    <div className="asistente-md space-y-2 [&_p]:leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <p className="font-semibold text-base" {...p} />,
          h2: (p) => <p className="font-semibold" {...p} />,
          h3: (p) => <p className="font-semibold" {...p} />,
          ul: (p) => <ul className="list-disc pl-5 space-y-1" {...p} />,
          ol: (p) => <ol className="list-decimal pl-5 space-y-1" {...p} />,
          a: ({ children }) => (
            // Los datos vienen del CRM (no confiables): ningún enlace vivo.
            <span className="underline decoration-dotted">{children}</span>
          ),
          code: (p) => (
            <code className="rounded-ui-sm bg-card px-1 py-0.5 font-mono text-[0.85em]" {...p} />
          ),
          table: (p) => (
            <div className="overflow-x-auto -mx-1">
              <table className="w-full border-collapse text-[12.5px] tabular-nums" {...p} />
            </div>
          ),
          th: (p) => (
            <th className="border border-border-strong bg-card px-2 py-1 text-left font-semibold" {...p} />
          ),
          td: (p) => <td className="border border-border-strong px-2 py-1 align-top" {...p} />,
        }}
      >
        {texto}
      </ReactMarkdown>
    </div>
  );
}

export default function AsistentePage() {
  const { t } = useI18n();
  const { toast, ToastHost } = useToasts();
  const { confirm, Modal } = useConfirm();
  const puede = useModuleAccess('assistant');

  const [chatList, setChatList] = useState<ChatListState>(INITIAL_CHAT_LIST);
  // La conversación abierta vino cortada por el tope de mensajes de la API.
  const [turnosRecortados, setTurnosRecortados] = useState(false);
  const [chatId, setChatId] = useState<string | null>(null);
  const [turnos, setTurnos] = useState<Turno[]>([]);
  const [entrada, setEntrada] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [herramientaActual, setHerramientaActual] = useState<string | null>(null);
  const [noConfigurado, setNoConfigurado] = useState(false);
  const finRef = useRef<HTMLDivElement | null>(null);
  const listaRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const etiquetaHerramienta = useCallback(
    (nombre: string) => {
      const clave = `assistant.tool.${nombre}`;
      const label = t(clave);
      // `t` devuelve la clave cuando no hay traducción: mostrar
      // "assistant.tool.x" en pantalla sería peor que mostrar el nombre crudo.
      return label === clave ? nombre : label;
    },
    [t],
  );

  const cargarChats = useCallback(async () => {
    // La lista lateral es accesoria: si falla, el chat sigue andando — pero
    // se DICE (antes el catch vacío dejaba «Todavía no hay conversaciones»).
    try {
      const res = await apiFetch('/api/assistant/chats');
      const json = await res.json().catch(() => null);
      setChatList((prev) => chatListFromResponse(prev, res.ok, json));
    } catch {
      setChatList((prev) => ({ ...prev, status: 'error' }));
    }
  }, []);

  useEffect(() => {
    if (puede) void cargarChats();
  }, [puede, cargarChats]);

  useEffect(() => {
    // Kevin (2026-08-28): la tarjeta crecía con la conversación y empujaba la
    // caja de escribir fuera de pantalla. Ahora la tarjeta tiene altura fija y
    // el scroll vive adentro; al llegar texto nuevo se baja el contenedor
    // interno (scrollIntoView movería la página entera, no este scroll).
    const el = listaRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [turnos, herramientaActual]);

  const abrirChat = useCallback(async (id: string) => {
    setChatId(id);
    setTurnos([]);
    setTurnosRecortados(false);
    try {
      const res = await apiFetch(`/api/assistant/chats?id=${encodeURIComponent(id)}`);
      const json = await res.json();
      if (!res.ok) throw new Error();
      setTurnosRecortados(messagesTruncated(json));
      setTurnos(
        (json.messages ?? []).map((m: { role: 'user' | 'assistant'; content: string; tool_calls: unknown }) => ({
          role: m.role,
          content: m.content,
          tools: Array.isArray(m.tool_calls)
            ? (m.tool_calls as Array<{ nombre?: string }>).map((c) => c.nombre ?? '').filter(Boolean)
            : undefined,
        })),
      );
    } catch {
      toast.error(t('assistant.error'));
    }
  }, [t, toast]);

  const nuevoChat = useCallback(() => {
    setChatId(null);
    setTurnos([]);
    setTurnosRecortados(false);
    setEntrada('');
  }, []);

  const borrarChat = useCallback(
    (c: ChatResumen) => {
      confirm(
        t('assistant.deleteConfirm', { title: c.title ?? '—' }),
        async () => {
          const res = await apiFetch(`/api/assistant/chats?id=${encodeURIComponent(c.id)}`, {
            method: 'DELETE',
          });
          if (!res.ok) {
            toast.error(t('assistant.error'));
            return;
          }
          if (chatId === c.id) nuevoChat();
          void cargarChats();
        },
        { confirmLabel: t('assistant.deleteChat'), tone: 'danger' },
      );
    },
    [confirm, t, toast, chatId, nuevoChat, cargarChats],
  );

  const enviar = useCallback(async () => {
    const texto = entrada.trim();
    if (!texto || enviando) return;

    setEntrada('');
    setEnviando(true);
    setNoConfigurado(false);
    setTurnos((prev) => [
      ...prev,
      { role: 'user', content: texto },
      { role: 'assistant', content: '', tools: [], enCurso: true },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await apiFetch('/api/assistant/chat', {
        method: 'POST',
        body: JSON.stringify({ chatId, message: texto }),
        signal: controller.signal,
        // El asistente puede tardar más que el timeout por defecto de
        // apiFetch (25 s): con dos vueltas de herramienta son 40 s reales.
        timeoutMs: 120_000,
      });

      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => null);
        if (json?.code === 'assistant_not_configured') {
          setNoConfigurado(true);
          setTurnos((prev) => prev.slice(0, -2));
          return;
        }
        throw new Error(json?.error ?? 'error');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const actualizarUltimo = (fn: (turno: Turno) => Turno) =>
        setTurnos((prev) => {
          const copia = [...prev];
          const i = copia.length - 1;
          if (i >= 0) copia[i] = fn(copia[i]);
          return copia;
        });

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Un evento puede llegar partido entre dos chunks: lo que queda
        // después del último separador se guarda para la vuelta siguiente.
        const partes = buffer.split('\n\n');
        buffer = partes.pop() ?? '';
        for (const parte of partes) {
          const linea = parte.trim();
          if (!linea.startsWith('data:')) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(linea.slice(5).trim());
          } catch {
            continue;
          }
          if (ev.tipo === 'inicio' && typeof ev.chatId === 'string') {
            setChatId(ev.chatId);
          } else if (ev.tipo === 'texto' && typeof ev.texto === 'string') {
            setHerramientaActual(null);
            const trozo = ev.texto;
            actualizarUltimo((turno) => ({ ...turno, content: turno.content + trozo }));
          } else if (ev.tipo === 'herramienta' && typeof ev.nombre === 'string') {
            const nombre = ev.nombre;
            setHerramientaActual(nombre);
            actualizarUltimo((turno) => ({
              ...turno,
              tools: [...(turno.tools ?? []), nombre],
            }));
          } else if (ev.tipo === 'limite') {
            toast.error(t('assistant.limit'));
          } else if (ev.tipo === 'error') {
            actualizarUltimo((turno) => ({
              ...turno,
              content: typeof ev.mensaje === 'string' ? ev.mensaje : t('assistant.error'),
            }));
          } else if (ev.tipo === 'fin') {
            actualizarUltimo((turno) => ({ ...turno, enCurso: false }));
            void cargarChats();
          }
        }
      }
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        toast.error(t('assistant.error'));
      }
      setTurnos((prev) => {
        const copia = [...prev];
        const i = copia.length - 1;
        if (i >= 0 && copia[i].enCurso && copia[i].content === '') copia.splice(i, 1);
        else if (i >= 0) copia[i] = { ...copia[i], enCurso: false };
        return copia;
      });
    } finally {
      setEnviando(false);
      setHerramientaActual(null);
      abortRef.current = null;
    }
  }, [entrada, enviando, chatId, cargarChats, t, toast]);

  if (!puede) return null; // el guard de layout ya pinta el 403

  const vistaLista = chatListView(chatList);
  const sugerencias = [t('assistant.suggest1'), t('assistant.suggest2'), t('assistant.suggest3')];

  return (
    <div className="space-y-4">
      {Modal}
      {ToastHost}
      <PageHeader
        title={t('assistant.title')}
        subtitle={t('assistant.subtitle')}
        icon={Sparkles}
        actions={
          <ActionButton onClick={nuevoChat}>
            <Plus aria-hidden className="size-[15px]" strokeWidth={1.75} />
            {t('assistant.newChat')}
          </ActionButton>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        {/* Historial propio */}
        <Panel
          title={t('assistant.history')}
          hint={chatList.chats.length > 0 ? <span className="tabular-nums">{chatList.chats.length}</span> : undefined}
          flush
          className="h-fit lg:sticky lg:top-4"
          footer={
            <span className="flex items-start gap-1.5">
              <Lock aria-hidden className="mt-0.5 size-3 shrink-0" strokeWidth={2} />
              {t('assistant.privacy')}
            </span>
          }
        >
          {chatList.status === 'error' && (
            <div className="border-b border-border p-2">
              <Notice
                kind="bad"
                title={t('lmAdm.assistant.historyErrorTitle')}
                action={
                  <button
                    type="button"
                    onClick={() => void cargarChats()}
                    className="text-[12.5px] font-medium text-foreground underline underline-offset-2"
                  >
                    {t('lmAdm.retry')}
                  </button>
                }
              >
                {vistaLista === 'list' ? t('lmAdm.assistant.historyErrorStale') : t('lmAdm.assistant.historyErrorEmpty')}
              </Notice>
            </div>
          )}
          {vistaLista === 'loading' && (
            <p className="px-4 py-3 text-[13px] text-text-3">{t('common.loading')}</p>
          )}
          {vistaLista === 'empty' && (
            <p className="px-4 py-3 text-[13px] text-text-3">{t('assistant.noChats')}</p>
          )}
          {vistaLista === 'list' && (
            <ul className="max-h-[50vh] space-y-0.5 overflow-y-auto p-2">
              {chatList.chats.map((c) => {
                const activo = c.id === chatId;
                return (
                  <li key={c.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void abrirChat(c.id)}
                      aria-current={activo ? 'true' : undefined}
                      className={cn(
                        'h-8 min-w-0 flex-1 truncate rounded-ui-md px-2.5 text-left text-[13px] [@media(pointer:coarse)]:h-10',
                        activo
                          ? 'bg-brand-tint font-semibold text-brand-ink shadow-[inset_3px_0_0_0_var(--brand-ink)]'
                          : 'font-medium text-text-2 hover:bg-surface-hover hover:text-foreground',
                      )}
                      title={c.title ?? ''}
                    >
                      {c.title ?? '—'}
                    </button>
                    <button
                      type="button"
                      className={ROW_ACTION_CLASS}
                      aria-label={t('assistant.deleteChat')}
                      title={t('assistant.deleteChat')}
                      onClick={() => borrarChat(c)}
                    >
                      <Trash2 aria-hidden className="size-4" strokeWidth={1.75} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {chatList.truncated && (
            <p className="border-t border-border px-4 py-2 text-[12.5px] text-text-3" role="note">
              {t('lmAdm.assistant.historyTruncated', { n: String(chatList.chats.length) })}
            </p>
          )}
        </Panel>

        {/* Conversación */}
        <Panel
          flush
          className="flex h-[calc(100dvh-13.5rem)] min-h-[26rem] flex-col overflow-hidden"
          bodyClassName="flex min-h-0 flex-1 flex-col"
          aria-label={t('lmAdm.assistant.conversation')}
        >
          <div ref={listaRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {noConfigurado && <Notice kind="pend" title={t('assistant.notConfigured')} />}

            {turnosRecortados && (
              <Notice kind="info" title={t('lmAdm.assistant.messagesTruncatedTitle')}>
                {t('lmAdm.assistant.messagesTruncatedBody', { n: String(turnos.length) })}
              </Notice>
            )}

            {turnos.length === 0 && !noConfigurado && (
              <div className="flex flex-col items-center px-2 py-10 text-center">
                <span
                  aria-hidden
                  className="flex size-10 items-center justify-center rounded-full border border-border bg-surface-2 text-text-3"
                >
                  <Sparkles className="size-[18px]" strokeWidth={1.75} />
                </span>
                <p className="mt-3 text-[15px] font-semibold text-foreground">{t('assistant.emptyTitle')}</p>
                <p className="mt-1 text-[12.5px] text-text-3">{t('lmAdm.assistant.suggestHint')}</p>
                <ul className="mt-4 flex w-full max-w-md flex-col gap-2">
                  {sugerencias.map((s) => (
                    <li key={s}>
                      <button
                        type="button"
                        onClick={() => setEntrada(s)}
                        className="w-full rounded-ui-md border border-border-strong bg-card px-3 py-2 text-left text-[13px] text-text-2 hover:bg-surface-hover hover:text-foreground"
                      >
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {turnos.map((turno, i) => (
              <div
                key={i}
                className={cn('flex', turno.role === 'user' ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    'min-w-0 max-w-[85%] break-words rounded-ui-lg px-3 py-2 text-sm',
                    turno.role === 'user'
                      ? 'whitespace-pre-wrap bg-primary text-brand-on-primary'
                      : 'border border-border bg-surface-2 text-foreground',
                  )}
                >
                  {turno.tools && turno.tools.length > 0 && (
                    <p className="mb-1.5 flex items-center gap-1.5 text-[12px] text-text-3">
                      <Wrench className="size-3 shrink-0" aria-hidden />
                      {t('assistant.consulted', {
                        tools: [...new Set(turno.tools)].map(etiquetaHerramienta).join(', '),
                      })}
                    </p>
                  )}
                  {turno.role === 'user' ? turno.content : <MarkdownRespuesta texto={turno.content} />}
                  {turno.enCurso && (
                    <span className="ml-1 inline-block h-4 w-1.5 animate-pulse bg-current align-middle motion-reduce:animate-none" />
                  )}
                  {turno.enCurso && turno.content === '' && (
                    <span className="text-text-3">
                      {herramientaActual
                        ? t('assistant.consulting', { tool: etiquetaHerramienta(herramientaActual) })
                        : t('assistant.thinking')}
                    </span>
                  )}
                </div>
              </div>
            ))}
            <div ref={finRef} />
          </div>

          {/* Caja de escritura */}
          <div className="border-t border-border p-3">
            <div className="flex items-end gap-2">
              <Textarea
                value={entrada}
                onChange={(e) => setEntrada(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void enviar();
                  }
                }}
                rows={2}
                maxLength={4000}
                aria-label={t('assistant.placeholder')}
                placeholder={t('assistant.placeholder')}
                // 16px mínimo en móvil: por debajo, iOS hace zoom forzado al enfocar.
                className="min-w-0 flex-1 resize-none max-sm:text-[16px]"
              />
              <ActionButton
                variant="primary"
                onClick={() => void enviar()}
                loading={enviando}
                disabled={entrada.trim() === ''}
                aria-label={t('assistant.send')}
                title={t('assistant.send')}
              >
                {!enviando && <Send aria-hidden className="size-[15px]" strokeWidth={1.75} />}
              </ActionButton>
            </div>
            {/* Pie FIJO — la advertencia que hay que buscar no es advertencia. */}
            <p className="pt-2 text-center text-[12px] text-text-3">
              {t('assistant.disclaimer')}
            </p>
          </div>
        </Panel>
      </div>
    </div>
  );
}

