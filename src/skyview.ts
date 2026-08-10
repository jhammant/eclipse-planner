/**
 * Simulated view of the sky from a chosen spot.
 *
 * Renders the real terrain skyline (from the DEM ray-march) with the Sun and Moon
 * placed at their true altitude/azimuth and drawn at their true angular size. The
 * terrain is painted *after* the discs so that it occludes them — which is the
 * whole point of the tool.
 */

import type { Frame } from './eclipse';
import { compassPoint } from './eclipse';
import { horizonAt, type HorizonProfile } from './horizon';

export interface SkyViewOptions {
  centerAzimuth: number;
  centerAltitude: number;
  /**
   * Vertical field of view in degrees. The scale is driven by height rather than
   * width so that the Sun stays in frame on a wide, short canvas; the horizontal
   * extent is then whatever the aspect ratio gives us.
   */
  verticalSpanDeg: number;
  /**
   * Angular height of a user-described near-field screen (trees, houses). Drawn
   * distinctly, because it is an assumption the viewer typed in rather than
   * something measured from data.
   */
  assumedAltitude?: number;
}

interface Projection {
  pxPerDeg: number;
  toX: (azimuth: number) => number;
  toY: (altitude: number) => number;
}

function makeProjection(width: number, height: number, opts: SkyViewOptions): Projection {
  const pxPerDeg = height / opts.verticalSpanDeg;
  return {
    pxPerDeg,
    toX: (az) => {
      // Shortest angular path from view centre, so the 0/360 wrap is seamless.
      let delta = az - opts.centerAzimuth;
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      return width / 2 + delta * pxPerDeg;
    },
    toY: (alt) => height / 2 - (alt - opts.centerAltitude) * pxPerDeg,
  };
}

/**
 * Perceived brightness of the scene.
 *
 * Illumination falls linearly with obscuration, but perceived brightness follows
 * roughly Stevens' power law (exponent ~0.33 for brightness), and the eye also
 * adapts. That is why 91% covered looks like an odd, flat dusk rather than night —
 * a naive linear or 2.2-gamma model renders it far too dark to be honest.
 */
function brightness(obscuration: number): number {
  return Math.max(0.28, Math.pow(Math.max(0.001, 1 - obscuration), 0.33));
}

function mix(a: number[], b: number[], t: number): number[] {
  return a.map((v, i) => v + (b[i] - v) * t);
}

function rgb([r, g, b]: number[], dim = 1): string {
  return `rgb(${Math.round(r * dim)}, ${Math.round(g * dim)}, ${Math.round(b * dim)})`;
}

function paintSky(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  proj: Projection,
  frame: Frame,
) {
  const dim = brightness(frame.obscuration);
  // Warmth ramps up as the Sun approaches the horizon.
  const sunsetness = Math.max(0, Math.min(1, (12 - frame.sun.altitude) / 12));

  const zenithBlue = [56, 106, 178];
  const horizonBlue = [148, 190, 224];
  const horizonWarm = [232, 148, 92];
  const zenithDusk = [42, 68, 122];

  const top = mix(zenithBlue, zenithDusk, sunsetness);
  const bottom = mix(horizonBlue, horizonWarm, sunsetness);

  const horizonY = proj.toY(0);
  const grad = ctx.createLinearGradient(0, 0, 0, Math.max(horizonY, height));
  grad.addColorStop(0, rgb(top, dim));
  grad.addColorStop(1, rgb(bottom, dim));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
}

function paintSun(ctx: CanvasRenderingContext2D, proj: Projection, frame: Frame) {
  const { sun, moon } = frame;
  const cx = proj.toX(sun.azimuth);
  const cy = proj.toY(sun.altitude);
  const r = Math.max(1.5, sun.angularRadius * proj.pxPerDeg);

  const dim = brightness(frame.obscuration);

  // Atmospheric glow around the Sun, shrinking as the Moon covers it.
  const glowR = r * (3 + 9 * (1 - frame.obscuration));
  const glow = ctx.createRadialGradient(cx, cy, r * 0.8, cx, cy, glowR);
  glow.addColorStop(0, `rgba(255, 236, 190, ${0.55 * dim})`);
  glow.addColorStop(1, 'rgba(255, 220, 170, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
  ctx.fill();

  // Solar disc. Reddens as it sinks, matching the sky warmth.
  const sunsetness = Math.max(0, Math.min(1, (10 - sun.altitude) / 10));
  ctx.fillStyle = rgb(mix([255, 250, 225], [255, 168, 84], sunsetness));
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // Lunar disc — silhouetted, so it takes the sky colour behind it.
  const mx = proj.toX(moon.azimuth);
  const my = proj.toY(moon.altitude);
  const mr = Math.max(1.5, moon.angularRadius * proj.pxPerDeg);
  ctx.fillStyle = rgb([28, 34, 52], Math.max(0.5, dim));
  ctx.beginPath();
  ctx.arc(mx, my, mr, 0, Math.PI * 2);
  ctx.fill();
}

function paintTerrain(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  proj: Projection,
  profile: HorizonProfile | null,
  opts: SkyViewOptions,
) {
  ctx.beginPath();
  ctx.moveTo(0, height);
  for (let x = 0; x <= width; x++) {
    const az = opts.centerAzimuth + (x - width / 2) / proj.pxPerDeg;
    const alt = profile ? horizonAt(profile, az) : 0;
    ctx.lineTo(x, proj.toY(alt));
  }
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fillStyle = '#0a0c12';
  ctx.fill();

  // A rim light along the skyline keeps low terrain legible against a dark sky —
  // without it the profile that this whole tool is about becomes invisible.
  ctx.strokeStyle = 'rgba(255, 196, 128, 0.85)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function paintGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  proj: Projection,
  opts: SkyViewOptions,
) {
  ctx.save();
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'top';

  const horizontalFov = width / proj.pxPerDeg;

  // Altitude gridlines
  const span = opts.verticalSpanDeg;
  const altStep = span > 20 ? 5 : span > 8 ? 2 : span > 3 ? 1 : 0.25;
  for (let alt = -10; alt <= 60; alt += altStep) {
    const y = proj.toY(alt);
    if (y < 0 || y > height) continue;
    ctx.strokeStyle = alt === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(`${Number(alt.toFixed(2))}°`, 6, y + 3);
  }

  // Azimuth ticks with compass labels
  const azStep = horizontalFov > 40 ? 10 : horizontalFov > 12 ? 5 : horizontalFov > 4 ? 1 : 0.25;
  const start = Math.ceil((opts.centerAzimuth - horizontalFov / 2) / azStep) * azStep;
  for (let az = start; az <= opts.centerAzimuth + horizontalFov / 2; az += azStep) {
    const x = proj.toX(az);
    if (x < 0 || x > width) continue;
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    const label = `${Number(((((az % 360) + 360) % 360)).toFixed(2))}°`;
    ctx.fillText(label, x + 4, 6);
    if (azStep >= 5) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(compassPoint(az), x + 4, 20);
    }
  }
  ctx.restore();
}

export function renderSky(
  canvas: HTMLCanvasElement,
  profile: HorizonProfile | null,
  frame: Frame,
  opts: SkyViewOptions,
): void {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const proj = makeProjection(width, height, opts);

  paintSky(ctx, width, height, proj, frame);
  paintSun(ctx, proj, frame);
  paintTerrain(ctx, width, height, proj, profile, opts);
  paintAssumed(ctx, width, height, proj, opts);
  paintHiddenSun(ctx, proj, profile, frame);
  paintGrid(ctx, width, height, proj, opts);
}

/** Draw the assumed tree/house screen, visibly distinct from measured terrain. */
function paintAssumed(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  proj: Projection,
  opts: SkyViewOptions,
) {
  const alt = opts.assumedAltitude;
  if (alt === undefined || alt <= -89) return;

  const y = proj.toY(alt);
  if (y > height) return;

  ctx.save();
  ctx.fillStyle = 'rgba(74, 222, 128, 0.14)';
  ctx.fillRect(0, y, width, height - y);

  ctx.setLineDash([7, 5]);
  ctx.strokeStyle = 'rgba(122, 231, 158, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(width, y);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(150, 240, 180, 0.95)';
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`assumed screen  ${alt.toFixed(1)}°`, width - 8, y + 5);
  ctx.restore();
}

/**
 * When the skyline covers the Sun, mark where it actually is. Without this a
 * blocked view is just a dark rectangle, and you can't tell whether the Sun is
 * just behind the parapet or far below it.
 */
function paintHiddenSun(
  ctx: CanvasRenderingContext2D,
  proj: Projection,
  profile: HorizonProfile | null,
  frame: Frame,
) {
  if (!profile) return;
  const skyline = horizonAt(profile, frame.sun.azimuth);
  if (frame.sun.altitude > skyline) return;

  const cx = proj.toX(frame.sun.azimuth);
  const cy = proj.toY(frame.sun.altitude);
  const r = Math.max(4, frame.sun.angularRadius * proj.pxPerDeg);

  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(255, 184, 77, 0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(r, 9), 0, Math.PI * 2);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255, 184, 77, 0.9)';
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Sun — hidden', cx, cy + Math.max(r, 9) + 16);
  ctx.restore();
}
