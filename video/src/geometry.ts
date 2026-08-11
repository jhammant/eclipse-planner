/**
 * Real eclipse geometry for the launch video.
 *
 * The crescent in this film is not an artist's impression: it comes from the same
 * ephemerides the site uses, sampled from Alexandra Palace. If we are going to
 * claim the tool is accurate, the marketing had better not be drawn by hand.
 */

import * as Astronomy from 'astronomy-engine';

const AU_KM = 149597870.7;
const SUN_RADIUS_KM = 695700;
const MOON_RADIUS_KM = 1737.4;

const OBSERVER = new Astronomy.Observer(51.593, -0.13, 92);

/** Partial begin and end from Alexandra Palace, in UTC. */
export const FIRST_CONTACT = new Date('2026-08-12T17:17:00Z');
export const LAST_CONTACT = new Date('2026-08-12T19:06:00Z');

export interface Geometry {
  /** Degrees the Moon's centre sits right of the Sun's, as a true sky angle. */
  dx: number;
  /** Degrees the Moon's centre sits above the Sun's. */
  dy: number;
  sunRadius: number;
  moonRadius: number;
  /** Fraction of the Sun's area hidden, 0-1. */
  obscuration: number;
  sunAltitude: number;
  sunAzimuth: number;
}

function overlapFraction(r1: number, r2: number, d: number): number {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return Math.min(1, (r2 * r2) / (r1 * r1));
  const a1 = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
  const a2 = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
  const a3 = 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
  return (a1 + a2 - a3) / (Math.PI * r1 * r1);
}

export function geometryAt(time: Date): Geometry {
  const sunEq = Astronomy.Equator(Astronomy.Body.Sun, time, OBSERVER, true, true);
  const moonEq = Astronomy.Equator(Astronomy.Body.Moon, time, OBSERVER, true, true);
  const sunHor = Astronomy.Horizon(time, OBSERVER, sunEq.ra, sunEq.dec, 'normal');
  const moonHor = Astronomy.Horizon(time, OBSERVER, moonEq.ra, moonEq.dec, 'normal');

  const sunRadius = (Math.asin(SUN_RADIUS_KM / (sunEq.dist * AU_KM)) * 180) / Math.PI;
  const moonRadius = (Math.asin(MOON_RADIUS_KM / (moonEq.dist * AU_KM)) * 180) / Math.PI;

  let dAz = moonHor.azimuth - sunHor.azimuth;
  while (dAz > 180) dAz -= 360;
  while (dAz < -180) dAz += 360;

  // Azimuth degrees are not sky degrees: scale by cos(altitude), or the crescent
  // comes out stretched. The site had this exact bug until review caught it.
  const dx = dAz * Math.cos((sunHor.altitude * Math.PI) / 180);
  const dy = moonHor.altitude - sunHor.altitude;

  return {
    dx,
    dy,
    sunRadius,
    moonRadius,
    obscuration: overlapFraction(sunRadius, moonRadius, Math.hypot(dx, dy)),
    sunAltitude: sunHor.altitude,
    sunAzimuth: sunHor.azimuth,
  };
}

/** Interpolate across the eclipse, 0 = first contact, 1 = last contact. */
export function geometryAtProgress(t: number): Geometry {
  const span = LAST_CONTACT.getTime() - FIRST_CONTACT.getTime();
  return geometryAt(new Date(FIRST_CONTACT.getTime() + span * Math.min(1, Math.max(0, t))));
}

export function formatBST(time: Date): string {
  return time.toLocaleTimeString('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
  });
}
