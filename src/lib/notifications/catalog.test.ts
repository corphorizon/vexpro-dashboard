import { describe, it, expect } from 'vitest';
import {
  NOTIFICATION_TYPES,
  NOTIFICATION_KEYS,
  notificationType,
  sortNotifications,
  unreadCount,
  type AppNotification,
} from './catalog';
import { translations } from '@/lib/i18n';

let seq = 0;
function notif(partial: Partial<AppNotification>): AppNotification {
  seq += 1;
  return {
    id: `n${seq}`,
    company_id: 'c1',
    type: 'order.pending',
    severity: 'normal',
    params: {},
    link: null,
    read_at: null,
    created_at: `2026-08-0${seq}T10:00:00Z`,
    ...partial,
  };
}

describe('catálogo', () => {
  it('no tiene claves repetidas', () => {
    expect(new Set(NOTIFICATION_KEYS).size).toBe(NOTIFICATION_KEYS.length);
  });

  it('resuelve un tipo conocido y devuelve null para uno inventado', () => {
    expect(notificationType('order.pending')?.severity).toBe('high');
    expect(notificationType('no.existe')).toBeNull();
  });

  // El emisor no puede avisarle a nadie de un módulo que no existe: sería una
  // notificación que jamás se entrega y nadie notaría.
  it('cada tipo con módulo apunta a un módulo real', async () => {
    const { MODULES } = await import('@/lib/modules');
    const known = new Set(MODULES.map((m) => m.key));
    for (const def of NOTIFICATION_TYPES) {
      if (def.module) expect(known, `${def.key} → ${def.module}`).toContain(def.module);
    }
  });

  // El texto vive en i18n, no en la base. Un tipo sin sus dos claves saldría
  // en pantalla como la clave cruda.
  it('cada tipo tiene título y cuerpo en los DOS idiomas', () => {
    for (const def of NOTIFICATION_TYPES) {
      for (const locale of ['es', 'en'] as const) {
        expect(translations[locale][`${def.i18nKey}.title`], `${def.key} ${locale} title`).toBeTruthy();
        expect(translations[locale][`${def.i18nKey}.body`], `${def.key} ${locale} body`).toBeTruthy();
      }
    }
  });

  // Si el español interpola {amount} y el inglés no, el dato se pierde en un
  // idioma sin que nada falle.
  it('el título y el cuerpo usan los mismos params en ambos idiomas', () => {
    const paramsOf = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort().join(',');
    for (const def of NOTIFICATION_TYPES) {
      expect(paramsOf(translations.es[`${def.i18nKey}.body`]), `${def.key} body`)
        .toBe(paramsOf(translations.en[`${def.i18nKey}.body`]));
    }
  });

  it('solo los avisos que no pueden esperar mandan email', () => {
    for (const def of NOTIFICATION_TYPES) {
      if (def.email) expect(def.severity, `${def.key}`).not.toBe('normal');
    }
  });
});

describe('sortNotifications', () => {
  it('pone las no leídas primero', () => {
    const rows = sortNotifications([
      notif({ id: 'leida', read_at: '2026-08-09T10:00:00Z', severity: 'critical' }),
      notif({ id: 'nueva', read_at: null, severity: 'normal' }),
    ]);
    expect(rows[0].id).toBe('nueva');
  });

  it('dentro de las no leídas ordena por severidad', () => {
    const rows = sortNotifications([
      notif({ id: 'normal', severity: 'normal' }),
      notif({ id: 'critica', severity: 'critical' }),
      notif({ id: 'alta', severity: 'high' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['critica', 'alta', 'normal']);
  });

  it('a igual severidad, lo más reciente arriba', () => {
    const rows = sortNotifications([
      notif({ id: 'vieja', severity: 'high', created_at: '2026-08-01T10:00:00Z' }),
      notif({ id: 'nueva', severity: 'high', created_at: '2026-08-09T10:00:00Z' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['nueva', 'vieja']);
  });

  it('no muta el arreglo original', () => {
    const original = [notif({ id: 'a', severity: 'normal' }), notif({ id: 'b', severity: 'critical' })];
    const copy = [...original];
    sortNotifications(original);
    expect(original).toEqual(copy);
  });
});

describe('unreadCount', () => {
  it('cuenta solo las que no tienen fecha de lectura', () => {
    expect(unreadCount([
      notif({ read_at: null }),
      notif({ read_at: '2026-08-09T10:00:00Z' }),
      notif({ read_at: null }),
    ])).toBe(2);
  });
});
