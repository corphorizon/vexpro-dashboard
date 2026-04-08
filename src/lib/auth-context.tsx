'use client';

import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createClient } from '@/lib/supabase/client';
import { logAction } from '@/lib/audit-log';
import type { User as SupabaseUser } from '@supabase/supabase-js';

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
  resetPassword: (userEmail: string, newPassword: string) => Promise<boolean>;
  updateUserDirect: (id: string, updates: Partial<User & { password?: string }>) => void;
}

const ALL_MODULES = ['summary', 'movements', 'expenses', 'liquidity', 'investments', 'balances', 'partners', 'hr', 'upload', 'periods', 'users', 'audit'];

const AuthContext = createContext<AuthState | null>(null);

const supabase = createClient();

// Fetch the company_user profile for a given auth user
async function fetchUserProfile(authUser: SupabaseUser): Promise<User | null> {
  const { data, error } = await supabase
    .from('company_users')
    .select('*')
    .eq('user_id', authUser.id)
    .single();

  if (error || !data) {
    console.error('Error fetching user profile:', error?.message);
    return null;
  }

  return {
    id: data.id,
    email: data.email,
    name: data.name,
    role: data.role as UserRole,
    company_id: data.company_id,
    allowed_modules: data.allowed_modules || [],
    twofa_enabled: data.twofa_enabled || false,
    twofa_secret: data.twofa_secret || null,
  };
}

// Fetch all company_users for the same company
async function fetchAllUsers(companyId: string): Promise<User[]> {
  const { data, error } = await supabase
    .from('company_users')
    .select('*')
    .eq('company_id', companyId);

  if (error || !data) {
    console.error('Error fetching users:', error?.message);
    return [];
  }

  return data.map((u: any) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role as UserRole,
    company_id: u.company_id,
    allowed_modules: u.allowed_modules || [],
    twofa_enabled: u.twofa_enabled || false,
    twofa_secret: u.twofa_secret || null,
  }));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const userRef = useRef<User | null>(null);
  useEffect(() => { userRef.current = user; }, [user]);

  // Initialize: check for existing Supabase session
  useEffect(() => {
    async function init() {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          const profile = await fetchUserProfile(session.user);
          if (profile) {
            setUser(profile);
            const allUsers = await fetchAllUsers(profile.company_id);
            setUsers(allUsers);
          }
        }
      } catch (err) {
        console.error('Error initializing auth:', err);
      } finally {
        setIsLoading(false);
      }
    }
    init();

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT') {
        setUser(null);
        setUsers([]);
      }
      if (event === 'SIGNED_IN' && session?.user) {
        const profile = await fetchUserProfile(session.user);
        if (profile) {
          setUser(profile);
          const allUsers = await fetchAllUsers(profile.company_id);
          setUsers(allUsers);
        }
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<LoginResult> => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.user) {
      return { success: false, needs2fa: false };
    }

    const profile = await fetchUserProfile(data.user);
    if (!profile) {
      return { success: false, needs2fa: false };
    }

    // Check 2FA
    if (profile.twofa_enabled && profile.twofa_secret) {
      // Sign out temporarily — need 2FA verification first
      await supabase.auth.signOut();
      return { success: true, needs2fa: true, userId: profile.id };
    }

    setUser(profile);
    const allUsers = await fetchAllUsers(profile.company_id);
    setUsers(allUsers);
    logAction(profile.id, profile.name, 'login', 'auth', `Inicio de sesión: ${profile.email}`);
    return { success: true, needs2fa: false };
  }, []);

  const loginWith2fa = useCallback((userId: string, pin: string): boolean => {
    // For now, 2FA verification against stored secret
    const targetUser = users.find(u => u.id === userId);
    if (!targetUser) return false;
    if (targetUser.twofa_secret === pin) {
      setUser(targetUser);
      logAction(targetUser.id, targetUser.name, 'login', 'auth', `Inicio de sesión con 2FA: ${targetUser.email}`);
      return true;
    }
    return false;
  }, [users]);

  const logout = useCallback(async () => {
    const prev = userRef.current;
    if (prev) {
      logAction(prev.id, prev.name, 'logout', 'auth', `Cierre de sesión: ${prev.email}`);
    }
    await supabase.auth.signOut();
    setUser(null);
  }, []);

  const createUser = useCallback(async (newUser: Omit<User, 'id'>, password: string) => {
    // Use server-side API route to create user without losing current admin session
    try {
      const res = await fetch('/api/admin/create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newUser.email,
          password,
          name: newUser.name,
          role: newUser.role,
          company_id: newUser.company_id,
          allowed_modules: newUser.allowed_modules,
        }),
      });

      if (!res.ok) {
        let errorMsg = 'Error desconocido';
        try {
          const err = await res.json();
          errorMsg = err.error || errorMsg;
        } catch { /* non-JSON response */ }
        console.error('Error creating user:', errorMsg);
        throw new Error(`Error creando usuario: ${errorMsg}`);
      }
    } catch (err) {
      console.error('Failed to create user:', err);
      throw err;
    }

    // Refresh users list
    const current = userRef.current;
    if (current) {
      const allUsers = await fetchAllUsers(current.company_id);
      setUsers(allUsers);
      logAction(current.id, current.name, 'create', 'users', `Usuario creado: ${newUser.name} (${newUser.email}), rol: ${newUser.role}`);
    }
  }, []);

  // Sync email/password changes to Supabase Auth via server API
  const syncAuthUser = async (companyUserId: string, updates: { email?: string; password?: string }) => {
    if (!updates.email && !updates.password) return;

    // Get the auth user_id from company_users
    const { data } = await supabase
      .from('company_users')
      .select('user_id')
      .eq('id', companyUserId)
      .single();

    if (!data?.user_id) {
      console.error('Could not find auth user_id for company_user:', companyUserId);
      return;
    }

    try {
      const res = await fetch('/api/admin/update-auth-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authUserId: data.user_id,
          ...(updates.email && { email: updates.email }),
          ...(updates.password && { password: updates.password }),
        }),
      });

      if (!res.ok) {
        let errorMsg = 'Error desconocido';
        try {
          const err = await res.json();
          errorMsg = err.error || errorMsg;
        } catch { /* non-JSON response */ }
        console.error('Error syncing auth user:', errorMsg);
        throw new Error(`Error sincronizando usuario: ${errorMsg}`);
      }
    } catch (err) {
      console.error('Failed to sync auth user:', err);
      throw err;
    }
  };

  const updateUser = useCallback(async (id: string, updates: Partial<User>) => {
    const { error } = await supabase
      .from('company_users')
      .update({
        ...(updates.name !== undefined && { name: updates.name }),
        ...(updates.email !== undefined && { email: updates.email }),
        ...(updates.role !== undefined && { role: updates.role }),
        ...(updates.allowed_modules !== undefined && { allowed_modules: updates.allowed_modules }),
        ...(updates.twofa_enabled !== undefined && { twofa_enabled: updates.twofa_enabled }),
        ...(updates.twofa_secret !== undefined && { twofa_secret: updates.twofa_secret }),
      })
      .eq('id', id);

    if (error) {
      console.error('Error updating user:', error.message);
      return;
    }

    // Sync email change to Supabase Auth
    if (updates.email) {
      await syncAuthUser(id, { email: updates.email });
    }

    // Refresh users list
    const current = userRef.current;
    if (current) {
      const allUsers = await fetchAllUsers(current.company_id);
      setUsers(allUsers);
      // If updating current user, refresh their state
      if (current.id === id) {
        const updated = allUsers.find(u => u.id === id);
        if (updated) setUser(updated);
      }
      const fields = Object.keys(updates).join(', ');
      const targetUser = allUsers.find(u => u.id === id);
      logAction(current.id, current.name, 'update', 'users', `Usuario actualizado: ${targetUser?.name || id} - campos: ${fields}`);
    }
  }, []);

  const updateUserDirect = useCallback(async (id: string, updates: Partial<User & { password?: string }>) => {
    const { password, ...profileUpdates } = updates;
    if (Object.keys(profileUpdates).length > 0) {
      await supabase
        .from('company_users')
        .update(profileUpdates)
        .eq('id', id);
    }

    // Sync email and/or password changes to Supabase Auth
    if (updates.email || password) {
      await syncAuthUser(id, {
        ...(updates.email && { email: updates.email }),
        ...(password && { password }),
      });
    }

    const current = userRef.current;
    if (current) {
      const allUsers = await fetchAllUsers(current.company_id);
      setUsers(allUsers);
      if (current.id === id) {
        const updated = allUsers.find(u => u.id === id);
        if (updated) setUser(updated);
      }
    }
  }, []);

  const deleteUser = useCallback(async (id: string) => {
    const targetUser = users.find(u => u.id === id);

    // Use server-side API to delete BOTH company_users AND auth.users.
    // Otherwise the email stays reserved in Supabase Auth and can't be reused.
    try {
      const res = await fetch('/api/admin/delete-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyUserId: id }),
      });

      if (!res.ok) {
        let errorMsg = 'Error desconocido';
        try {
          const err = await res.json();
          errorMsg = err.error || errorMsg;
        } catch { /* non-JSON response */ }
        console.error('Error deleting user:', errorMsg);
        throw new Error(`Error eliminando usuario: ${errorMsg}`);
      }
    } catch (err) {
      console.error('Failed to delete user:', err);
      throw err;
    }

    const current = userRef.current;
    if (current) {
      const allUsers = await fetchAllUsers(current.company_id);
      setUsers(allUsers);
      if (targetUser) {
        logAction(current.id, current.name, 'delete', 'users', `Usuario eliminado: ${targetUser.name} (${targetUser.email})`);
      }
    }
  }, [users]);

  const changePassword = useCallback(async (_userId: string, _currentPassword: string, newPassword: string): Promise<boolean> => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      console.error('Error changing password:', error.message);
      return false;
    }
    return true;
  }, []);

  const resetPassword = useCallback(async (userEmail: string, newPassword: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/admin/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: userEmail, newPassword }),
      });

      if (!res.ok) {
        let errorMsg = 'Error desconocido';
        try {
          const err = await res.json();
          errorMsg = err.error || errorMsg;
        } catch { /* non-JSON response */ }
        console.error('Error resetting password:', errorMsg);
        return false;
      }
    } catch (err) {
      console.error('Failed to reset password:', err);
      return false;
    }

    const current = userRef.current;
    if (current) {
      logAction(current.id, current.name, 'update', 'users', `Contraseña reseteada para: ${userEmail}`);
    }
    return true;
  }, []);

  return (
    <AuthContext.Provider value={{ user, users, isLoading, login, loginWith2fa, logout, createUser, updateUser, deleteUser, changePassword, resetPassword, updateUserDirect }}>
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

export const ROLE_DEFAULT_MODULES: Record<string, string[]> = {
  admin: ALL_MODULES,
  socio: ['summary', 'movements', 'expenses', 'liquidity', 'investments', 'balances', 'partners'],
  auditor: ['summary', 'movements', 'expenses', 'liquidity', 'investments', 'balances', 'partners', 'upload'],
  soporte: ['summary', 'movements', 'expenses', 'liquidity', 'balances'],
  hr: ['summary', 'hr'],
  invitado: ['summary'],
};

export const MODULE_LABELS: Record<string, string> = {
  summary: 'Resumen',
  movements: 'Movimientos',
  expenses: 'Egresos',
  liquidity: 'Liquidez',
  investments: 'Inversiones',
  balances: 'Balances',
  partners: 'Socios',
  hr: 'Recursos Humanos',
  upload: 'Carga de Datos',
  periods: 'Períodos',
  users: 'Usuarios',
  audit: 'Auditoría',
};
