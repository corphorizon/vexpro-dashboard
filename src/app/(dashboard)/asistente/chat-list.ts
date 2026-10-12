// ─────────────────────────────────────────────────────────────────────────────
// chat-list — estado del historial de /asistente («Libro mayor», 2026-10-12).
//
// POR QUÉ: dos fallos que no daban error.
//   1. `cargarChats` tragaba cualquier falla (`if (!res.ok) return` y un catch
//      vacío) y la lista lateral decía «Todavía no hay conversaciones» —
//      también MIENTRAS cargaba. Quien tenía 30 chats leía que no tenía
//      ninguno. Ahora hay tres estados: cargando, falló (con Reintentar) y
//      cargado; «no hay conversaciones» sólo con una respuesta buena y vacía.
//   2. La API corta en 50 conversaciones y 200 mensajes y devuelve
//      `truncated: true` («con aviso de recorte, como manda la casa», dice su
//      cabecera), pero la pantalla nunca lo leía: el aviso no llegaba a la UI.
//      Ahora se cuenta: «Se muestran las 50 más recientes».
// Un refresco fallido (después de mandar un mensaje) NO borra la lista que ya
// estaba: se conserva y se marca el error — vaciarla sería afirmar algo falso.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatResumen {
  id: string;
  title: string | null;
  updated_at: string;
}

export interface ChatListState {
  status: 'loading' | 'ok' | 'error';
  chats: ChatResumen[];
  /** La API cortó la lista (hay más conversaciones que las mostradas). */
  truncated: boolean;
}

export const INITIAL_CHAT_LIST: ChatListState = { status: 'loading', chats: [], truncated: false };

/** Respuesta del GET /api/assistant/chats → nuevo estado. `prev` se conserva si falla. */
export function chatListFromResponse(prev: ChatListState, ok: boolean, json: unknown): ChatListState {
  if (!ok || json == null || typeof json !== 'object') return { ...prev, status: 'error' };
  const j = json as Record<string, unknown>;
  if (j.success === false || !Array.isArray(j.chats)) return { ...prev, status: 'error' };
  return { status: 'ok', chats: j.chats as ChatResumen[], truncated: j.truncated === true };
}

/** Qué dibuja la lista lateral. */
export type ChatListView = 'loading' | 'error-empty' | 'empty' | 'list';

export function chatListView(s: ChatListState): ChatListView {
  if (s.chats.length > 0) return 'list';
  if (s.status === 'loading') return 'loading';
  if (s.status === 'error') return 'error-empty';
  return 'empty';
}

/** ¿La conversación abierta vino recortada por el tope de mensajes de la API? */
export function messagesTruncated(json: unknown): boolean {
  return json != null && typeof json === 'object' && (json as Record<string, unknown>).truncated === true;
}
