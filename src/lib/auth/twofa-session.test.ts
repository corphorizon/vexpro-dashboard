import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TWOFA_COOKIE,
  TWOFA_TTL_MS,
  mintTwofaSeal,
  twofaCookieOptions,
  twofaEnforcementDisabled,
  twofaSealAvailable,
  verifyTwofaSeal,
} from './twofa-session';

// ─────────────────────────────────────────────────────────────────────────────
// El contrato de seguridad del login, escrito como test.
//
// LA REGLA QUE FIJA ESTE ARCHIVO: una sesión SIN sello no vale para un
// usuario con twofa_enabled = true. El sello lo firma el servidor con una
// clave que nunca sale de ahí, así que quien sólo tiene la contraseña (y se
// fabrica un token contra GoTrue con la anon key pública) no puede
// producirlo.
// ─────────────────────────────────────────────────────────────────────────────

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.TWOFA_SESSION_SECRET = 'clave-de-prueba-que-solo-vive-en-el-servidor';
  delete process.env.TWOFA_SESSION_ENFORCE;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe('sello 2FA — camino feliz', () => {
  it('un sello recién emitido vale para SU usuario', async () => {
    const seal = await mintTwofaSeal(USER);
    expect(seal).toBeTruthy();
    expect(await verifyTwofaSeal(seal, USER)).toBe(true);
  });

  it('el control está activo cuando hay clave y no hay kill switch', () => {
    expect(twofaSealAvailable()).toBe(true);
    expect(twofaEnforcementDisabled()).toBe(false);
  });
});

describe('sello 2FA — rechazos (la regla nueva)', () => {
  it('SIN sello ⇒ rechazado (el caso del atacante con sólo la contraseña)', async () => {
    expect(await verifyTwofaSeal(undefined, USER)).toBe(false);
    expect(await verifyTwofaSeal(null, USER)).toBe(false);
    expect(await verifyTwofaSeal('', USER)).toBe(false);
  });

  it('sello de OTRO usuario ⇒ rechazado', async () => {
    const seal = await mintTwofaSeal(OTHER_USER);
    expect(await verifyTwofaSeal(seal, USER)).toBe(false);
  });

  it('sello adulterado (firma cambiada) ⇒ rechazado', async () => {
    const seal = (await mintTwofaSeal(USER))!;
    const [sub, exp, sig] = seal.split('.');
    const tampered = `${sub}.${exp}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;
    expect(await verifyTwofaSeal(tampered, USER)).toBe(false);
  });

  it('vencimiento estirado a mano ⇒ rechazado (la firma cubre el exp)', async () => {
    const seal = (await mintTwofaSeal(USER))!;
    const [sub, exp, sig] = seal.split('.');
    const stretched = `${sub}.${Number(exp) + 999_999_999}.${sig}`;
    expect(await verifyTwofaSeal(stretched, USER)).toBe(false);
  });

  it('sello vencido ⇒ rechazado', async () => {
    const past = Date.now() - TWOFA_TTL_MS - 1000;
    const seal = await mintTwofaSeal(USER, past);
    expect(await verifyTwofaSeal(seal, USER)).toBe(false);
    // …y era válido en su momento.
    expect(await verifyTwofaSeal(seal, USER, past + 1000)).toBe(true);
  });

  it('formato basura ⇒ rechazado, sin explotar', async () => {
    for (const junk of ['a', 'a.b', 'a.b.c.d', `${USER}..`, '....']) {
      expect(await verifyTwofaSeal(junk, USER)).toBe(false);
    }
  });

  it('un sello firmado con OTRA clave ⇒ rechazado', async () => {
    const seal = await mintTwofaSeal(USER);
    process.env.TWOFA_SESSION_SECRET = 'otra-clave-distinta';
    expect(await verifyTwofaSeal(seal, USER)).toBe(false);
  });
});

describe('sello 2FA — fail-safe (nunca dejar a todos afuera)', () => {
  it('sin material de clave el control se desactiva en vez de bloquear', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.TWOFA_SESSION_SECRET;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(twofaSealAvailable()).toBe(false);
    expect(await mintTwofaSeal(USER)).toBeNull();
  });

  it('cae a SUPABASE_SERVICE_ROLE_KEY cuando no hay clave dedicada', async () => {
    delete process.env.TWOFA_SESSION_SECRET;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-de-prueba';
    expect(twofaSealAvailable()).toBe(true);
    const seal = await mintTwofaSeal(USER);
    expect(await verifyTwofaSeal(seal, USER)).toBe(true);
  });

  it('el interruptor de emergencia apaga el control', () => {
    process.env.TWOFA_SESSION_ENFORCE = 'off';
    expect(twofaEnforcementDisabled()).toBe(true);
    expect(twofaSealAvailable()).toBe(false);
  });
});

describe('sello 2FA — cookie', () => {
  it('es httpOnly, sameSite lax y con path raíz', () => {
    const opts = twofaCookieOptions();
    expect(TWOFA_COOKIE).toBe('fd_2fa');
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
    expect(opts.maxAge).toBe(TWOFA_TTL_MS / 1000);
  });
});
