import type { Services } from '../context.ts';

/**
 * Place search through OpenStreetMap's Nominatim (free, no key). Its usage policy asks for at
 * most one request per second and an identifying User-Agent, so calls are spaced out here.
 */
export class PlacesError extends Error {}

let last = 0;
async function politeGap() {
  const wait = last + 1100 - Date.now();
  last = Math.max(Date.now(), last + 1100);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export interface Place { name: string; type: string; address: string; lat: number; lon: number; map_url: string; osm_url: string }

export async function findPlaces(services: Services, q: { query: string; near?: string; lat?: number; lon?: number; limit?: number }): Promise<Place[]> {
  const f = services.netFetch ?? fetch;
  const params = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', limit: String(Math.min(q.limit ?? 6, 10)) });
  params.set('q', q.near && q.lat == null ? `${q.query}, ${q.near}` : q.query);
  if (q.lat != null && q.lon != null) {
    // Search a box of roughly 10 km around the user, preferring results inside it.
    const d = 0.09;
    params.set('viewbox', `${q.lon - d},${q.lat + d},${q.lon + d},${q.lat - d}`);
    params.set('bounded', '1');
  }
  await politeGap();
  let res: Response;
  try {
    res = await f(`${services.config.NOMINATIM_URL.replace(/\/$/, '')}/search?${params}`, {
      headers: { 'user-agent': `Carino personal assistant (${services.config.PUBLIC_URL})`, accept: 'application/json', 'accept-language': 'en' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new PlacesError('Place search is unreachable right now (OpenStreetMap). Try again shortly.');
  }
  if (res.status === 429) throw new PlacesError('Place search is busy (OpenStreetMap rate limit). Try again in a minute.');
  if (!res.ok) throw new PlacesError(`Place search returned an error (${res.status}).`);
  const rows = (await res.json()) as any[];
  return rows.map((r) => {
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    return {
      name: r.name || String(r.display_name ?? '').split(',')[0],
      type: [r.category, r.type].filter(Boolean).join('/'),
      address: String(r.display_name ?? ''),
      lat, lon,
      map_url: `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`,
      osm_url: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`,
    };
  });
}
