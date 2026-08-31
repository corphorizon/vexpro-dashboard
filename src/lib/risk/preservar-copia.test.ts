import { describe, it, expect } from 'vitest';
import { RIESGO_ALTO, RIESGO_MEDIO, type AccountSignal } from '@/lib/risk/account-review';

// ─────────────────────────────────────────────────────────────────────────────
// El veredicto de copia sobrevive a un recálculo.
//
// ── EL BUG QUE ESTO FIJA ───────────────────────────────────────────────────
// `copy_trading` NO se calcula en el paso normal: necesita las aperturas de
// TODAS las cuentas del período, y eso lo hace una segunda pasada
// (`syncAccountCopyDetection`). El paso normal la deja en `unverifiable`.
//
// Cuando se agregó el botón «analizar ahora» —que recalcula UNA cuenta— eso
// pasó a pisar el veredicto real con un «no comprobado» en cada clic. Medido el
// 2026-08-31: 785 cuentas tenían veredicto y 34 estaban marcadas como
// sincronizadas, una con 0,5 s de retraso contra otra cuenta. Todo eso se
// habría borrado sin que nada avisara.
//
// Y no alcanza con restaurar la señal: `flagged` y `risk` se calculan sobre
// las señales, así que hay que rehacerlos. Restaurar sólo la señal dejaría una
// cuenta que dice «sincronizada» con el contador en cero.
// ─────────────────────────────────────────────────────────────────────────────

const señal = (over: Partial<AccountSignal> = {}): AccountSignal => ({
  id: 'copy_trading',
  label: 'Opera sincronizada con otras cuentas',
  status: 'unverifiable',
  detail: '',
  offendingTrades: 0,
  countsForRisk: true,
  ...over,
});

/** La misma fusión que hace `evaluarYGuardar`. */
function fusionar(nuevas: AccountSignal[], previa: AccountSignal | undefined) {
  const senales = nuevas.map((s) =>
    s.id === 'copy_trading' && s.status === 'unverifiable' && previa ? previa : s,
  );
  const flagged = senales.filter((s) => s.status === 'fail' && s.countsForRisk).length;
  const risk = flagged >= RIESGO_ALTO ? 'alto' : flagged >= RIESGO_MEDIO ? 'medio' : 'ok';
  return { senales, flagged, risk };
}

describe('preservar el veredicto de copia al recalcular', () => {
  it('conserva el «sincronizada» que el recálculo no puede reproducir', () => {
    const previa = señal({ status: 'fail', detail: 'Sincronizada con 64 cuenta(s)', offendingTrades: 120 });
    const r = fusionar([señal()], previa);
    expect(r.senales[0].status).toBe('fail');
    expect(r.senales[0].detail).toContain('64');
  });

  it('recalcula el conteo y el riesgo con la señal restaurada', () => {
    // Restaurar la señal sin rehacer los números dejaría una cuenta que dice
    // «sincronizada» con el contador en cero: el número plausible y equivocado.
    const previa = señal({ status: 'fail' });
    const r = fusionar([señal()], previa);
    expect(r.flagged).toBe(RIESGO_MEDIO);
    expect(r.risk).toBe('medio');
  });

  it('con otra señal en falla suma y llega a riesgo alto', () => {
    const otra = señal({ id: 'hft', label: 'HFT', status: 'fail' });
    const r = fusionar([otra, señal()], señal({ status: 'fail' }));
    expect(r.flagged).toBe(RIESGO_ALTO);
    expect(r.risk).toBe('alto');
  });

  it('NO restaura si no había veredicto previo', () => {
    const r = fusionar([señal()], undefined);
    expect(r.senales[0].status).toBe('unverifiable');
    expect(r.flagged).toBe(0);
  });

  it('NO pisa un veredicto NUEVO que sí se pudo calcular', () => {
    // Si el recálculo logró comprobarla, manda el nuevo: lo guardado es más
    // viejo por definición.
    const nueva = señal({ status: 'pass', detail: 'Ninguna cuenta sincronizada' });
    const r = fusionar([nueva], señal({ status: 'fail' }));
    expect(r.senales[0].status).toBe('pass');
  });

  it('no toca las demás señales', () => {
    const otra = señal({ id: 'news_window', label: 'Noticias', status: 'pass' });
    const r = fusionar([otra, señal()], señal({ status: 'fail' }));
    expect(r.senales[0]).toBe(otra);
  });
});
