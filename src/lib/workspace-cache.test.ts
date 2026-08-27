// El snapshot del workspace sobrevive al auto-logout por inactividad, así que
// puede quedar en localStorage cuando el usuario siguiente entra en la MISMA
// máquina. Este test fija la trampa conocida del repo:
//
//   «caché de cliente con clave global = el siguiente usuario ve los datos
//    del anterior»
//
// Dos candados y los dos se prueban acá: la CLAVE lleva usuario+empresa, y el
// SOBRE guarda su dueño y se verifica al hidratar.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveWorkspaceSnapshot,
  loadWorkspaceSnapshot,
  clearWorkspaceCache,
  CACHE_VERSION,
} from './workspace-cache';

// localStorage falso: vitest corre en entorno node.
class FakeStorage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
  raw() { return this.map; }
}

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  (globalThis as unknown as { window: unknown }).window = { localStorage: storage };
});

const USUARIO_A = { userId: 'auth-user-A', companyId: 'empresa-1' };
const USUARIO_B = { userId: 'auth-user-B', companyId: 'empresa-1' };
const datosDeA = { periods: [{ id: 'p1' }] } as never;

describe('propiedad del snapshot', () => {
  it('el usuario A recupera lo suyo', () => {
    saveWorkspaceSnapshot(USUARIO_A, datosDeA);
    expect(loadWorkspaceSnapshot(USUARIO_A)).toEqual(datosDeA);
  });

  it('el usuario B NO hidrata el snapshot del usuario A en la misma máquina', () => {
    saveWorkspaceSnapshot(USUARIO_A, datosDeA);
    expect(loadWorkspaceSnapshot(USUARIO_B)).toBeNull();
  });

  it('el mismo usuario en OTRA empresa tampoco lo hidrata', () => {
    saveWorkspaceSnapshot(USUARIO_A, datosDeA);
    expect(loadWorkspaceSnapshot({ userId: 'auth-user-A', companyId: 'empresa-2' })).toBeNull();
  });

  it('la clave incluye usuario y empresa', () => {
    saveWorkspaceSnapshot(USUARIO_A, datosDeA);
    const clave = [...storage.raw().keys()][0];
    expect(clave).toBe(`fd_ws_cache_v${CACHE_VERSION}_auth-user-A_empresa-1`);
  });

  it('segundo candado: un sobre con OTRO dueño bajo la clave de B no hidrata', () => {
    // Simula un sobre plantado a mano (o un snapshot de una versión anterior
    // del código que no guardaba dueño): la clave sola no alcanza.
    storage.setItem(
      `fd_ws_cache_v${CACHE_VERSION}_auth-user-B_empresa-1`,
      JSON.stringify({ savedAt: Date.now(), userId: 'auth-user-A', companyId: 'empresa-1', data: datosDeA }),
    );
    expect(loadWorkspaceSnapshot(USUARIO_B)).toBeNull();
    // Y además lo borra, para no re-evaluarlo en cada arranque.
    expect(storage.getItem(`fd_ws_cache_v${CACHE_VERSION}_auth-user-B_empresa-1`)).toBeNull();
  });

  it('un sobre SIN dueño (formato viejo) no hidrata', () => {
    storage.setItem(
      `fd_ws_cache_v${CACHE_VERSION}_auth-user-A_empresa-1`,
      JSON.stringify({ savedAt: Date.now(), data: datosDeA }),
    );
    expect(loadWorkspaceSnapshot(USUARIO_A)).toBeNull();
  });

  it('sin userId no se guarda ni se lee nada', () => {
    saveWorkspaceSnapshot({ userId: '', companyId: 'empresa-1' }, datosDeA);
    expect(storage.length).toBe(0);
    expect(loadWorkspaceSnapshot({ userId: '', companyId: 'empresa-1' })).toBeNull();
  });
});

describe('clearWorkspaceCache (logout explícito)', () => {
  it('borra los snapshots de TODOS los usuarios de la máquina', () => {
    saveWorkspaceSnapshot(USUARIO_A, datosDeA);
    saveWorkspaceSnapshot(USUARIO_B, datosDeA);
    storage.setItem('fd_theme', 'dark'); // preferencia de UX: no es sensible
    clearWorkspaceCache();
    expect(loadWorkspaceSnapshot(USUARIO_A)).toBeNull();
    expect(loadWorkspaceSnapshot(USUARIO_B)).toBeNull();
    expect(storage.getItem('fd_theme')).toBe('dark');
  });
});

describe('vencimiento', () => {
  it('descarta un snapshot de más de 24h', () => {
    storage.setItem(
      `fd_ws_cache_v${CACHE_VERSION}_auth-user-A_empresa-1`,
      JSON.stringify({
        savedAt: Date.now() - 25 * 60 * 60 * 1000,
        userId: 'auth-user-A',
        companyId: 'empresa-1',
        data: datosDeA,
      }),
    );
    expect(loadWorkspaceSnapshot(USUARIO_A)).toBeNull();
  });
});
