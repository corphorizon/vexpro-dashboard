'use client';

import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createClient } from '@/lib/supabase/client';
import { logAction } from '@/lib/audit-log';
import { withActiveCompany } from '@/lib/api-fetch';
import { getActiveCompanyId, subscribeActiveCompanyId } from '@/lib/active-company';
import type { User as SupabaseUser } from '@supabase/supabase-js';

export type UserRole =
  | 'admin'
  | 'socio'
  | 'auditor'
  | 'soporte'
  | 'hr'
  | 'invitado'
  | 'superadmin';

export interface User {
  id: string;
  /**
   * `auth.users.id` — the Supabase Auth UUID. Needed when writing to tables
   * that FK to `auth.users(id)` (e.g. `commercial_profiles.terminated_by`).
   * Distinct from `id`, which is the `company_users.id` / `platform_users.id`
   * PK depending on the login path.
   */
  auth_user_id: string;
  email: string;
  name: string;
  role: UserRole;
  /**
   * Resolved capability tier. For built-in roles it equals `role`. For custom
   * roles it resolves to the role's `base_role`. Permission helpers check
   * this field, not `role`, so custom roles can inherit admin/auditor tiers.
   */
  effective_role: UserRole;
  /**
   * Null when the user is a platform-level SUPERADMIN — they don't belong to
   * any company and work cross-tenant. Non-null for every other role.
   */
  company_id: string | null;
  allowed_modules: string[];
  twofa_enabled: boolean;
  force_2fa_setup: boolean;
  must_change_password: boolean;
  /** True only when the user record came from `platform_users`, not `company_users`. */
  is_superadmin: boolean;
}

// ─── Built-in roles — single source of truth ─────────────────────────────
// These are the roles accepted by the `company_users.role` CHECK constraint
// in Postgres. Any UI that picks a role, any API that validates one, and
// any permission function that branches on role MUST import from here.
// Adding a new built-in role requires: (1) updating this list, (2) updating
// the DB CHECK constraint via migration, (3) adding a case to any permission
// matrix that covers roles exhaustively.
export const BUILT_IN_ROLES = ['admin', 'socio', 'auditor', 'soporte', 'hr', 'invitado'] as const;

export type BuiltInRole = typeof BUILT_IN_ROLES[number];

/** Human-readable labels for the 6 built-in roles — for selects/badges. */
export const BUILT_IN_ROLE_LABELS: Record<BuiltInRole, string> = {
  admin: 'Admin',
  socio: 'Socio',
  auditor: 'Auditor',
  soporte: 'Soporte',
  hr: 'HR',
  invitado: 'Invitado',
};

export type LoginResult =
  | { success: true; needs2fa: false }
  | { success: true; needs2fa: true; userId: string; email: string }
  | { success: false; needs2fa: false; locked?: boolean; attemptsLeft?: number; error?: string };

// twofa_secret is excluded from User but needed for DB writes (setup/deactivation)
type UserUpdate = Partial<User> & { twofa_secret?: string | null };

interface AuthState {
  user: User | null;
  users: User[];
  isLoading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  loginWith2fa: (email: string, password: string, pin: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
  createUser: (user: Omit<User, 'id' | 'auth_user_id'>) => void;
  updateUser: (id: string, updates: UserUpdate) => void;
  deleteUser: (id: string) => void;
  changePassword: (userId: string, currentPassword: string, newPassword: string) => Promise<boolean>;
  resetPassword: (userEmail: string, newPassword: string) => Promise<boolean>;
  updateUserDirect: (id: string, updates: Partial<User & { password?: string }>) => void;
  refreshUser: () => Promise<void>;
}

// Modules assignable to a tenant user. Excludes:
//   · `settings` — dissolved (Roles now live inside /usuarios; APIs externas
//     only in the superadmin panel).
//   · `audit`    — reserved for SUPERADMIN only. Tenants cannot grant the
//     audit module to their users; platform-level audit lives inside the
//     superadmin panel (/superadmin/companies/[id]).
const ALL_MODULES = ['summary', 'movements', 'expenses', 'liquidity', 'investments', 'balances', 'partners', 'commissions', 'reports', 'hr', 'risk', 'upload', 'periods', 'users'];

const AuthContext = createContext<AuthState | null>(null);

const supabase = createClient();

/** Resolve a role string to its capability tier (base_role for custom roles). */
async function resolveEffectiveRole(role: string, companyId: string): Promise<UserRole> {
  if (BUILT_IN_ROLES.includes(role as typeof BUILT_IN_ROLES[number])) return role as UserRole;
  const { data } = await supabase
    .from('custom_roles')
    .select('base_role')
    .eq('company_id', companyId)
    .eq('name', role)
    .maybeSingle();
  return ((data?.base_role as UserRole) ?? 'invitado');
}

// Fetch the profile for a given auth user.
//
// Resolution order:
//   1. `company_users` — standard tenant user. Carries company_id + role.
//   2. `platform_users` — Horizon superadmin. No company_id, cross-tenant.
//
// Returns null only if the auth user is authenticated but has no profile at
// either table (orphan auth.user).
async function fetchUserProfile(authUser: SupabaseUser): Promise<User | null> {
  // 1) Try company_users first — most users live here.
  const { data: cu, error: cuErr } = await supabase
    .from('company_users')
    .select('*')
    .eq('user_id', authUser.id)
    .maybeSingle();

  if (!cuErr && cu) {
    const effective_role = await resolveEffectiveRole(cu.role, cu.company_id);
    return {
      id: cu.id,
      auth_user_id: authUser.id,
      email: cu.email,
      name: cu.name,
      role: cu.role as UserRole,
      effective_role,
      company_id: cu.company_id,
      allowed_modules: cu.allowed_modules || [],
      twofa_enabled: cu.twofa_enabled || false,
      force_2fa_setup: cu.force_2fa_setup ?? true,
      must_change_password: cu.must_change_password ?? false,
      is_superadmin: false,
    };
  }

  // 2) Not in company_users — try platform_users (superadmin).
  const { data: pu, error: puErr } = await supabase
    .from('platform_users')
    .select('*')
    .eq('user_id', authUser.id)
    .maybeSingle();

  if (!puErr && pu) {
    // Superadmin has access to every module conceptually. We still ship the
    // full module list so UI guards that check `allowed_modules` pass. The
    // real cross-tenant reads are gated by RLS (`is_superadmin()` bypass).
    return {
      id: pu.id,
      auth_user_id: authUser.id,
      email: pu.email,
      name: pu.name,
      role: 'superadmin',
      effective_role: 'superadmin',
      company_id: null,
      allowed_modules: ALL_MODULES,
      twofa_enabled: pu.twofa_enabled || false,
      // 2FA enrolment is now mandatory for superadmins too — the flag
      // lives on platform_users (migration 029). Default to true (force
      // setup) when the column is missing on older rows.
      force_2fa_setup: pu.force_2fa_setup ?? true,
      must_change_password: false,
      is_superadmin: true,
    };
  }

  console.error('Auth user has no profile in company_users or platform_users:', authUser.id);
  return null;
}

/**
 * Returns the company_id that the current auth user is operating in.
 * For regular users that's their own company_id from `company_users`. For
 * superadmins (`platform_users`, company_id = null), it falls back to the
 * "viewing as" company stored in localStorage by /superadmin/companies/*.
 *
 * Returns null only when a superadmin hasn't entered any company yet.
 */
function effectiveCompanyIdFor(profile: User | null): string | null {
  if (!profile) return null;
  if (profile.company_id) return profile.company_id;
  // Platform user (superadmin) — fall back to active "viewing as" company.
  return getActiveCompanyId();
}

// Fetch all company_users for the same company — never include twofa_secret.
// Returns empty array when called with null (superadmin context with no
// active company yet).
//
// Goes through /api/admin/list-company-users instead of querying Supabase
// directly so platform superadmins in "viewing-as" mode bypass RLS — they
// don't have a row in the target tenant's company_users and a direct
// browser query would silently return [].
async function fetchAllUsers(companyId: string | null): Promise<User[]> {
  if (!companyId) return [];
  try {
    const res = await fetch(withActiveCompany('/api/admin/list-company-users'));
    if (!res.ok) {
      console.error('Error fetching users:', res.status, res.statusText);
      return [];
    }
    const json = await res.json();
    if (!json.success) {
      console.error('Error fetching users:', json.error);
      return [];
    }
    return json.users as User[];
  } catch (err) {
    console.error('Error fetching users:', err);
    return [];
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const userRef = useRef<User | null>(null);
  useEffect(() => { userRef.current = user; }, [user]);
  // Mirror del state `users` accesible desde callbacks. Necesario para
  // poder leer `auth_user_id` (y otros campos) del usuario que se está
  // editando sin tener que re-querear `company_users` desde el browser
  // — esa query queda bloqueada por RLS cuando un superadmin edita en
  // modo viewing-as.
  const usersRef = useRef<User[]>([]);
  useEffect(() => { usersRef.current = users; }, [users]);

  // Initialize: check for existing Supabase session
  useEffect(() => {
    async function init() {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          const profile = await fetchUserProfile(session.user);
          if (profile) {
            setUser(profile);
            const allUsers = await fetchAllUsers(effectiveCompanyIdFor(profile));
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
          const allUsers = await fetchAllUsers(effectiveCompanyIdFor(profile));
          setUsers(allUsers);
        }
      }
    });

    // Re-fetch the user list when the superadmin switches "viewing-as"
    // company. Tenant admins have a fixed company_id and ignore this — only
    // platform users (company_id = null) react to the localStorage change.
    const unsubscribeCompany = subscribeActiveCompanyId(async (next) => {
      const current = userRef.current;
      if (!current || current.company_id) return;
      const allUsers = await fetchAllUsers(next);
      setUsers(allUsers);
    });

    return () => {
      subscription.unsubscribe();
      unsubscribeCompany();
    };
  }, []);

  // Refresh user profile from DB (e.g., after enabling 2FA)
  const refreshUser = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
      const profile = await fetchUserProfile(session.user);
      if (profile) {
        setUser(profile);
        const allUsers = await fetchAllUsers(effectiveCompanyIdFor(profile));
        setUsers(allUsers);
      }
    }
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<LoginResult> => {
    // Step 1: server-side gate — checks lockout + verifies credentials WITHOUT
    // setting a cookie. Prevents bypassing our counter by talking to Supabase
    // directly from the browser.
    const gateRes = await fetch('/api/auth/login-gate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const gate = await gateRes.json();

    if (!gate.success) {
      return {
        success: false,
        needs2fa: false,
        locked: !!gate.locked,
        attemptsLeft: gate.attemptsLeft,
        error: gate.error,
      };
    }

    // If 2FA is required, defer the real sign-in until after PIN verification.
    if (gate.needs2fa) {
      return { success: true, needs2fa: true, userId: gate.userId, email };
    }

    // No 2FA → establish the real cookie-backed session now.
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      return { success: false, needs2fa: false, error: 'No fue posible iniciar sesión' };
    }

    const profile = await fetchUserProfile(data.user);
    if (!profile) {
      return { success: false, needs2fa: false };
    }

    setUser(profile);
    const allUsers = await fetchAllUsers(effectiveCompanyIdFor(profile));
    setUsers(allUsers);
    logAction(profile.id, profile.name, 'login', 'auth', `Inicio de sesión: ${profile.email}`);
    return { success: true, needs2fa: false };
  }, []);

  const loginWith2fa = useCallback(async (
    email: string,
    password: string,
    pin: string,
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      // 1. Verify PIN server-side (never compare on client)
      const res = await fetch('/api/auth/verify-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, pin }),
      });
      const data = await res.json();

      if (!data.success) {
        return { success: false, error: data.error || 'PIN incorrecto' };
      }

      // 2. PIN verified — re-authenticate to establish proper Supabase session
      const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError || !signInData.user) {
        return { success: false, error: 'Error al restablecer sesión' };
      }

      // 3. Load profile and set state
      const profile = await fetchUserProfile(signInData.user);
      if (!profile) {
        return { success: false, error: 'Perfil no encontrado' };
      }

      setUser(profile);
      const allUsers = await fetchAllUsers(effectiveCompanyIdFor(profile));
      setUsers(allUsers);
      logAction(profile.id, profile.name, 'login', 'auth', `Inicio de sesión con 2FA: ${profile.email}`);
      return { success: true };
    } catch {
      return { success: false, error: 'Error de conexión' };
    }
  }, []);

  const logout = useCallback(async () => {
    const prev = userRef.current;
    if (prev) {
      logAction(prev.id, prev.name, 'logout', 'auth', `Cierre de sesión: ${prev.email}`);
    }
    await supabase.auth.signOut();
    // Clear tenant-scoped state that lives in localStorage — otherwise the
    // next user on the same browser would inherit:
    //   · fd_audit_log → the previous session's local audit trail
    //   · horizon.superadmin.activeCompanyId → the previous superadmin's
    //     "viewing as" selection (would accidentally scope the next user
    //     to the wrong tenant on first load)
    // Other keys (fd_theme, fd_lang) stay — they're UX prefs, not sensitive.
    try {
      // Lazy import avoids any SSR "localStorage is not defined" issues.
      // These helpers already no-op on the server.
      const { clearAuditLog } = await import('./audit-log');
      const { clearActiveCompanyId } = await import('./active-company');
      clearAuditLog();
      clearActiveCompanyId();
    } catch {
      // Non-fatal — worst case the next user sees stale non-sensitive data.
    }
    setUser(null);
  }, []);

  const createUser = useCallback(async (newUser: Omit<User, 'id' | 'auth_user_id'>) => {
    // Use server-side API route — sends an invitation email instead of
    // accepting a fixed password. The user creates their own credential
    // via /reset-password?token=...&mode=setup.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    try {
      const res = await fetch(withActiveCompany('/api/admin/create-user'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          email: newUser.email,
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
        throw new Error(errorMsg);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('La creación del usuario tardó demasiado. Verifica si fue creado y recarga la página.');
      }
      console.error('Failed to create user:', err);
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    // Refresh users list — wrap in try/catch so UI never hangs even if this fails.
    // The user was already created successfully on the backend at this point.
    const current = userRef.current;
    if (current) {
      try {
        const allUsers = await fetchAllUsers(effectiveCompanyIdFor(current));
        setUsers(allUsers);
      } catch (refreshErr) {
        console.error('User created but list refresh failed:', refreshErr);
      }
      logAction(current.id, current.name, 'create', 'users', `Usuario creado: ${newUser.name} (${newUser.email}), rol: ${newUser.role}`);
    }
  }, []);

  // Sync email/password changes to Supabase Auth via server API.
  //
  // `authUserIdHint` permite que el caller pase el `auth_user_id` ya
  // resuelto (típicamente desde `usersRef.current`) — evita la query
  // browser-side que RLS bloquea para superadmins en modo viewing-as.
  // Si no se provee, intentamos resolverlo desde el state como primer
  // fallback; recién en último caso vamos por `company_users`.
  const syncAuthUser = async (
    companyUserId: string,
    updates: { email?: string; password?: string },
    authUserIdHint?: string | null,
  ) => {
    if (!updates.email && !updates.password) return;

    let authUserId: string | null | undefined = authUserIdHint;
    if (!authUserId) {
      const fromState = usersRef.current.find((u) => u.id === companyUserId);
      authUserId = fromState?.auth_user_id;
    }
    if (!authUserId) {
      const { data } = await supabase
        .from('company_users')
        .select('user_id')
        .eq('id', companyUserId)
        .maybeSingle();
      authUserId = data?.user_id ?? null;
    }

    if (!authUserId) {
      // El company_user no tiene auth.user asociado (legacy / aún no
      // activado / RLS lo ocultó). Salida silenciosa: no hay nada que
      // sincronizar — el UPDATE de profile ya se hizo arriba.
      return;
    }

    try {
      const res = await fetch(withActiveCompany('/api/admin/update-auth-user'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authUserId,
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

  const updateUser = useCallback(async (id: string, updates: UserUpdate) => {
    // Snapshot del user antes del UPDATE para comparar email y resolver
    // auth_user_id sin re-querear el browser.
    const targetBefore = usersRef.current.find((u) => u.id === id);

    // Vamos por el endpoint admin (createAdminClient bypassa RLS) en vez
    // del UPDATE browser-side: cuando un superadmin opera en modo
    // viewing-as una empresa donde no es miembro, RLS filtra silencio-
    // samente la escritura — la query "succeed-ea" pero no escribe nada,
    // así que la UI decía "guardado" y el cambio nunca llegaba a BD.
    try {
      const payload: Record<string, unknown> = { companyUserId: id };
      if (updates.name !== undefined) payload.name = updates.name;
      if (updates.email !== undefined) payload.email = updates.email;
      if (updates.role !== undefined) payload.role = updates.role;
      if (updates.allowed_modules !== undefined) payload.allowed_modules = updates.allowed_modules;
      if (updates.twofa_enabled !== undefined) payload.twofa_enabled = updates.twofa_enabled;
      if (updates.twofa_secret !== undefined) payload.twofa_secret = updates.twofa_secret;

      const res = await fetch(withActiveCompany('/api/admin/update-company-user'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        let errorMsg = 'Error desconocido';
        try {
          const err = await res.json();
          errorMsg = err.error || errorMsg;
        } catch { /* non-JSON response */ }
        console.error('Error updating user:', errorMsg);
        return;
      }
    } catch (err) {
      console.error('Failed to update user:', err);
      return;
    }

    // Sync a Supabase Auth solo si el email REALMENTE cambió. El form de
    // /usuarios siempre incluye `email` en el payload aunque el admin
    // sólo haya tocado los módulos — sin esta comparación dispararíamos
    // el sync (y su query a company_users) en cada edit innecesariamente.
    if (updates.email && targetBefore && updates.email !== targetBefore.email) {
      await syncAuthUser(id, { email: updates.email }, targetBefore.auth_user_id);
    }

    // Refresh users list
    const current = userRef.current;
    if (current) {
      const allUsers = await fetchAllUsers(effectiveCompanyIdFor(current));
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
    const targetBefore = usersRef.current.find((u) => u.id === id);
    const { password, ...profileUpdates } = updates;
    // Mismo motivo que updateUser: vamos por el endpoint admin para que
    // RLS no nos coma la escritura cuando el caller es superadmin
    // viewing-as.
    if (Object.keys(profileUpdates).length > 0) {
      try {
        const res = await fetch(withActiveCompany('/api/admin/update-company-user'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ companyUserId: id, ...profileUpdates }),
        });
        if (!res.ok) {
          let errorMsg = 'Error desconocido';
          try {
            const err = await res.json();
            errorMsg = err.error || errorMsg;
          } catch { /* non-JSON response */ }
          console.error('Error updating user (direct):', errorMsg);
        }
      } catch (err) {
        console.error('Failed to update user (direct):', err);
      }
    }

    // Mismo criterio que updateUser: solo sync si el email cambió de
    // verdad (o si llega password). Pasamos el auth_user_id desde el
    // state para no depender de query browser-side.
    const emailChanged = !!updates.email && !!targetBefore && updates.email !== targetBefore.email;
    if (emailChanged || password) {
      await syncAuthUser(id, {
        ...(emailChanged && { email: updates.email }),
        ...(password && { password }),
      }, targetBefore?.auth_user_id);
    }

    const current = userRef.current;
    if (current) {
      const allUsers = await fetchAllUsers(effectiveCompanyIdFor(current));
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
      const res = await fetch(withActiveCompany('/api/admin/delete-user'), {
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
      const allUsers = await fetchAllUsers(effectiveCompanyIdFor(current));
      setUsers(allUsers);
      if (targetUser) {
        logAction(current.id, current.name, 'delete', 'users', `Usuario eliminado: ${targetUser.name} (${targetUser.email})`);
      }
    }
  }, [users]);

  const changePassword = useCallback(async (_userId: string, currentPassword: string, newPassword: string): Promise<boolean> => {
    // Verify current password by re-authenticating before allowing change
    const currentUser = userRef.current;
    if (!currentUser) return false;

    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email: currentUser.email,
      password: currentPassword,
    });

    if (verifyError) {
      console.error('Current password verification failed');
      return false;
    }

    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      console.error('Error changing password:', error.message);
      return false;
    }
    return true;
  }, []);

  const resetPassword = useCallback(async (userEmail: string, newPassword: string): Promise<boolean> => {
    try {
      const res = await fetch(withActiveCompany('/api/admin/reset-password'), {
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

  // ─── Inactivity auto-logout ───────────────────────────────────
  // Change INACTIVITY_MS to adjust (2 min for testing, 2h for prod).
  const INACTIVITY_MS = 2 * 60 * 60 * 1000; // 2 hours
  const WARNING_MS = 60 * 1000; // Show warning 60s before logout

  const [showInactivityWarning, setShowInactivityWarning] = useState(false);

  // Store timer IDs in a plain object ref so nothing can interfere
  const timers = useRef({ warn: 0, logout: 0, locked: false });

  const scheduleInactivityTimers = useCallback(() => {
    // Clear any existing timers
    window.clearTimeout(timers.current.warn);
    window.clearTimeout(timers.current.logout);
    timers.current.locked = false;
    setShowInactivityWarning(false);

    // Schedule warning
    timers.current.warn = window.setTimeout(() => {
      timers.current.locked = true;
      setShowInactivityWarning(true);
    }, INACTIVITY_MS - WARNING_MS);

    // Schedule hard logout — this WILL fire no matter what
    timers.current.logout = window.setTimeout(() => {
      const prev = userRef.current;
      if (prev) {
        logAction(prev.id, prev.name, 'logout', 'auth', `Cierre por inactividad: ${prev.email}`);
      }
      supabase.auth.signOut();
      setUser(null);
      setShowInactivityWarning(false);
      timers.current.locked = false;
    }, INACTIVITY_MS);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Continuar sesion" button handler
  const handleContinueSession = useCallback(() => {
    scheduleInactivityTimers();
  }, [scheduleInactivityTimers]);

  // Set up activity listeners + initial timers when user logs in
  useEffect(() => {
    if (!user) {
      window.clearTimeout(timers.current.warn);
      window.clearTimeout(timers.current.logout);
      timers.current.locked = false;
      setShowInactivityWarning(false);
      return;
    }

    // Activity resets timers — but NOT when warning is showing
    const onActivity = () => {
      if (timers.current.locked) return;
      scheduleInactivityTimers();
    };

    const events: (keyof WindowEventMap)[] = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    events.forEach(evt => window.addEventListener(evt, onActivity, { passive: true }));

    // Start initial timers
    scheduleInactivityTimers();

    return () => {
      events.forEach(evt => window.removeEventListener(evt, onActivity));
      window.clearTimeout(timers.current.warn);
      window.clearTimeout(timers.current.logout);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  return (
    <AuthContext.Provider value={{ user, users, isLoading, login, loginWith2fa, logout, createUser, updateUser, deleteUser, changePassword, resetPassword, updateUserDirect, refreshUser }}>
      {children}
      {/* Inactivity warning modal */}
      {showInactivityWarning && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 border border-amber-300 dark:border-amber-700 rounded-xl p-6 shadow-xl w-full max-w-sm mx-4 text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-amber-100 dark:bg-amber-900/50 mb-4">
              <svg className="w-7 h-7 text-amber-600 dark:text-amber-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-2">Sesion a punto de expirar</h3>
            <p className="text-sm text-slate-600 dark:text-slate-300 mb-5">
              Tu sesion se cerrara en 1 minuto por inactividad. Mueve el mouse o presiona una tecla para continuar.
            </p>
            <button
              onClick={handleContinueSession}
              className="w-full py-2.5 rounded-lg bg-[var(--color-primary)] text-white font-medium text-sm hover:opacity-90 transition-opacity"
            >
              Continuar sesion
            </button>
          </div>
        </div>
      )}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/**
 * Check if a user can access a module.
 *
 * Two layers of authorization:
 *   1. User-level: the user has the module in their `allowed_modules` list
 *      (company admins bypass this list — they access everything).
 *   2. Tenant-level: if the caller passes `activeModules`, the module must
 *      also be present there. A module the tenant has deactivated is
 *      invisible and unreachable regardless of the user's permissions.
 *
 * The SUPERADMIN (platform) bypasses both layers and sees every module,
 * regardless of what the current tenant has enabled — they need to audit
 * and configure tenants that may have restrictive setups.
 *
 * Backward compatible: call sites that don't pass `activeModules` keep the
 * original user-only semantics.
 */
export function hasModuleAccess(
  user: User | null,
  module: string,
  activeModules?: string[] | null,
): boolean {
  if (!user) return false;
  // Platform superadmin sees everything — tenant filters don't apply.
  if (user.is_superadmin) return true;

  // `audit` is reserved for SUPERADMIN. Not even a tenant admin can access
  // /auditoria — platform-level auditing is surfaced inside /superadmin
  // (per-company tabs).
  if (module === 'audit') return false;

  // User-level check: admins pass; others must have the module on their list.
  const passesUserCheck =
    user.effective_role === 'admin' || user.allowed_modules.includes(module);
  if (!passesUserCheck) return false;

  // Tenant-level check (optional — skipped when activeModules not provided).
  if (activeModules && !activeModules.includes(module)) return false;

  return true;
}

export function canAdd(user: User | null): boolean {
  if (!user) return false;
  return user.effective_role === 'admin' || user.effective_role === 'auditor';
}

export function canEdit(user: User | null): boolean {
  if (!user) return false;
  return user.effective_role === 'admin' || user.effective_role === 'auditor';
}

export function canDelete(user: User | null): boolean {
  if (!user) return false;
  return user.effective_role === 'admin';
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
  socio: ['summary', 'movements', 'expenses', 'liquidity', 'investments', 'balances', 'partners', 'reports'],
  auditor: ['summary', 'movements', 'expenses', 'liquidity', 'investments', 'balances', 'partners', 'upload', 'risk', 'reports'],
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
  commissions: 'Comisiones',
  reports: 'Reportes',
  hr: 'Recursos Humanos',
  risk: 'Gestión de Riesgo',
  upload: 'Carga de Datos',
  periods: 'Períodos',
  users: 'Usuarios',
  ib_rebates: 'Configuración IBs',
  // audit + settings intentionally omitted — see comment above ALL_MODULES.
};
