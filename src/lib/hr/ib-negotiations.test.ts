import { describe, it, expect } from 'vitest';
import {
  isDealType,
  emptyIbNumbers,
  toNumber,
  ibDisplayName,
  IB_DEAL_TYPES,
  type IbNegotiationPackage,
  type IbNegotiationRow,
  type IbProfile,
} from './ib-negotiations';

const neg = (p: Partial<IbNegotiationRow> = {}): IbNegotiationRow => ({
  id: 'n1',
  user_external_id: 'uid-1',
  ib_email: 'x@y.com',
  ib_username: 'millonariosteam2018',
  deal_type: 'pnl',
  terms: null,
  pct: null,
  target_amount: null,
  status: 'active',
  starts_on: null,
  ends_on: null,
  notes: null,
  created_by_name: null,
  created_at: '2026-08-27T00:00:00Z',
  updated_at: '2026-08-27T00:00:00Z',
  ...p,
});

const perfil = (p: Partial<IbProfile> = {}): IbProfile => ({
  user_external_id: 'uid-1',
  username: 'millonariosteam2018',
  email: 'millonariosteam2018@gmail.com',
  first_name: null,
  last_name: null,
  phone_raw: null,
  phone_country_code: null,
  country: 'Mexico',
  country_iso: 'MX',
  status: 'ACTIVE',
  kyc_status: null,
  user_type: null,
  rank: null,
  register_date: null,
  sponsor_username: 'ana.garcia',
  sponsor_email: null,
  ib_program_name: null,
  ...p,
});

const pkg = (p: Partial<IbNegotiationPackage> = {}): IbNegotiationPackage => ({
  negotiation: neg(),
  profile: perfil(),
  production: emptyIbNumbers(),
  network: null,
  ...p,
});

describe('isDealType — la aduana de los dos tipos que nombró Kevin', () => {
  it('acepta exactamente pnl y net_deposit', () => {
    for (const d of IB_DEAL_TYPES) expect(isDealType(d)).toBe(true);
  });

  it('rechaza cualquier otra cosa, incluida la que se parece', () => {
    expect(isDealType('netdeposit')).toBe(false);
    expect(isDealType('PNL')).toBe(false);
    expect(isDealType(null)).toBe(false);
    expect(isDealType(undefined)).toBe(false);
    expect(isDealType(1)).toBe(false);
  });
});

describe('emptyIbNumbers — sin dato no es cero', () => {
  it('el desglose arranca en null, no en cero', () => {
    // Esto es lo que impide que un mes sin espejo de símbolos (todos los
    // anteriores al 2026-08-13, porque el bróker purga la fuente a los quince
    // días) se dibuje como "no operó sintéticos".
    const n = emptyIbNumbers();
    expect(n.forexLots).toBeNull();
    expect(n.forexCommission).toBeNull();
    expect(n.syntheticLots).toBeNull();
    expect(n.syntheticCommission).toBeNull();
  });

  it('lo que sí se sabe cuando no hubo actividad arranca en cero', () => {
    const n = emptyIbNumbers();
    expect(n.lots).toBe(0);
    expect(n.commission).toBe(0);
    expect(n.pnl).toBe(0);
    expect(n.rewards).toBe(0);
    expect(n.activeDays).toBe(0);
  });

  it('cada llamada devuelve un objeto nuevo (no se comparte el acumulador)', () => {
    const a = emptyIbNumbers();
    a.lots = 5;
    expect(emptyIbNumbers().lots).toBe(0);
  });
});

describe('toNumber — los numeric de Postgres llegan como string', () => {
  it('convierte el string que manda PostgREST', () => {
    expect(toNumber('124975.11')).toBeCloseTo(124975.11);
    expect(toNumber('-15899.33')).toBeCloseTo(-15899.33);
  });

  it('null, undefined y basura valen cero y no NaN', () => {
    // Un NaN suelto se propaga a todos los totales de la pantalla sin errar.
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber('nada')).toBe(0);
  });
});

describe('ibDisplayName — el nombre nunca queda vacío', () => {
  it('usa el nombre completo del CRM cuando está', () => {
    expect(ibDisplayName(pkg({ profile: perfil({ first_name: 'Hugo', last_name: 'Ortiz' }) })))
      .toBe('Hugo Ortiz');
  });

  it('cae al username del CRM cuando no hay nombre', () => {
    expect(ibDisplayName(pkg())).toBe('millonariosteam2018');
  });

  it('cae al username CONGELADO cuando el IB salió del espejo del CRM', () => {
    // El perfil viene null porque el cron borró la fila; la negociación sigue
    // existiendo (por eso no hay FK) y tiene que seguir diciendo con quién se
    // firmó.
    expect(ibDisplayName(pkg({ profile: null }))).toBe('millonariosteam2018');
  });

  it('último recurso: el id de Orion, nunca una fila sin etiqueta', () => {
    expect(ibDisplayName(pkg({ profile: null, negotiation: neg({ ib_username: null }) })))
      .toBe('uid-1');
  });
});
