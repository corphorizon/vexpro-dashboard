'use client';

import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { logAction } from '@/lib/audit-log';

export type UserRole = 'admin' | 'socio' | 'auditor' | 'soporte' | 'hr' | 'invitado';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  company_id: string;
  allowed_modules: string[];
  twofa_enabled: boolean;
  twofa_secret: string | null;
}

export type LoginResult =
  | { success: true; needs2fa: false }
  | { success: true; needs2fa: true; userId: string }
  | { success: false; needs2fa: false };

interface AuthState {
  user: User | null;
  users: User[];
  isLoading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  loginWith2fa: (userId: string, pin: string) => boolean;
  logout: () => void;
  createUser: (user: Omit<User, 'id'>, password: string) => void;
  updateUser: (id: string, updates: Partial<User>) => void;
  deleteUser: (id: string) => void;
  changePassword: (userId: string, currentPassword: string, newPassword: string) => Promise<boolean>;
  updateUserDirect: (id: string, updates: Partial<User & { password?: string }>) => void;
}

const ALL_MODULES = ['summary', 'movements', 'expenses', 'liquidity', 'investments', 'partners', 'hr', 'upload', 'periods', 'users', 'audit'];

const STORAGE_KEY = 'fd_users';
const SESSION_KEY = 'fd_session';
const HASHED_FLAG_KEY = 'fd_users_hashed_v1';

// SHA-256 hash using Web Crypto API (browser-only demo)
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Default users with plaintext passwords (only used to seed hashed versions on first load)
const DEFAULT_USERS_RAW: Array<User & { password: string }> = [
  { id: 'u1', email: 'kevin@vexprofx.com', name: 'Kevin', role: 'admin', company_id: 'vexpro-001', allowed_modules: ALL_MODULES, password: 'admin123', twofa_enabled: false, twofa_secret: null },
  { id: 'u2', email: 'sergio@vexprofx.com', name: 'Sergio', role: 'socio', company_id: 'vexpro-001', allowed_modules: ['summary', 'movements', 'expenses', 'liquidity', 'investments', 'partners'], password: 'socio123', twofa_enabled: false, twofa_secret: null },
  { id: 'u3', email: 'hugo@vexprofx.com', name: 'Hugo', role: 'socio', company_id: 'vexpro-001', allowed_modules: ['summary', 'movements', 'expenses', 'liquidity', 'investments', 'partners'], password: 'socio123', twofa_enabled: false, twofa_secret: null },
  { id: 'u4', email: 'stiven@vexprofx.com', name: 'Stiven', role: 'socio', company_id: 'vexpro-001', allowed_modules: ['summary', 'movements', 'expenses', 'liquidity', 'investments', 'partners'], password: 'socio123', twofa_enabled: false, twofa_secret: null },
  { id: 'u5', email: 'daniela@vexprofx.com', name: 'Daniela', role: 'auditor', company_id: 'vexpro-001', allowed_modules: ['summary', 'movements', 'expenses', 'liquidity', 'investments', 'partners', 'upload'], password: 'contador123', twofa_enabled: false, twofa_secret: null },
];

// Hash all default user passwords and store them; only runs once on first visit
async function initHashedDefaults(): Promise<Array<User & { password: string }>> {
  const hashed = await Promise.all(
    DEFAULT_USERS_RAW.map(async (u) => ({
      ...u,
      password: await hashPassword(u.password),
    }))
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(hashed));
  localStorage.setItem(HASHED_FLAG_KEY, '1');
  return hashed;
}

function isValidUserArray(data: unknown): data is Array<User & { password: string }> {
  if (!Array.isArray(data)) return false;
  return data.every(
    (item) =>
      item &&
      typeof item === 'object' &&
      typeof item.id === 'string' &&
      typeof item.email === 'string' &&
      typeof item.name === 'string' &&
      typeof item.role === 'string'
  );
}

// Ensure 2FA fields exist on users loaded from storage (migration for existing data)
function migrateUser(u: User & { password: string }): User & { password: string } {
  return {
    ...u,
    twofa_enabled: typeof u.twofa_enabled === 'boolean' ? u.twofa_enabled : false,
    twofa_secret: typeof u.twofa_secret === 'string' ? u.twofa_secret : null,
  } as User & { password: string };
}

function getStoredUsers(): Array<User & { password: string }> {
  if (typeof window === 'undefined') return DEFAULT_USERS_RAW;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return DEFAULT_USERS_RAW;
  }
  try {
    const parsed = JSON.parse(stored);
    if (!isValidUserArray(parsed)) {
      console.warn('Invalid user data in localStorage, resetting to defaults');
      return DEFAULT_USERS_RAW;
    }
    return parsed.map(migrateUser);
  } catch {
    console.warn('Corrupted user data in localStorage, resetting to defaults');
    return DEFAULT_USERS_RAW;
  }
}

// Async version that ensures passwords are hashed before returning
async function getStoredUsersAsync(): Promise<Array<User & { password: string }>> {
  if (typeof window === 'undefined') return DEFAULT_USERS_RAW;
  const isHashed = localStorage.getItem(HASHED_FLAG_KEY);
  if (!isHashed) {
    return initHashedDefaults();
  }
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return initHashedDefaults();
  }
  try {
    const parsed = JSON.parse(stored);
    if (!isValidUserArray(parsed)) {
      console.warn('Invalid user data in localStorage, resetting to defaults');
      return initHashedDefaults();
    }
    return parsed.map(migrateUser);
  } catch {
    console.warn('Corrupted user data in localStorage, resetting to defaults');
    return initHashedDefaults();
  }
}

function saveUsers(users: Array<User & { password: string }>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(users));
}

function stripPassword(u: User & { password: string }): User {
  const { password: _, ...userData } = u;
  return userData;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Ref to access current user in callbacks without stale closures
  const userRef = useRef<User | null>(null);
  useEffect(() => { userRef.current = user; }, [user]);

  useEffect(() => {
    async function init() {
      const allUsers = await getStoredUsersAsync();
      setUsers(allUsers.map(stripPassword));
      const sessionId = localStorage.getItem(SESSION_KEY);
      if (sessionId) {
        const found = allUsers.find(u => u.id === sessionId);
        if (found) {
          setUser(stripPassword(found));
        }
      }
      setIsLoading(false);
    }
    init();
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<LoginResult> => {
    const allUsers = await getStoredUsersAsync();
    const hashedInput = await hashPassword(password);
    const found = allUsers.find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === hashedInput);
    if (!found) {
      return { success: false, needs2fa: false };
    }
    if (found.twofa_enabled && found.twofa_secret) {
      // Don't set session yet - need 2FA verification first
      return { success: true, needs2fa: true, userId: found.id };
    }
    setUser(stripPassword(found));
    localStorage.setItem(SESSION_KEY, found.id);
    logAction(found.id, found.name, 'login', 'auth', `Inicio de sesión: ${found.email}`);
    return { success: true, needs2fa: false };
  }, []);

  const loginWith2fa = useCallback((userId: string, pin: string): boolean => {
    if (typeof window === 'undefined') return false;
    const allUsers = getStoredUsers();
    const found = allUsers.find(u => u.id === userId);
    if (!found) return false;
    if (found.twofa_secret === pin) {
      setUser(stripPassword(found));
      localStorage.setItem(SESSION_KEY, found.id);
      logAction(found.id, found.name, 'login', 'auth', `Inicio de sesión con 2FA: ${found.email}`);
      return true;
    }
    return false;
  }, []);

  const logout = useCallback(() => {
    setUser((prev) => {
      if (prev) {
        logAction(prev.id, prev.name, 'logout', 'auth', `Cierre de sesión: ${prev.email}`);
      }
      return null;
    });
    localStorage.removeItem(SESSION_KEY);
  }, []);

  const createUser = useCallback(async (newUser: Omit<User, 'id'>, password: string) => {
    const allUsers = await getStoredUsersAsync();
    const id = `u${Date.now()}`;
    const hashedPw = await hashPassword(password);
    const userWithPw = {
      ...newUser,
      id,
      password: hashedPw,
      twofa_enabled: newUser.twofa_enabled ?? false,
      twofa_secret: newUser.twofa_secret ?? null,
    };
    allUsers.push(userWithPw);
    saveUsers(allUsers);
    setUsers(allUsers.map(stripPassword));
    // Audit log: use current user from state ref (avoids localStorage race condition)
    const current = userRef.current;
    if (current) {
      logAction(current.id, current.name, 'create', 'users', `Usuario creado: ${newUser.name} (${newUser.email}), rol: ${newUser.role}`);
    }
  }, []);

  const updateUser = useCallback((id: string, updates: Partial<User>) => {
    const allUsers = getStoredUsers();
    const idx = allUsers.findIndex(u => u.id === id);
    if (idx >= 0) {
      const targetName = allUsers[idx].name;
      allUsers[idx] = { ...allUsers[idx], ...updates };
      saveUsers(allUsers);
      setUsers(allUsers.map(stripPassword));
      // If updating the current user, refresh their state
      const current = userRef.current;
      if (current && current.id === id) {
        setUser(stripPassword(allUsers[idx]));
      }
      // Audit log: use state ref instead of localStorage (avoids race condition)
      if (current) {
        const fields = Object.keys(updates).join(', ');
        logAction(current.id, current.name, 'update', 'users', `Usuario actualizado: ${targetName} - campos: ${fields}`);
      }
    }
  }, []);

  const updateUserDirect = useCallback((id: string, updates: Partial<User & { password?: string }>) => {
    const allUsers = getStoredUsers();
    const idx = allUsers.findIndex(u => u.id === id);
    if (idx >= 0) {
      allUsers[idx] = { ...allUsers[idx], ...updates };
      saveUsers(allUsers);
      setUsers(allUsers.map(stripPassword));
      const current = userRef.current;
      if (current && current.id === id) {
        setUser(stripPassword(allUsers[idx]));
      }
    }
  }, []);

  const deleteUser = useCallback((id: string) => {
    const allUsersOrig = getStoredUsers();
    const deletedUser = allUsersOrig.find(u => u.id === id);
    const allUsers = allUsersOrig.filter(u => u.id !== id);
    saveUsers(allUsers);
    setUsers(allUsers.map(stripPassword));
    // Audit log: use state ref instead of localStorage (avoids race condition)
    const current = userRef.current;
    if (current && deletedUser) {
      logAction(current.id, current.name, 'delete', 'users', `Usuario eliminado: ${deletedUser.name} (${deletedUser.email})`);
    }
  }, []);

  const changePassword = useCallback(async (userId: string, currentPassword: string, newPassword: string): Promise<boolean> => {
    const allUsers = await getStoredUsersAsync();
    const idx = allUsers.findIndex(u => u.id === userId);
    if (idx < 0) return false;
    const hashedCurrent = await hashPassword(currentPassword);
    if (allUsers[idx].password !== hashedCurrent) {
      return false;
    }
    const hashedNew = await hashPassword(newPassword);
    allUsers[idx].password = hashedNew;
    saveUsers(allUsers);
    return true;
  }, []);

  return (
    <AuthContext.Provider value={{ user, users, isLoading, login, loginWith2fa, logout, createUser, updateUser, deleteUser, changePassword, updateUserDirect }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function hasModuleAccess(user: User | null, module: string): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return user.allowed_modules.includes(module);
}

// Permission helpers — based on allowed_modules, customizable per user
export function canAdd(user: User | null): boolean {
  if (!user) return false;
  return user.role === 'admin' || user.role === 'auditor';
}

export function canEdit(user: User | null): boolean {
  if (!user) return false;
  return user.role === 'admin';
}

export function canDelete(user: User | null): boolean {
  if (!user) return false;
  return user.role === 'admin';
}

export const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin',
  socio: 'Socio',
  auditor: 'Auditor',
  soporte: 'Soporte',
  hr: 'HR',
  invitado: 'Invitado',
};

export const ROLE_DESCRIPTIONS: Record<string, string> = {
  admin: 'Acceso total: ver, agregar, editar, eliminar, gestionar usuarios',
  socio: 'Visualizar información financiera y descargar reportes',
  auditor: 'Visualizar y agregar datos para auditoría',
  soporte: 'Soporte operativo con acceso a módulos asignados',
  hr: 'Gestión de recursos humanos y fuerza comercial',
  invitado: 'Acceso limitado de solo lectura',
};

// Default modules for each role (used when creating new users)
export const ROLE_DEFAULT_MODULES: Record<string, string[]> = {
  admin: ALL_MODULES,
  socio: ['summary', 'movements', 'expenses', 'liquidity', 'investments', 'partners'],
  auditor: ['summary', 'movements', 'expenses', 'liquidity', 'investments', 'partners', 'upload'],
  soporte: ['summary', 'movements', 'expenses', 'liquidity'],
  hr: ['summary', 'hr'],
  invitado: ['summary'],
};

export const MODULE_LABELS: Record<string, string> = {
  summary: 'Resumen',
  movements: 'Movimientos',
  expenses: 'Egresos',
  liquidity: 'Liquidez',
  investments: 'Inversiones',
  partners: 'Socios',
  hr: 'Recursos Humanos',
  upload: 'Carga de Datos',
  periods: 'Períodos',
  users: 'Usuarios',
  audit: 'Auditoría',
};
