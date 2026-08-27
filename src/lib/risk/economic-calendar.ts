// ─────────────────────────────────────────────────────────────────────────────
// Calendario económico de MetaQuotes.
//
// ── POR QUÉ ESTA FUENTE ────────────────────────────────────────────────────
// Es EL MISMO calendario que el trader ve dentro de su terminal MetaTrader 5.
// Si se le va a rechazar un retiro por haber operado durante una noticia, la
// noticia tiene que ser la que él tenía delante — no la de otro proveedor que
// puede marcar otro horario u otra importancia. Con cualquier otra fuente, la
// discusión con el cliente se vuelve "mi calendario decía otra cosa", y tiene
// razón.
//
// ── CÓMO SE LLEGÓ ACÁ ──────────────────────────────────────────────────────
// La documentación de MetaQuotes no publica una API de calendario: ofrece un
// widget para webs y, para robots, decía "próximamente". Pero la página del
// calendario de mql5.com se alimenta de un endpoint que devuelve JSON limpio,
// acepta rango de fechas y NO pide sesión (verificado con curl sin cookies:
// HTTP 200, 80 KB).
//
// El rango de fechas es lo que lo hace utilizable: las revisiones de retiro
// nunca son del mismo día, así que un calendario que sólo muestre la semana en
// curso no sirve para nada.
//
// ── LA ÚNICA TRAMPA ────────────────────────────────────────────────────────
// MetaQuotes responde 404 —no 403— a los clientes que parecen automatizados.
// Sin un User-Agent de navegador, TODO su dominio "no existe". Se descubrió
// porque hasta la raíz de mql5.com daba 404. Un 404 se lee como "esa página no
// está", no como "me estás bloqueando", y eso cuesta media hora.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';

const ENDPOINT = 'https://www.mql5.com/en/economic-calendar/content';

/**
 * Sin esto MetaQuotes devuelve 404 en todo su dominio. Ver la cabecera: el
 * modo de fallo miente sobre su causa.
 */
const NAVEGADOR =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** Máscaras del endpoint: todas las importancias y todas las monedas. */
const TODAS_LAS_IMPORTANCIAS = 15;
const TODAS_LAS_MONEDAS = 127;

/**
 * Ventana de la regla, en minutos. El reglamento de Vex2Pro dice "no operar 5
 * minutos antes ni después de noticias de alto impacto".
 */
export const VENTANA_NOTICIA_MIN = 5;

export interface CalendarEvent {
  event_id: number;
  event_name: string;
  importance: string;
  currency_code: string | null;
  country: number | null;
  released_at: string;
  forecast_value: string | null;
  previous_value: string | null;
  actual_value: string | null;
  url: string | null;
}

interface RespuestaMql5 {
  Id: unknown;
  EventName: unknown;
  Importance: unknown;
  CurrencyCode: unknown;
  Country: unknown;
  ReleaseDate: unknown;
  ForecastValue: unknown;
  PreviousValue: unknown;
  ActualValue: unknown;
  Url: unknown;
}

const txt = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/**
 * Trae los eventos de un rango.
 *
 * `ReleaseDate` viene en epoch de milisegundos y `FullDate` sin zona horaria.
 * Se usa el epoch: una fecha sin zona hay que interpretarla, y una
 * interpretación equivocada corre la ventana de cinco minutos justo donde
 * importa.
 */
export async function fetchCalendar(desde: Date, hasta: Date): Promise<CalendarEvent[]> {
  const iso = (d: Date) => d.toISOString().slice(0, 19);
  const body = new URLSearchParams({
    date_mode: '1',
    from: iso(desde),
    to: iso(hasta),
    importance: String(TODAS_LAS_IMPORTANCIAS),
    currencies: String(TODAS_LAS_MONEDAS),
  });

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': NAVEGADOR,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    // El 404 de MetaQuotes NO significa que la página no exista: significa que
    // el cliente les pareció automatizado. Se dice, porque el mensaje por
    // defecto manda a buscar el error donde no está.
    throw new Error(
      res.status === 404
        ? 'MetaQuotes devolvió 404: casi seguro está bloqueando el cliente. Revisar el User-Agent, no la URL.'
        : `Calendario económico: HTTP ${res.status}`,
    );
  }

  const datos = (await res.json()) as RespuestaMql5[];
  const out: CalendarEvent[] = [];
  for (const e of datos) {
    const id = Number(e.Id);
    const ms = Number(e.ReleaseDate);
    if (!Number.isFinite(id) || !Number.isFinite(ms)) continue;
    out.push({
      event_id: id,
      event_name: String(e.EventName ?? '').trim() || '(sin nombre)',
      importance: String(e.Importance ?? 'none').toLowerCase(),
      currency_code: txt(e.CurrencyCode),
      country: Number.isFinite(Number(e.Country)) ? Number(e.Country) : null,
      released_at: new Date(ms).toISOString(),
      forecast_value: txt(e.ForecastValue),
      previous_value: txt(e.PreviousValue),
      actual_value: txt(e.ActualValue),
      url: txt(e.Url),
    });
  }
  return out;
}

export interface CalendarSyncResult {
  fetched: number;
  upserted: number;
  high: number;
  from: string;
  to: string;
  warnings: string[];
}

/**
 * Espeja un rango del calendario.
 *
 * El upsert va por `event_id`, que es la clave de MetaQuotes: reimportar el
 * mismo rango actualiza en vez de duplicar. Importa porque un evento cambia
 * después de publicarse — `ActualValue` se rellena cuando sale el dato.
 */
export async function syncCalendar(
  admin: SupabaseClient,
  desde: Date,
  hasta: Date,
): Promise<CalendarSyncResult> {
  const warnings: string[] = [];
  const eventos = await fetchCalendar(desde, hasta);

  if (eventos.length === 0) {
    // Cero eventos en un rango de días no es normal: el calendario tiene
    // cientos por semana. Se avisa en vez de guardar un vacío que después se
    // lee como "no hubo noticias".
    warnings.push(
      'El calendario devolvió CERO eventos para el rango pedido. Eso no es normal: ' +
      'revisar si MetaQuotes cambió el endpoint antes de dar por bueno que no hubo noticias.',
    );
  }

  const ahora = new Date().toISOString();
  let upserted = 0;
  for (let i = 0; i < eventos.length; i += 500) {
    const lote = eventos.slice(i, i + 500).map((e) => ({ ...e, synced_at: ahora }));
    const { error } = await admin
      .from('economic_calendar_events')
      .upsert(lote, { onConflict: 'event_id' });
    if (error) throw new Error(`economic_calendar_events: ${error.message}`);
    upserted += lote.length;
  }

  return {
    fetched: eventos.length,
    upserted,
    high: eventos.filter((e) => e.importance === 'high').length,
    from: desde.toISOString(),
    to: hasta.toISOString(),
    warnings,
  };
}

/**
 * Eventos de ALTO impacto en un rango, del espejo.
 *
 * Sólo `high`: el reglamento habla de noticias de alto impacto, y contar las
 * medias convertiría media jornada en zona prohibida.
 */
export async function loadHighImpact(
  admin: SupabaseClient,
  desde: Date,
  hasta: Date,
): Promise<Array<{ at: number; name: string; currency: string | null }>> {
  const { data, error } = await admin
    .from('economic_calendar_events')
    .select('event_name, currency_code, released_at')
    .eq('importance', 'high')
    .gte('released_at', desde.toISOString())
    .lte('released_at', hasta.toISOString())
    .order('released_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((e) => ({
    at: new Date(String(e.released_at)).getTime(),
    name: String(e.event_name),
    currency: e.currency_code ? String(e.currency_code) : null,
  }));
}
