// Lo que estas pruebas protegen es UNA decisión: a quién se le suena la
// campanita cuando la cola termina de revisar un retiro de prop firm.
//
// No prueban que la revisión esté bien —eso es propfirm-auto.test.ts— sino que
// el filtro no se afloje con el tiempo. Los dos modos de romperlo son
// simétricos y los dos son malos:
//
//   · que se escape un retiro con problemas (o uno que no se pudo revisar) y
//     nadie se entere hasta que el pago ya salió;
//   · que empiece a avisar de los 'ok' y la campanita se vuelva ruido de
//     fondo, que es la forma elegante de que nadie lea NINGÚN aviso.

import { describe, it, expect } from 'vitest';
import { propfirmAlertFor } from './propfirm-queue';
import { notificationType } from '@/lib/notifications/catalog';

describe('propfirmAlertFor', () => {
  it('no avisa cuando el veredicto es limpio', () => {
    // Los 3 pendientes reales de hoy están todos acá. Si esto cambia, la
    // corrida de cada 30 minutos se convierte en 144 avisos diarios.
    expect(propfirmAlertFor({ outcome: 'ok' })).toBeNull();
  });

  it('avisa cuando el reglamento pide período nuevo', () => {
    expect(propfirmAlertFor({ outcome: 'denied_new_period' }))
      .toBe('propfirm.review_violations');
  });

  it('avisa cuando el rechazo es sin período nuevo', () => {
    expect(propfirmAlertFor({ outcome: 'denied_no_new_period' }))
      .toBe('propfirm.review_violations');
  });

  it('avisa cuando la revisión no pudo llegar a un veredicto', () => {
    // El caso que más lo necesita: sin aviso, `cannot_review` se ve en la cola
    // igual de tranquilo que un 'ok'.
    expect(propfirmAlertFor({ outcome: 'cannot_review' }))
      .toBe('propfirm.review_failed');
  });

  it('avisa cuando la revisión reventó', () => {
    expect(propfirmAlertFor({ outcome: null, error: 'MT5 no respondió' }))
      .toBe('propfirm.review_failed');
  });

  it('un error manda sobre cualquier veredicto que hubiera quedado colgado', () => {
    // Si algo reventó, el `outcome` que se alcanzó a calcular es de una
    // revisión que no terminó: tomarlo como veredicto sería tragarse el fallo.
    expect(propfirmAlertFor({ outcome: 'ok', error: 'se cortó a mitad' }))
      .toBe('propfirm.review_failed');
  });

  it('sin veredicto y sin error tampoco se lo da por bueno', () => {
    expect(propfirmAlertFor({ outcome: null })).toBe('propfirm.review_failed');
  });

  // Un tipo que no esté en el catálogo se descarta dentro de `notify()` con un
  // console.error y sin emitir nada: el aviso desaparecería en silencio.
  it('los dos tipos que emite existen en el catálogo', () => {
    for (const t of ['propfirm.review_violations', 'propfirm.review_failed']) {
      expect(notificationType(t), t).not.toBeNull();
    }
  });
});
