/**
 * Simulated view of the sky from a chosen spot.
 *
 * Renders the real terrain skyline (from the DEM ray-march) with the Sun and Moon
 * placed at their true altitude/azimuth and drawn at their true angular size. The
 * terrain is painted *after* the discs so that it occludes them — which is the
 * whole point of the tool.
 *
 * At realistic phone sizes the true angular size of the Sun is only a few pixels,
 * so a magnifier inset (paintMagnifier) redraws the pair at a readable scale when
 * the disc alone would be too small to show the crescent.
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

// Sky palette. Module scope because the magnifier inset paints its own patch of
// sky and has to be the same sky, not a lookalike.
const ZENITH_BLUE = [56, 106, 178];
const HORIZON_BLUE = [148, 190, 224];
const HORIZON_WARM = [232, 148, 92];
const ZENITH_DUSK = [42, 68, 122];
const SUN_HIGH = [255, 250, 225];
const SUN_LOW = [255, 168, 84];
const MOON_DARK = [28, 34, 52];

/** Warmth ramps up as the Sun approaches the horizon. */
function sunsetness(altitude: number, over = 12): number {
  return Math.max(0, Math.min(1, (over - altitude) / over));
}

function paintSky(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  proj: Projection,
  frame: Frame,
) {
  const dim = brightness(frame.obscuration);
  const warmth = sunsetness(frame.sun.altitude);

  const top = mix(ZENITH_BLUE, ZENITH_DUSK, warmth);
  const bottom = mix(HORIZON_BLUE, HORIZON_WARM, warmth);

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
  ctx.fillStyle = rgb(mix(SUN_HIGH, SUN_LOW, sunsetness(sun.altitude, 10)));
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // Lunar disc — silhouetted, so it takes the sky colour behind it.
  // Azimuth degrees are not sky degrees: a horizontal offset of dAz subtends
  // dAz*cos(altitude) on the sky. Placing the Moon at its raw azimuth overstates
  // the separation by 5.3% at first contact from London, which is invisible at the
  // default zoom but several pixels once the user zooms into the crescent. The Sun
  // stays at its own azimuth so the compass grid is untouched.
  let dAzMain = moon.azimuth - sun.azimuth;
  while (dAzMain > 180) dAzMain -= 360;
  while (dAzMain < -180) dAzMain += 360;
  const cosAltMain = Math.cos((sun.altitude * Math.PI) / 180);

  const mx = cx + dAzMain * cosAltMain * proj.pxPerDeg;
  const my = cy - (moon.altitude - sun.altitude) * proj.pxPerDeg;
  const mr = Math.max(1.5, moon.angularRadius * proj.pxPerDeg);
  ctx.fillStyle = rgb(MOON_DARK, Math.max(0.5, dim));
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

  // Assigning width/height reallocates and clears the backing store, so only do
  // it when the size actually changed — otherwise every scrub frame pays for a
  // full buffer reallocation.
  const wantW = Math.round(width * dpr);
  const wantH = Math.round(height * dpr);
  if (canvas.width !== wantW || canvas.height !== wantH) {
    canvas.width = wantW;
    canvas.height = wantH;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const proj = makeProjection(width, height, opts);

  paintSky(ctx, width, height, proj, frame);
  paintSun(ctx, proj, frame);
  paintTerrain(ctx, width, height, proj, profile, opts);
  paintAssumed(ctx, width, height, proj, opts);
  paintHiddenSun(ctx, proj, profile, frame);
  paintGrid(ctx, width, height, proj, opts);
  // Last, on purpose: the loupe is a heads-up annotation rather than part of the
  // scene, so terrain must not occlude it and gridlines must not scribble across
  // it — and it has to stay readable in the very case the terrain wins.
  paintMagnifier(ctx, width, height, proj, profile, frame);
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

/**
 * Magnified inset of the Sun and Moon.
 *
 * At the default 26° span on a 300px-tall phone canvas the Sun is about six
 * pixels across, so the crescent — the entire emotional payoff of the page — is
 * sub-pixel. When the disc is too small to read we redraw both bodies into a
 * loupe at one common scale, so their positions, radii and separation stay in
 * true proportion and the crescent's shape and tilt are faithful. The angular
 * values come straight off the frame; nothing is re-derived here.
 */
function paintMagnifier(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  proj: Projection,
  profile: HorizonProfile | null,
  frame: Frame,
) {
  const { sun, moon } = frame;

  // Above this the naked disc already reads at a glance, and a second copy of it
  // would be clutter competing with the real thing.
  const drawnRadius = sun.angularRadius * proj.pxPerDeg;
  if (drawnRadius >= 14) return;
  // On a canvas this small the loupe would dominate the view it is annotating.
  if (Math.min(width, height) < 150) return;

  const radius = Math.max(38, Math.min(74, Math.min(width, height) * 0.15));
  const margin = 12;
  const sunX = proj.toX(sun.azimuth);
  const sunY = proj.toY(sun.altitude);

  // Sit horizontally opposite the Sun so the loupe never covers its subject, and
  // high, because the terrain silhouette owns the bottom of every frame here.
  const cx = sunX > width / 2 ? margin + radius : width - margin - radius;
  const cy = margin + radius;

  // Framing is locked to the Sun rather than to the Sun+Moon pair, so the disc
  // holds a constant size through playback instead of pulsing as the Moon closes
  // in. The Moon simply clips at the rim, exactly as it would in a real loupe.
  const scale = (radius - 10) / (Math.max(0.05, sun.angularRadius) * 1.5);

  // Same azimuth wrap as the main projection, so a view straddling due north
  // cannot fling the Moon out of the inset.
  let dAz = moon.azimuth - sun.azimuth;
  while (dAz > 180) dAz -= 360;
  while (dAz < -180) dAz += 360;

  const hidden = profile ? sun.altitude <= horizonAt(profile, sun.azimuth) : false;
  const dim = brightness(frame.obscuration);
  const warmth = sunsetness(sun.altitude);
  // The patch of sky immediately around the Sun: low in the gradient, hence the
  // bias towards the horizon tone.
  const localSky = mix(
    mix(ZENITH_BLUE, ZENITH_DUSK, warmth),
    mix(HORIZON_BLUE, HORIZON_WARM, warmth),
    0.75,
  );

  ctx.save();

  // Leader line first, so the rim tucks over its inner end and the whole thing
  // reads as a zoom of that spot rather than a second sun in the sky.
  const dx = sunX - cx;
  const dy = sunY - cy;
  const gap = Math.hypot(dx, dy);
  const stopShort = Math.max(drawnRadius, 9) + 7;
  const onScreen = sunX >= 0 && sunX <= width && sunY >= 0 && sunY <= height;
  if (onScreen && gap > radius + stopShort + 6) {
    const ux = dx / gap;
    const uy = dy / gap;
    ctx.strokeStyle = hidden ? 'rgba(255, 184, 77, 0.5)' : 'rgba(255, 236, 190, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx + ux * (radius + 3), cy + uy * (radius + 3));
    ctx.lineTo(sunX - ux * stopShort, sunY - uy * stopShort);
    ctx.stroke();

    // When the Sun is hidden, paintHiddenSun has already ringed the spot; a
    // second ring on top of it would just be noise.
    if (!hidden) {
      ctx.beginPath();
      ctx.arc(sunX, sunY, Math.max(drawnRadius * 1.9, 8), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.save();
  ctx.clip();

  ctx.fillStyle = rgb(localSky, dim);
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

  const r = sun.angularRadius * scale;
  const glowR = r * (1.6 + 2.4 * (1 - frame.obscuration));
  const glow = ctx.createRadialGradient(cx, cy, r * 0.8, cx, cy, glowR);
  glow.addColorStop(0, `rgba(255, 236, 190, ${0.55 * dim})`);
  glow.addColorStop(1, 'rgba(255, 220, 170, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

  ctx.fillStyle = rgb(mix(SUN_HIGH, SUN_LOW, sunsetness(sun.altitude, 10)));
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // See paintSun: dAz must be scaled by cos(altitude) to become a sky angle.
  // At 8x magnification the uncorrected version showed the Moon still clear of
  // the Sun while the readout underneath already said "1.9% covered".
  const mx = cx + dAz * Math.cos((sun.altitude * Math.PI) / 180) * scale;
  const my = cy - (moon.altitude - sun.altitude) * scale;
  ctx.fillStyle = rgb(MOON_DARK, Math.max(0.5, dim));
  ctx.beginPath();
  ctx.arc(mx, my, moon.angularRadius * scale, 0, Math.PI * 2);
  ctx.fill();

  // Below the skyline the inset still earns its place: it answers "what shape is
  // the eclipse right now", which the timeline needs, while the main frame
  // answers "can I see it". Veiling it in the terrain's own colour keeps the two
  // answers from being confused for one another.
  if (hidden) {
    ctx.fillStyle = 'rgba(10, 12, 18, 0.5)';
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  if (hidden) {
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255, 184, 77, 0.85)';
  } else {
    ctx.strokeStyle = 'rgba(255, 236, 190, 0.6)';
  }
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);

  // Hug the loupe's outer edge so a wider label can never run off the canvas.
  const onLeft = cx < width / 2;
  ctx.fillStyle = hidden ? 'rgba(255, 184, 77, 0.9)' : 'rgba(255, 236, 190, 0.85)';
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = onLeft ? 'left' : 'right';
  ctx.textBaseline = 'top';
  const zoom = Math.max(2, Math.round(scale / proj.pxPerDeg));
  ctx.fillText(
    `Sun ×${zoom}${hidden ? ' · hidden' : ''}`,
    onLeft ? cx - radius : cx + radius,
    cy + radius + 5,
  );
  ctx.restore();
}
