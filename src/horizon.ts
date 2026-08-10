/**
 * Local horizon profile: how high does the land rise, in every direction?
 *
 * This is the part that generic eclipse sites don't do, and it matters enormously
 * for August 2026 in the UK because the Sun is only 2–19° above the horizon
 * throughout. A hill or a terrace of houses that would be irrelevant for a midday
 * eclipse can hide this one completely.
 */

import { preloadTiles, sampleElevation, settleTiles } from './dem';

const EARTH_RADIUS = 6371000;
/**
 * Standard refraction coefficient (k = 0.13) makes light bend slightly with the
 * Earth's curve, so distant terrain appears a little higher than pure geometry
 * predicts. Surveyors use the same 1/(1-k) ≈ 1.13 effective-radius fudge.
 */
const REFRACTED_RADIUS = EARTH_RADIUS / (1 - 0.13);

export interface HorizonSample {
  azimuth: number;
  /** Angular elevation of the skyline in this direction, degrees. */
  altitude: number;
  /** Distance to whatever is responsible for that skyline, metres. */
  distance: number;
  /** Elevation of that obstruction, metres above datum. */
  elevation: number;
  /**
   * What forms the skyline here. 'assumed' is a user-supplied near-field screen
   * (trees, the houses opposite) rather than something measured from data.
   */
  source: 'terrain' | 'building' | 'assumed';
}

export interface HorizonProfile {
  lat: number;
  lng: number;
  /** Ground elevation at the observer, metres. */
  groundElevation: number;
  eyeHeight: number;
  samples: HorizonSample[];
}

/** Great-circle destination point from a start point, bearing and distance. */
export function destination(lat: number, lng: number, bearingDeg: number, distanceM: number) {
  const d = distanceM / EARTH_RADIUS;
  const br = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;

  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lng2 = lng1 + Math.atan2(
    Math.sin(br) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
  );
  return { lat: (lat2 * 180) / Math.PI, lng: (lng2 * 180) / Math.PI };
}

/** Geometrically-spaced ray distances: dense close in, sparse far out. */
function rayDistances(min = 25, max = 25000, steps = 64): number[] {
  const ratio = (max / min) ** (1 / (steps - 1));
  return Array.from({ length: steps }, (_, i) => min * ratio ** i);
}

export interface HorizonOptions {
  /** Azimuth range to profile. Defaults to the full circle. */
  fromAzimuth?: number;
  toAzimuth?: number;
  azimuthStep?: number;
  eyeHeight?: number;
  maxDistance?: number;
  /** Fewer steps = faster, coarser. Used by the bulk "best spot" scan. */
  distanceSteps?: number;
}

export async function computeHorizon(
  lat: number,
  lng: number,
  opts: HorizonOptions = {},
): Promise<HorizonProfile> {
  const {
    fromAzimuth = 0,
    toAzimuth = 360,
    azimuthStep = 0.5,
    eyeHeight = 1.6,
    maxDistance = 25000,
    distanceSteps = 64,
  } = opts;

  const azimuths: number[] = [];
  for (let a = fromAzimuth; a <= toAzimuth; a += azimuthStep) azimuths.push(a);
  const distances = rayDistances(25, maxDistance, distanceSteps);

  // Build every sample point up front so the tiles can be fetched in one pass.
  const rays = azimuths.map((az) =>
    distances.map((d) => ({ az, d, ...destination(lat, lng, az, d) })),
  );

  const allPoints = [{ lat, lng }, ...rays.flat()];
  await preloadTiles(allPoints);
  await settleTiles();

  const groundElevation = sampleElevation(lng, lat);
  const eye = groundElevation + eyeHeight;

  const samples: HorizonSample[] = rays.map((ray, i) => {
    let best: HorizonSample = {
      azimuth: azimuths[i],
      altitude: -90,
      distance: 0,
      elevation: groundElevation,
      source: 'terrain',
    };
    for (const p of ray) {
      const elevation = sampleElevation(p.lng, p.lat);
      // Distant ground curves away below the tangent plane; subtract that drop.
      const drop = (p.d * p.d) / (2 * REFRACTED_RADIUS);
      const altitude = (Math.atan2(elevation - eye - drop, p.d) * 180) / Math.PI;
      if (altitude > best.altitude) {
        best = { azimuth: azimuths[i], altitude, distance: p.d, elevation, source: 'terrain' };
      }
    }
    return best;
  });

  return { lat, lng, groundElevation, eyeHeight, samples };
}

/** Skyline altitude at an arbitrary azimuth, linearly interpolated. */
export function horizonAt(profile: HorizonProfile, azimuth: number): number {
  const { samples } = profile;
  if (!samples.length) return 0;

  const az = ((azimuth % 360) + 360) % 360;
  let lo = samples[0];
  let hi = samples[samples.length - 1];
  for (let i = 0; i < samples.length - 1; i++) {
    if (samples[i].azimuth <= az && samples[i + 1].azimuth >= az) {
      lo = samples[i];
      hi = samples[i + 1];
      break;
    }
  }
  const span = hi.azimuth - lo.azimuth;
  if (span <= 0) return lo.altitude;
  const t = (az - lo.azimuth) / span;
  return lo.altitude + (hi.altitude - lo.altitude) * t;
}

/** How far above the local skyline the Sun sits, in degrees. Negative = hidden. */
export function clearance(profile: HorizonProfile, azimuth: number, altitude: number): number {
  return altitude - horizonAt(profile, azimuth);
}

/**
 * Raise the terrain skyline wherever a building stands higher in that direction.
 * Mutates nothing — returns a new profile.
 */
export function withBuildings(
  profile: HorizonProfile,
  bins: Map<number, { azimuth: number; altitude: number; distance: number }>,
): HorizonProfile {
  if (!bins.size) return profile;

  const samples = profile.samples.map((s) => {
    const b = bins.get(Math.round(s.azimuth * 2) / 2);
    if (b && b.altitude > s.altitude) {
      return {
        azimuth: s.azimuth,
        altitude: b.altitude,
        distance: b.distance,
        elevation: profile.groundElevation + profile.eyeHeight,
        source: 'building' as const,
      };
    }
    return s;
  });

  return { ...profile, samples };
}

/** What forms the skyline at a given azimuth — terrain or a building. */
export function obstructionAt(profile: HorizonProfile, azimuth: number): HorizonSample | null {
  const az = ((azimuth % 360) + 360) % 360;
  let best: HorizonSample | null = null;
  let bestDelta = Infinity;
  for (const s of profile.samples) {
    const d = Math.abs(s.azimuth - az);
    if (d < bestDelta) { bestDelta = d; best = s; }
  }
  return best;
}

/**
 * Apply a near-field screen the user describes — a tree line, the houses across
 * the road — as a floor under the whole skyline.
 *
 * Trees are absent from every open dataset, and at 2-19° Sun altitude they are
 * usually the thing that actually decides it, so letting people state what is in
 * front of them is more honest than silently assuming open ground.
 *
 * `height` is measured from the ground, `distance` horizontally from the observer.
 */
export function withNearField(
  profile: HorizonProfile,
  height: number,
  distance: number,
): HorizonProfile {
  if (height <= 0 || distance <= 0) return profile;

  const rise = height - profile.eyeHeight;
  const altitude = (Math.atan2(rise, distance) * 180) / Math.PI;

  const samples = profile.samples.map((s) =>
    altitude > s.altitude
      ? {
          azimuth: s.azimuth,
          altitude,
          distance,
          elevation: profile.groundElevation + height,
          source: 'assumed' as const,
        }
      : s,
  );

  return { ...profile, samples };
}

/** Angular elevation of a near-field screen, for labelling the sky view. */
export function nearFieldAltitude(
  profile: HorizonProfile,
  height: number,
  distance: number,
): number {
  if (height <= 0 || distance <= 0) return -90;
  return (Math.atan2(height - profile.eyeHeight, distance) * 180) / Math.PI;
}
