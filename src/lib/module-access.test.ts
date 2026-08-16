import { describe, it, expect } from 'vitest';
import { canAccessModule, canAccessAnyModule } from './modules';

// ─────────────────────────────────────────────────────────────────────────────
// `canAccessModule` es la ÚNICA regla de acceso a módulos: la llaman
// `hasModuleAccess` (cliente, auth-context) y `verifyAuth`/`verifyAdminAuth`
// (servidor, api-auth). Antes de esto el guard era cosmético — el cliente
// escondía la pantalla y la API contestaba igual a un fetch desde la consola.
//
// Estos tests fijan el ORDEN de los chequeos, que es la parte fácil de romper.
// ─────────────────────────────────────────────────────────────────────────────

const BROKER = 'broker';
const COMPANY = 'company';

describe('canAccessModule — nivel usuario', () => {
  it('el admin de empresa pasa aunque el módulo NO esté en su allowed_modules', () => {
    expect(
      canAccessModule('payment_orders', {
        role: 'admin',
        allowedModules: [],
        activeModules: ['payment_orders'],
        businessModel: BROKER,
      }),
    ).toBe(true);
  });

  it('un usuario normal SIN el módulo no pasa', () => {
    expect(
      canAccessModule('payment_orders', {
        role: 'socio',
        allowedModules: ['summary', 'balances'],
        activeModules: ['payment_orders'],
        businessModel: BROKER,
      }),
    ).toBe(false);
  });

  it('un usuario normal CON el módulo pasa', () => {
    expect(
      canAccessModule('payment_orders', {
        role: 'socio',
        allowedModules: ['payment_orders'],
        activeModules: ['payment_orders'],
        businessModel: BROKER,
      }),
    ).toBe(true);
  });
});

describe('canAccessModule — nivel tenant', () => {
  it('un módulo apagado en active_modules no pasa NI para el admin', () => {
    expect(
      canAccessModule('payment_orders', {
        role: 'admin',
        allowedModules: ['payment_orders'],
        activeModules: ['summary', 'balances'],
        businessModel: BROKER,
      }),
    ).toBe(false);
  });

  it('active_modules null = no se comprueba el nivel tenant', () => {
    expect(
      canAccessModule('payment_orders', {
        role: 'socio',
        allowedModules: ['payment_orders'],
        activeModules: null,
        businessModel: BROKER,
      }),
    ).toBe(true);
  });

  it('active_modules vacío SÍ bloquea (empresa sin módulos habilitados)', () => {
    expect(
      canAccessModule('payment_orders', {
        role: 'admin',
        allowedModules: ['payment_orders'],
        activeModules: [],
        businessModel: BROKER,
      }),
    ).toBe(false);
  });
});

describe('canAccessModule — modelo de negocio', () => {
  it('un módulo bloqueado por el modelo no pasa NI para el superadmin', () => {
    for (const blocked of ['risk', 'commissions', 'ib_rebates', 'movements', 'liquidity', 'investments']) {
      expect(
        canAccessModule(blocked, {
          role: 'admin',
          isSuperadmin: true,
          allowedModules: null,
          activeModules: [blocked],
          businessModel: COMPANY,
        }),
      ).toBe(false);
    }
  });

  it('el mismo módulo sí pasa en un broker', () => {
    expect(
      canAccessModule('risk', {
        role: 'admin',
        isSuperadmin: true,
        activeModules: ['risk'],
        businessModel: BROKER,
      }),
    ).toBe(true);
  });

  it('el modelo manda aunque la empresa lo tenga tildado en active_modules', () => {
    expect(
      canAccessModule('movements', {
        role: 'admin',
        allowedModules: ['movements'],
        activeModules: ['movements'],
        businessModel: COMPANY,
      }),
    ).toBe(false);
  });
});

describe('canAccessModule — superadmin', () => {
  it('ignora allowed_modules y active_modules', () => {
    expect(
      canAccessModule('payment_orders', {
        role: 'admin',
        isSuperadmin: true,
        allowedModules: [],
        activeModules: [],
        businessModel: BROKER,
      }),
    ).toBe(true);
  });
});

describe('canAccessModule — reservados', () => {
  it('`audit` es exclusivo del superadmin: ni el admin de empresa entra', () => {
    expect(
      canAccessModule('audit', {
        role: 'admin',
        allowedModules: ['audit'],
        activeModules: ['audit'],
        businessModel: BROKER,
      }),
    ).toBe(false);
    expect(
      canAccessModule('audit', {
        role: 'admin',
        isSuperadmin: true,
        businessModel: BROKER,
      }),
    ).toBe(true);
  });
});

describe('canAccessModule — defaults del servidor', () => {
  it('sin businessModel se asume broker (default histórico)', () => {
    expect(
      canAccessModule('movements', { role: 'admin', activeModules: ['movements'] }),
    ).toBe(true);
  });

  it('allowedModules null en un rol no-admin no pasa', () => {
    expect(
      canAccessModule('movements', { role: 'socio', allowedModules: null }),
    ).toBe(false);
  });
});

describe('canAccessAnyModule', () => {
  const ctx = {
    role: 'socio',
    allowedModules: ['balances'],
    activeModules: ['balances', 'movements'],
    businessModel: BROKER,
  };

  it('alcanza con UNO de los módulos (semántica OR)', () => {
    expect(canAccessAnyModule(['movements', 'balances'], ctx)).toBe(true);
  });

  it('sin ninguno, no pasa', () => {
    expect(canAccessAnyModule(['movements', 'hr'], ctx)).toBe(false);
  });

  it('lista vacía = ruta transversal, pasa', () => {
    expect(canAccessAnyModule([], ctx)).toBe(true);
  });
});
