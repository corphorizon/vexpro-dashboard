// ─────────────────────────────────────────────────────────────────────────────
// relativeAge — «hace 26 h» para los datos `stale` («Libro mayor», spec §2.1:
// cada número dice de cuándo es).
//
// Devuelve la CLAVE de i18n y el número, no el texto: así la decisión de
// unidad se testea sin el provider y el texto sale de i18n (`ui.ago.*`).
//
// Cortes: < 1 min «recién» · < 60 min en minutos · < 48 h en horas (un saldo
// de «hace 26 h» se lee mejor que «hace 1 d»: un día y dos horas no es lo
// mismo para conciliar) · después en días. Una fecha futura (reloj del
// servidor adelantado) cuenta como «recién», nunca «hace -3 min».
// Una fecha inválida devuelve null: el llamador no muestra antigüedad en vez
// de inventar una.
//
// DESCARTADO: Intl.RelativeTimeFormat — da «hace 26 horas» / «26 hours ago»
// (largo para un sub de KPI de 12 px) y no permite el corte de 48 h.
// ─────────────────────────────────────────────────────────────────────────────

export type AgeKey = 'ui.ago.now' | 'ui.ago.min' | 'ui.ago.h' | 'ui.ago.d';

export interface RelativeAge {
  key: AgeKey;
  n: number;
}

export function toEpochMs(at: Date | string | number | null | undefined): number | null {
  if (at === null || at === undefined || at === '') return null;
  const ms = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

export function relativeAge(at: Date | string | number | null | undefined, now: number): RelativeAge | null {
  const ms = toEpochMs(at);
  if (ms === null) return null;
  const mins = Math.floor((now - ms) / 60_000);
  if (mins < 1) return { key: 'ui.ago.now', n: 0 };
  if (mins < 60) return { key: 'ui.ago.min', n: mins };
  const hours = Math.floor(mins / 60);
  if (hours < 48) return { key: 'ui.ago.h', n: hours };
  return { key: 'ui.ago.d', n: Math.floor(hours / 24) };
}
