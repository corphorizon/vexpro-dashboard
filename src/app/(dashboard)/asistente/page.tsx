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
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles, Send, Plus, Trash2, Lock, Wrench, AlertTriangle } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { useToasts } from '@/components/ui/toast';
import { useConfirm } from '@/lib/use-confirm';
import { useI18n } from '@/lib/i18n';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { cn } from '@/lib/utils';

interface ChatResumen {
  id: string;
  title: string | null;
  updated_at: string;
}

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
            <code className="rounded bg-background/60 px-1 py-0.5 text-[0.85em]" {...p} />
          ),
          table: (p) => (
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-xs border-collapse" {...p} />
            </div>
          ),
          th: (p) => (
            <th className="border border-border/60 bg-background/40 px-2 py-1 text-left font-semibold" {...p} />
          ),
          td: (p) => <td className="border border-border/60 px-2 py-1 align-top" {...p} />,
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

  const [chats, setChats] = useState<ChatResumen[]>([]);
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
    try {
      const res = await apiFetch('/api/assistant/chats');
      if (!res.ok) return;
      const json = await res.json();
      setChats(json.chats ?? []);
    } catch {
      /* la lista lateral es accesoria: si falla, el chat sigue andando */
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
    try {
      const res = await apiFetch(`/api/assistant/chats?id=${encodeURIComponent(id)}`);
      const json = await res.json();
      if (!res.ok) throw new Error();
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

  return (
    <div className="space-y-4">
      {Modal}
      {ToastHost}
      <PageHeader
        title={t('assistant.title')}
        subtitle={t('assistant.subtitle')}
        icon={Sparkles}
        actions={
          <Button variant="secondary" onClick={nuevoChat}>
            <Plus className="w-4 h-4" />
            {t('assistant.newChat')}
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        {/* Historial propio */}
        <Card className="p-3 h-fit lg:sticky lg:top-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-1 pb-2">
            {t('assistant.history')}
          </p>
          {chats.length === 0 ? (
            <p className="text-sm text-muted-foreground px-1 py-2">{t('assistant.noChats')}</p>
          ) : (
            <ul className="space-y-1 max-h-[50vh] overflow-y-auto">
              {chats.map((c) => (
                <li key={c.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void abrirChat(c.id)}
                    className={cn(
                      'flex-1 text-left text-sm rounded-md px-2 py-1.5 truncate transition-colors',
                      c.id === chatId
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'hover:bg-muted text-foreground',
                    )}
                    title={c.title ?? ''}
                  >
                    {c.title ?? '—'}
                  </button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t('assistant.deleteChat')}
                    onClick={() => borrarChat(c)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground px-1 pt-3 border-t border-border mt-2">
            <Lock className="w-3 h-3 mt-0.5 shrink-0" aria-hidden />
            {t('assistant.privacy')}
          </p>
        </Card>

        {/* Conversación */}
        <Card className="flex flex-col p-0 overflow-hidden h-[calc(100dvh-13.5rem)] min-h-[26rem]">
          <div ref={listaRef} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
            {noConfigurado && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" aria-hidden />
                <span>{t('assistant.notConfigured')}</span>
              </div>
            )}

            {turnos.length === 0 && !noConfigurado && (
              <EmptyState
                icon={Sparkles}
                title={t('assistant.emptyTitle')}
                description={
                  [t('assistant.suggest1'), t('assistant.suggest2'), t('assistant.suggest3')].join(' · ')
                }
              />
            )}

            {turnos.map((turno, i) => (
              <div
                key={i}
                className={cn('flex', turno.role === 'user' ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    'max-w-[85%] rounded-xl px-3 py-2 text-sm break-words',
                    turno.role === 'user'
                      ? 'bg-primary text-brand-on-primary whitespace-pre-wrap'
                      : 'bg-muted text-foreground',
                  )}
                >
                  {turno.tools && turno.tools.length > 0 && (
                    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1.5">
                      <Wrench className="w-3 h-3 shrink-0" aria-hidden />
                      {t('assistant.consulted', {
                        tools: [...new Set(turno.tools)].map(etiquetaHerramienta).join(', '),
                      })}
                    </p>
                  )}
                  {turno.role === 'user' ? turno.content : <MarkdownRespuesta texto={turno.content} />}
                  {turno.enCurso && (
                    <span className="ml-1 inline-block w-1.5 h-4 align-middle bg-current animate-pulse" />
                  )}
                  {turno.enCurso && turno.content === '' && (
                    <span className="text-muted-foreground">
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
            <div className="flex gap-2">
              <textarea
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
                placeholder={t('assistant.placeholder')}
                // 16px mínimo: por debajo, iOS hace zoom forzado al enfocar.
                className="flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-base sm:text-sm outline-none focus:border-primary"
              />
              <Button
                variant="primary"
                onClick={() => void enviar()}
                loading={enviando}
                disabled={entrada.trim() === ''}
                aria-label={t('assistant.send')}
              >
                <Send className="w-4 h-4" />
              </Button>
            </div>
            {/* Pie FIJO — la advertencia que hay que buscar no es advertencia. */}
            <p className="pt-2 text-[11px] text-muted-foreground text-center">
              {t('assistant.disclaimer')}
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
