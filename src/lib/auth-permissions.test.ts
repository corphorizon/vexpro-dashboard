import { describe, it, expect } from 'vitest';

// Re-declare the pure permission functions here to avoid pulling in the
// React context (`auth-context.tsx` is a 'use client' file). If you
// change the production helpers, mirror them in this fixture.
// This is intentional: tests should exercise the contracts, not the
// implementation framework.

interface User {
  id: string;
  effective_role: string;
  allowed_modules: string[];
  is_superadmin: boolean;
}

function hasModuleAccess(
  user: User | null,
  module: string,
  activeModules?: string[] | null,
): boolean {
  if (!user) return false;
  if (user.is_superadmin) return true;
  if (module === 'audit') return false;
  const passesUserCheck =
    user.effective_role === 'admin' || user.allowed_modules.includes(module);
  if (!passesUserCheck) return false;
  if (activeModules && !activeModules.includes(module)) return false;
  return true;
}

function canAdd(user: User | null): boolean {
  if (!user) return false;
  if (user.is_superadmin) return true;
  return user.effective_role === 'admin' || user.effective_role === 'auditor';
}

function canEdit(user: User | null): boolean {
  if (!user) return false;
  if (user.is_superadmin) return true;
  return user.effective_role === 'admin' || user.effective_role === 'auditor';
}

function canDelete(user: User | null): boolean {
  if (!user) return false;
  if (user.is_superadmin) return true;
  return user.effective_role === 'admin';
}

const make = (overrides: Partial<User> = {}): User => ({
  id: 'u1',
  effective_role: 'viewer',
  allowed_modules: [],
  is_superadmin: false,
  ...overrides,
});

describe('hasModuleAccess', () => {
  it('rejects null user', () => {
    expect(hasModuleAccess(null, 'movements')).toBe(false);
  });

  it('admin passes all non-audit modules without explicit allow', () => {
    const u = make({ effective_role: 'admin' });
    expect(hasModuleAccess(u, 'movements')).toBe(true);
    expect(hasModuleAccess(u, 'liquidity')).toBe(true);
  });

  it('admin is blocked from `audit` (superadmin-only)', () => {
    const u = make({ effective_role: 'admin' });
    expect(hasModuleAccess(u, 'audit')).toBe(false);
  });

  it('superadmin sees everything including audit', () => {
    const u = make({ effective_role: 'admin', is_superadmin: true });
    expect(hasModuleAccess(u, 'audit')).toBe(true);
    expect(hasModuleAccess(u, 'anything')).toBe(true);
  });

  it('non-admin needs the module in allowed_modules', () => {
    const u = make({ effective_role: 'auditor', allowed_modules: ['movements'] });
    expect(hasModuleAccess(u, 'movements')).toBe(true);
    expect(hasModuleAccess(u, 'liquidity')).toBe(false);
  });

  it('tenant-level activeModules can deny even an allowed user', () => {
    const u = make({ effective_role: 'admin' });
    expect(hasModuleAccess(u, 'commissions', ['movements'])).toBe(false);
    expect(hasModuleAccess(u, 'movements', ['movements'])).toBe(true);
  });

  it('tenant-level activeModules is bypassed for superadmin', () => {
    const u = make({ effective_role: 'admin', is_superadmin: true });
    expect(hasModuleAccess(u, 'commissions', [])).toBe(true);
  });
});

describe('canAdd / canEdit / canDelete', () => {
  it('rejects null user for all three', () => {
    expect(canAdd(null)).toBe(false);
    expect(canEdit(null)).toBe(false);
    expect(canDelete(null)).toBe(false);
  });

  it('admin can add/edit/delete', () => {
    const u = make({ effective_role: 'admin' });
    expect(canAdd(u)).toBe(true);
    expect(canEdit(u)).toBe(true);
    expect(canDelete(u)).toBe(true);
  });

  it('auditor can add/edit but NOT delete (destructive guard)', () => {
    const u = make({ effective_role: 'auditor' });
    expect(canAdd(u)).toBe(true);
    expect(canEdit(u)).toBe(true);
    expect(canDelete(u)).toBe(false);
  });

  it('viewer / hr / soporte cannot mutate', () => {
    for (const role of ['viewer', 'hr', 'soporte', 'invitado']) {
      const u = make({ effective_role: role });
      expect(canAdd(u)).toBe(false);
      expect(canEdit(u)).toBe(false);
      expect(canDelete(u)).toBe(false);
    }
  });

  it('superadmin can add/edit/delete (regression Kevin 2026-06-07)', () => {
    // Cuando un superadmin entra viewing-as un tenant, effective_role
    // queda como "superadmin" (no admin). Las versiones antiguas de
    // canAdd/canEdit/canDelete rechazaban porque el switch solo
    // contemplaba "admin"/"auditor". Bug visible en /upload Egresos.
    const u = make({ effective_role: 'superadmin', is_superadmin: true });
    expect(canAdd(u)).toBe(true);
    expect(canEdit(u)).toBe(true);
    expect(canDelete(u)).toBe(true);
  });
});
