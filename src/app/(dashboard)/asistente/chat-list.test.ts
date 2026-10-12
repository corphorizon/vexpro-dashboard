// chat-list: «no hay conversaciones» sólo con una respuesta buena y vacía;
// una falla conserva lo que había; el recorte de la API llega a la UI.
import { describe, it, expect } from 'vitest';
import {
  INITIAL_CHAT_LIST,
  chatListFromResponse,
  chatListView,
  messagesTruncated,
  type ChatListState,
} from './chat-list';

const chat = { id: 'c1', title: 'Depósitos', updated_at: '2026-10-12T10:00:00Z' };

describe('chatListFromResponse', () => {
  it('respuesta buena', () => {
    const s = chatListFromResponse(INITIAL_CHAT_LIST, true, { success: true, chats: [chat], truncated: false });
    expect(s).toEqual({ status: 'ok', chats: [chat], truncated: false });
  });
  it('lleva el truncated de la API', () => {
    const s = chatListFromResponse(INITIAL_CHAT_LIST, true, { success: true, chats: [chat], truncated: true });
    expect(s.truncated).toBe(true);
  });
  it('truncated ausente o no booleano → false', () => {
    expect(chatListFromResponse(INITIAL_CHAT_LIST, true, { chats: [] }).truncated).toBe(false);
    expect(chatListFromResponse(INITIAL_CHAT_LIST, true, { chats: [], truncated: 'yes' }).truncated).toBe(false);
  });
  it('HTTP no ok → error, no lista vacía', () => {
    const s = chatListFromResponse(INITIAL_CHAT_LIST, false, { success: true, chats: [] });
    expect(s.status).toBe('error');
  });
  it('success:false, sin chats o cuerpo basura → error', () => {
    expect(chatListFromResponse(INITIAL_CHAT_LIST, true, { success: false }).status).toBe('error');
    expect(chatListFromResponse(INITIAL_CHAT_LIST, true, { success: true }).status).toBe('error');
    expect(chatListFromResponse(INITIAL_CHAT_LIST, true, null).status).toBe('error');
    expect(chatListFromResponse(INITIAL_CHAT_LIST, true, 'x').status).toBe('error');
  });
  it('un refresco fallido conserva la lista que ya estaba', () => {
    const prev: ChatListState = { status: 'ok', chats: [chat], truncated: true };
    const s = chatListFromResponse(prev, false, null);
    expect(s).toEqual({ status: 'error', chats: [chat], truncated: true });
  });
});

describe('chatListView', () => {
  it('cargando no dice «no hay conversaciones»', () => {
    expect(chatListView(INITIAL_CHAT_LIST)).toBe('loading');
  });
  it('falla sin nada previo', () => {
    expect(chatListView({ status: 'error', chats: [], truncated: false })).toBe('error-empty');
  });
  it('vacío sólo con respuesta buena', () => {
    expect(chatListView({ status: 'ok', chats: [], truncated: false })).toBe('empty');
  });
  it('con chats siempre muestra la lista (aunque el refresco falle)', () => {
    expect(chatListView({ status: 'error', chats: [chat], truncated: false })).toBe('list');
    expect(chatListView({ status: 'loading', chats: [chat], truncated: false })).toBe('list');
    expect(chatListView({ status: 'ok', chats: [chat], truncated: false })).toBe('list');
  });
});

describe('messagesTruncated', () => {
  it('sólo true explícito', () => {
    expect(messagesTruncated({ truncated: true })).toBe(true);
    expect(messagesTruncated({ truncated: false })).toBe(false);
    expect(messagesTruncated({})).toBe(false);
    expect(messagesTruncated(null)).toBe(false);
    expect(messagesTruncated({ truncated: 'true' })).toBe(false);
  });
});
