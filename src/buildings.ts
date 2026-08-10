/**
 * Building obstructions from OpenStreetMap.
 *
 * The 30 m DEM is bare terrain, which is fine in open country and badly wrong in a
 * town. With the Sun between 2° and 19° up, a single terrace across the street can
 * hide the whole eclipse: at 10.5° altitude anything 20 m tall blocks the Sun
 * unless it is ~108 m away, and by last contact (2.7°) that distance grows to
 * ~420 m. So near-field buildings matter more than the landscape does.
 *
 * Footprints come from the Overpass API, are extruded to their tagged height, and
 * are merged into the horizon profile.
 */

import { preloadTiles, sampleElevation, settleTiles } from './dem';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/**
 * Beyond this, only genuinely tall towers could still matter (at 2.7° a building
 * 1.5 km away must exceed 70 m), and the query cost in a dense city climbs fast.
 */
export const BUILDING_RADIUS_M = 1500;

/** Typical storey height including floor structure. */
const METRES_PER_LEVEL = 3.2;
/** Used when a footprint has neither `height` nor `building:levels`. */
const DEFAULT_HEIGHT_M = 8;

const EARTH_RADIUS = 6371000;
const REFRACTED_RADIUS = EARTH_RADIUS / (1 - 0.13);

export interface BuildingRing {
  /** [lng, lat] pairs. */
  ring: Array<[number, number]>;
  /** Height above its own ground level, metres. */
  height: number;
}

/** Parse an OSM height tag: "25", "25 m", "25.5m" all mean 25-ish metres. */
function parseHeight(tags: Record<string, string> | undefined): number {
  if (!tags) return DEFAULT_HEIGHT_M;

  const raw = tags.height ?? tags['building:height'];
  if (raw) {
    const v = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(v) && v > 0) return v;
  }

  const levels = tags['building:levels'];
  if (levels) {
    const v = parseFloat(String(levels).replace(/[^0-9.]/g, ''));
    // + 1 m so a flat roof parapet isn't systematically under-counted.
    if (Number.isFinite(v) && v > 0) return v * METRES_PER_LEVEL + 1;
  }

  return DEFAULT_HEIGHT_M;
}

function overpassQuery(lat: number, lng: number, radius: number): string {
  return `[out:json][timeout:20];
(
  way["building"](around:${radius},${lat.toFixed(6)},${lng.toFixed(6)});
  relation["building"]["type"="multipolygon"](around:${radius},${lat.toFixed(6)},${lng.toFixed(6)});
);
out geom;`;
}

const cache = new Map<string, Promise<BuildingRing[] | null>>();

/**
 * Returns the footprints, `[]` when the area genuinely has none, or `null` when
 * the query failed. The caller must distinguish those: claiming "no buildings
 * here" after a failed request is how a city centre gets a falsely clear verdict.
 */
export async function fetchBuildings(
  lat: number,
  lng: number,
  radius = BUILDING_RADIUS_M,
): Promise<BuildingRing[] | null> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)},${radius}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const pending = (async () => {
    const body = overpassQuery(lat, lng, radius);

    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        const res = await fetch(endpoint, {
          method: 'POST',
          body,
          signal: controller.signal,
        });
        if (!res.ok) { clearTimeout(timer); continue; }

        const data = await res.json();
        clearTimeout(timer);
        const out: BuildingRing[] = [];

        for (const el of data.elements ?? []) {
          const height = parseHeight(el.tags);

          if (el.type === 'way' && Array.isArray(el.geometry)) {
            const ring = el.geometry
              .filter((p: { lat?: number; lon?: number }) => p && p.lat != null && p.lon != null)
              .map((p: { lat: number; lon: number }) => [p.lon, p.lat] as [number, number]);
            if (ring.length >= 3) out.push({ ring, height });
          } else if (el.type === 'relation' && Array.isArray(el.members)) {
            for (const m of el.members) {
              if (m.role !== 'outer' || !Array.isArray(m.geometry)) continue;
              const ring = m.geometry
                .filter((p: { lat?: number; lon?: number }) => p && p.lat != null && p.lon != null)
                .map((p: { lat: number; lon: number }) => [p.lon, p.lat] as [number, number]);
              if (ring.length >= 3) out.push({ ring, height });
            }
          }
        }
        return out;
      } catch {
        // Try the next mirror.
      }
    }
    // Every mirror failed. Drop the cache entry so a retry can actually re-query.
    cache.delete(key);
    return null;
  })();

  cache.set(key, pending);
  return pending;
}

/** Metres per degree of longitude/latitude near a given latitude. */
function metresPerDegree(lat: number) {
  const latRad = (lat * Math.PI) / 180;
  return {
    lng: 111320 * Math.cos(latRad),
    lat: 110540,
  };
}

export interface BuildingSample {
  azimuth: number;
  altitude: number;
  distance: number;
}

/** Compass bearing (0–360, clockwise from north) of a local east/north offset. */
function azimuthOf(east: number, north: number): number {
  const a = (Math.atan2(east, north) * 180) / Math.PI;
  return a < 0 ? a + 360 : a;
}

function normaliseAzimuth(a: number): number {
  return ((a % 360) + 360) % 360;
}

/**
 * Angular elevation of every building edge, sampled densely enough that a long
 * wall close by covers the azimuths it really occupies.
 *
 * Returns one entry per azimuth bin (of width `azimuthStep`), holding the highest
 * building silhouette in that direction.
 */
export function buildingSkyline(
  buildings: BuildingRing[],
  observer: { lat: number; lng: number; eyeElevation: number },
  azimuthStep = 0.5,
): Map<number, BuildingSample> {
  const bins = new Map<number, BuildingSample>();
  const mpd = metresPerDegree(observer.lat);

  for (const b of buildings) {
    // Ground under the building, so height is measured from the right datum.
    const mid = b.ring[Math.floor(b.ring.length / 2)];
    const groundElev = sampleElevation(mid[0], mid[1]);
    const topElev = groundElev + b.height;

    for (let i = 0; i < b.ring.length; i++) {
      const [lng1, lat1] = b.ring[i];
      const [lng2, lat2] = b.ring[(i + 1) % b.ring.length];

      // Local planar offsets are plenty accurate over <2 km.
      const dx1 = (lng1 - observer.lng) * mpd.lng;
      const dy1 = (lat1 - observer.lat) * mpd.lat;
      const dx2 = (lng2 - observer.lng) * mpd.lng;
      const dy2 = (lat2 - observer.lat) * mpd.lat;

      // Walk the azimuth range this edge spans and fill EVERY bin in it. Sampling
      // the edge at fixed spacing instead would leave gaps: a wall 76 m away with
      // 3 m sample spacing skips ~2.3° between samples while bins are 0.5° wide,
      // which renders as a picket fence of phantom gaps between buildings.
      const az1 = azimuthOf(dx1, dy1);
      const az2 = azimuthOf(dx2, dy2);

      let sweep = az2 - az1;
      if (sweep > 180) sweep -= 360;
      if (sweep < -180) sweep += 360;

      const steps = Math.max(1, Math.ceil(Math.abs(sweep) / azimuthStep));
      // A wall seen exactly end-on spans no azimuth and cannot occlude anything.
      if (Math.abs(sweep) < 1e-6) continue;

      const ex = dx2 - dx1;
      const ey = dy2 - dy1;

      for (let s = 0; s <= steps; s++) {
        const azimuth = normaliseAzimuth(az1 + (sweep * s) / steps);
        const ux = Math.sin((azimuth * Math.PI) / 180);
        const uy = Math.cos((azimuth * Math.PI) / 180);

        // Exact ray/segment intersection gives the true distance to the wall in
        // this direction, rather than the distance to the nearest sampled vertex.
        const det = ex * uy - ux * ey;
        if (Math.abs(det) < 1e-9) continue;
        const dist = (ex * dy1 - dx1 * ey) / det;
        const along = (ux * dy1 - uy * dx1) / det;
        if (dist <= 5 || along < -0.001 || along > 1.001) continue;

        const drop = (dist * dist) / (2 * REFRACTED_RADIUS);
        const altitude =
          (Math.atan2(topElev - observer.eyeElevation - drop, dist) * 180) / Math.PI;

        const bin = Math.round(azimuth / azimuthStep) * azimuthStep;
        const prev = bins.get(bin);
        if (!prev || altitude > prev.altitude) {
          bins.set(bin, { azimuth: bin, altitude, distance: dist });
        }
      }
    }
  }

  return bins;
}

/** Load the DEM tiles the building footprints sit on. */
export async function preloadBuildingTiles(buildings: BuildingRing[]): Promise<void> {
  const pts = buildings.map((b) => {
    const mid = b.ring[Math.floor(b.ring.length / 2)];
    return { lng: mid[0], lat: mid[1] };
  });
  if (!pts.length) return;
  await preloadTiles(pts);
  await settleTiles();
}

/**
 * The footprint containing a point, if any (even-odd ray casting; Overpass `out
 * geom` rings are closed and stored as [lng, lat]).
 *
 * Geocoding a house number or postcode returns the building's centroid, and an
 * indoor GPS fix does the same. The observer's own walls are then 6-14 m away and
 * would be modelled as a wrap-around obstruction tens of degrees high, producing a
 * confident and completely wrong "hidden" for the most common way people arrive.
 */
export function containingBuilding(
  lng: number,
  lat: number,
  buildings: BuildingRing[],
): BuildingRing | null {
  for (const b of buildings) {
    let inside = false;
    const r = b.ring;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    if (inside) return b;
  }
  return null;
}
