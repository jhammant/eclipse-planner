/**
 * Eclipse geometry, wrapping astronomy-engine.
 *
 * Everything here runs client-side — there is no server component to this tool.
 */

import * as Astronomy from 'astronomy-engine';

/** Search window start. The eclipse itself is 2026-08-12. */
export const SEARCH_FROM = new Date('2026-08-01T00:00:00Z');

const AU_KM = 149597870.7;
const SUN_RADIUS_KM = 695700;
const MOON_RADIUS_KM = 1737.4;

export interface BodyView {
  /** Compass bearing, degrees clockwise from north. */
  azimuth: number;
  /** Degrees above the horizon, corrected for atmospheric refraction. */
  altitude: number;
  /** Apparent angular radius of the disc, in degrees. */
  angularRadius: number;
}

export interface Frame {
  time: Date;
  sun: BodyView;
  moon: BodyView;
  /** Angular distance between the two disc centres, degrees. */
  separation: number;
  /** Fraction of the Sun's *area* hidden, 0–1. */
  obscuration: number;
}

export interface Circumstances {
  kind: string;
  /** Peak obscuration as a fraction of the Sun's area, 0–1. */
  peakObscuration: number;
  partialBegin: Frame | null;
  peak: Frame;
  partialEnd: Frame | null;
}

export function observerAt(lat: number, lng: number, elevation: number): Astronomy.Observer {
  return new Astronomy.Observer(lat, lng, elevation);
}

/** Angular separation between two equatorial positions, in degrees. */
function separationDeg(a: Astronomy.EquatorialCoordinates, b: Astronomy.EquatorialCoordinates): number {
  const toRad = Math.PI / 180;
  const ra1 = a.ra * 15 * toRad;
  const ra2 = b.ra * 15 * toRad;
  const dec1 = a.dec * toRad;
  const dec2 = b.dec * toRad;
  const cos = Math.sin(dec1) * Math.sin(dec2) + Math.cos(dec1) * Math.cos(dec2) * Math.cos(ra1 - ra2);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

/**
 * Fraction of disc 1's area covered by disc 2, given both radii and their
 * centre separation (circle–circle lens area).
 */
function overlapFraction(r1: number, r2: number, d: number): number {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return Math.min(1, (r2 * r2) / (r1 * r1));

  const a1 = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
  const a2 = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
  const a3 = 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
  return (a1 + a2 - a3) / (Math.PI * r1 * r1);
}

/** Full sun/moon geometry as seen from `observer` at `time`. */
export function frameAt(time: Date, observer: Astronomy.Observer): Frame {
  const sunEq = Astronomy.Equator(Astronomy.Body.Sun, time, observer, true, true);
  const moonEq = Astronomy.Equator(Astronomy.Body.Moon, time, observer, true, true);

  const sunHor = Astronomy.Horizon(time, observer, sunEq.ra, sunEq.dec, 'normal');
  const moonHor = Astronomy.Horizon(time, observer, moonEq.ra, moonEq.dec, 'normal');

  const sunRadius = (Math.asin(SUN_RADIUS_KM / (sunEq.dist * AU_KM)) * 180) / Math.PI;
  const moonRadius = (Math.asin(MOON_RADIUS_KM / (moonEq.dist * AU_KM)) * 180) / Math.PI;

  const separation = separationDeg(sunEq, moonEq);

  return {
    time,
    sun: { azimuth: sunHor.azimuth, altitude: sunHor.altitude, angularRadius: sunRadius },
    moon: { azimuth: moonHor.azimuth, altitude: moonHor.altitude, angularRadius: moonRadius },
    separation,
    obscuration: overlapFraction(sunRadius, moonRadius, separation),
  };
}

/** Contact times and peak obscuration for a location. */
export function circumstances(observer: Astronomy.Observer): Circumstances | null {
  const ev = Astronomy.SearchLocalSolarEclipse(SEARCH_FROM, observer);
  if (!ev) return null;

  const frame = (e: Astronomy.EclipseEvent | undefined): Frame | null =>
    e ? frameAt(e.time.date, observer) : null;

  const peak = frameAt(ev.peak.time.date, observer);

  return {
    kind: String(ev.kind),
    // Recompute rather than trusting `ev.obscuration`, which the library leaves
    // undefined for partial eclipses.
    peakObscuration: peak.obscuration,
    partialBegin: frame(ev.partial_begin),
    peak,
    partialEnd: frame(ev.partial_end),
  };
}

/** Evenly-spaced frames across the whole eclipse, for the time scrubber. */
export function timeline(c: Circumstances, observer: Astronomy.Observer, steps = 120): Frame[] {
  const start = (c.partialBegin ?? c.peak).time.getTime();
  const end = (c.partialEnd ?? c.peak).time.getTime();
  const frames: Frame[] = [];
  for (let i = 0; i <= steps; i++) {
    frames.push(frameAt(new Date(start + ((end - start) * i) / steps), observer));
  }
  return frames;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compassPoint(azimuth: number): string {
  return COMPASS[Math.round(azimuth / 22.5) % 16];
}

export function formatTime(d: Date): string {
  return d.toLocaleTimeString('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
  });
}
