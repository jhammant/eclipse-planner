/**
 * Cloud forecast from Open-Meteo — free, no API key, CORS-enabled.
 *
 * Obscuration tells you what the sky will do; this tells you whether you'll be
 * allowed to watch it. For a UK eclipse it is usually the deciding factor.
 */

export interface CloudForecast {
  time: string;
  totalCloud: number;
  lowCloud: number;
  midCloud: number;
  highCloud: number;
  visibilityKm: number;
}

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

export async function fetchCloudForecast(
  lat: number,
  lng: number,
  date = '2026-08-12',
): Promise<CloudForecast[] | null> {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lng.toFixed(4),
    hourly: 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,visibility',
    start_date: date,
    end_date: date,
    timezone: 'Europe/London',
  });

  try {
    const res = await fetch(`${ENDPOINT}?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    const h = data.hourly;
    if (!h?.time) return null;

    return h.time.map((time: string, i: number) => ({
      time,
      totalCloud: h.cloud_cover[i],
      lowCloud: h.cloud_cover_low[i],
      midCloud: h.cloud_cover_mid[i],
      highCloud: h.cloud_cover_high[i],
      visibilityKm: (h.visibility?.[i] ?? 0) / 1000,
    }));
  } catch {
    return null;
  }
}

/**
 * Cloud cover for many points in one request. Open-Meteo accepts comma-separated
 * coordinate lists and returns an array, so scanning a grid of candidate spots
 * costs a single call rather than one per candidate.
 *
 * Returns mean total cloud over the eclipse window per point, `null` where
 * unavailable, in the same order as the input.
 */
export async function fetchCloudGrid(
  points: Array<{ lat: number; lng: number }>,
  date = '2026-08-12',
): Promise<Array<number | null>> {
  if (!points.length) return [];

  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat.toFixed(4)).join(','),
    longitude: points.map((p) => p.lng.toFixed(4)).join(','),
    hourly: 'cloud_cover',
    start_date: date,
    end_date: date,
    timezone: 'Europe/London',
  });

  try {
    const res = await fetch(`${ENDPOINT}?${params}`);
    if (!res.ok) return points.map(() => null);
    const data = await res.json();
    const list = Array.isArray(data) ? data : [data];

    return points.map((_, i) => {
      const h = list[i]?.hourly;
      if (!h?.time) return null;
      const vals: number[] = [];
      h.time.forEach((t: string, j: number) => {
        const hour = Number(t.slice(11, 13));
        if (hour >= 18 && hour <= 20) vals.push(h.cloud_cover[j]);
      });
      return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    });
  } catch {
    return points.map(() => null);
  }
}

/** The forecast rows covering the eclipse window (roughly 18:00–21:00 BST). */
export function eclipseWindow(forecast: CloudForecast[]): CloudForecast[] {
  return forecast.filter((f) => {
    const hour = Number(f.time.slice(11, 13));
    return hour >= 18 && hour <= 20;
  });
}

/** Mean total cloud across the eclipse window, or null if unavailable. */
export function meanCloud(forecast: CloudForecast[]): number | null {
  const win = eclipseWindow(forecast);
  if (!win.length) return null;
  return win.reduce((s, f) => s + f.totalCloud, 0) / win.length;
}
