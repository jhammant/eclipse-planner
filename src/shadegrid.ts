/**
 * Sun-and-shade map: across a whole neighbourhood, where is the Sun above the
 * local skyline at maximum eclipse?
 *
 * Standing in direct sunlight is exactly the same thing as having line of sight
 * to the Sun, so a sun/shade map at maximum IS a "can you see it from here?" map
 * — for a thousand spots at once, instead of one pin at a time.
 *
 * What makes it cheap enough to run on a phone: the Sun is in precisely one
 * direction, so each spot only needs the sliver of horizon around that bearing.
 * The profile behind the written verdict takes roughly 90x more elevation samples
 * per point, and nearly all of it is sky the Sun never crosses.
 *
 * Terrain only — an Overpass call per grid point would take minutes and hammer a
 * volunteer-run server, so buildings and trees are not in this picture. The
 * single-pin answer remains the authoritative one.
 */

import { preloadTiles, settleTiles } from './dem';
import { clearance, computeHorizon, destination } from './horizon';

/**
 * The numbers below are a deliberate budget, aimed at "a few seconds on a
 * mid-range phone":
 *
 *   33 x 33 = 1089 spots, 250 m apart, covering 8 km across — big enough to
 *   include the next hill or the far side of a valley, fine enough that the
 *   patches read as a map rather than as blocks. 250 m is still ten times the
 *   ~24 m posting of the elevation data, so nothing is invented.
 *
 *   3 rays per spot, 0.3 deg apart, spanning the Sun's 0.53 deg disc, with 28
 *   range steps out to 15 km. That is ~91,000 elevation samples for the whole
 *   scan, which is well under a second of arithmetic; the wait is dominated by
 *   the one-off terrain download, not by the maths.
 */
const EXTENT_M = 8000;
const SPACING_M = 250;
/**
 * How far each ray looks. 8 km rather than the 25 km the per-pin verdict uses,
 * because this scan only asks about the Sun at MAXIMUM (about 10.5 degrees up in
 * the UK), and blocking a 10.5 degree Sun from 8 km away needs terrain above
 * 1,483 m — higher than anything in Britain (Ben Nevis is 1,345 m). The longer
 * ray bought nothing and cost 5.9 MB of elevation tiles instead of 2.3 MB, which
 * on a phone was the difference between a usable wait and an abandoned one.
 */
const RAY_DISTANCE_M = 8000;
const RAY_STEPS = 28;
const RAYS_PER_SPOT = 3;
const RAY_SPACING_DEG = 0.3;

/**
 * Half the azimuth window, plus slack. The slack is not cosmetic: `computeHorizon`
 * walks `from` to `to` by repeated addition, so without it floating-point drift on
 * the running total silently drops the last ray on some bearings.
 */
const AZIMUTH_HALF_WIDTH = ((RAYS_PER_SPOT - 1) / 2) * RAY_SPACING_DEG;
const AZIMUTH_SLACK = RAY_SPACING_DEG / 2;

const METRES_PER_DEGREE_LAT = 111_320;

/**
 * Terrain tiles are ~6 km across at UK latitudes, so a 2 km lattice over the
 * bounding box cannot step over one.
 */
const LATTICE_STEP_M = 2000;

export interface ShadeCell {
  type: 'Feature';
  /** Degrees the Sun clears the skyline by at this spot. Negative = hidden. */
  properties: { clearance: number };
  geometry: { type: 'Polygon'; coordinates: number[][][] };
}

export interface ShadeGrid {
  type: 'FeatureCollection';
  features: ShadeCell[];
}

export interface ShadeScanResult {
  grid: ShadeGrid;
  /** [[west, south], [east, north]] — ready for map.fitBounds. */
  bounds: [[number, number], [number, number]];
  /** The most open spot found, or null if the Sun is hidden everywhere. */
  best: { lat: number; lng: number; clearance: number; elevation: number } | null;
  /** Share of the scanned area with the Sun clear of the skyline, 0-1. */
  openFraction: number;
}

export interface ShadeScanOptions {
  /**
   * Return true to abandon an in-flight scan. The app moves a `generation`
   * counter on every new location, so a scan for the old spot stops mid-row
   * rather than painting a grid for somewhere the user has left.
   */
  cancelled?: () => boolean;
}

/**
 * Hand control back to the browser between rows, so the page keeps painting and
 * answering taps instead of locking up for the length of the scan.
 *
 * A MessageChannel rather than `setTimeout(resolve, 0)`: browsers clamp timers to
 * about one second in a background tab, which measured 28 seconds for a scan that
 * takes barely one — all of it spent waiting on 33 clamped timers because the
 * phone had locked or the user had switched app. Channel messages aren't
 * throttled, and still yield a real task boundary for the browser to paint in.
 */
const yieldChannel = new MessageChannel();
yieldChannel.port2.start();

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    yieldChannel.port2.addEventListener('message', () => resolve(), { once: true });
    yieldChannel.port1.postMessage(0);
  });
}

/**
 * Scan the area around `centre` for line of sight to the Sun.
 *
 * `onProgress` is called with 0 while the terrain downloads, then with the
 * fraction of rows completed. Resolves to null if the scan was cancelled.
 */
export async function scanVisibility(
  centre: { lat: number; lng: number },
  sunAzimuth: number,
  sunAltitude: number,
  opts: ShadeScanOptions = {},
  onProgress?: (fraction: number) => void,
): Promise<ShadeScanResult | null> {
  const cancelled = opts.cancelled ?? (() => false);

  const half = EXTENT_M / 2;
  const cells = Math.round(EXTENT_M / SPACING_M);

  // Row bases first: walking north once per row and then east along it halves the
  // great-circle work compared with solving both offsets for every spot.
  const rowBases = Array.from({ length: cells + 1 }, (_, j) =>
    destination(centre.lat, centre.lng, 0, -half + j * SPACING_M),
  );
  const rows = rowBases.map((base) =>
    Array.from({ length: cells + 1 }, (_, i) =>
      destination(base.lat, base.lng, 90, -half + i * SPACING_M),
    ),
  );

  onProgress?.(0);
  await preloadTerrain(rows, sunAzimuth);
  if (cancelled()) return null;

  // One square per spot, sized in degrees rather than by great circle: it keeps
  // every cell identical so they tile without seams, and over 8 km the error is
  // under a metre. The 1.02 makes neighbours overlap a hair, so antialiasing
  // cannot draw hairlines between them.
  const dLat = ((SPACING_M / 2) * 1.02) / METRES_PER_DEGREE_LAT;
  const dLng = dLat / Math.cos((centre.lat * Math.PI) / 180);

  const features: ShadeCell[] = [];
  let best: ShadeScanResult['best'] = null;
  let open = 0;

  for (let j = 0; j < rows.length; j++) {
    for (const p of rows[j]) {
      const profile = await computeHorizon(p.lat, p.lng, {
        fromAzimuth: sunAzimuth - AZIMUTH_HALF_WIDTH,
        toAzimuth: sunAzimuth + AZIMUTH_HALF_WIDTH + AZIMUTH_SLACK,
        azimuthStep: RAY_SPACING_DEG,
        distanceSteps: RAY_STEPS,
        maxDistance: RAY_DISTANCE_M,
      });

      // Where the elevation model has no data, computeHorizon leaves the skyline
      // at its -90 initial value, which would paint the emptiest cell on the map
      // as the single most open spot. Leave it unpainted so the basemap shows
      // through: honest "we don't know" beats a confident green square.
      if (profile.coverage < 0.6) continue;

      // Take the worst ray across the window: the whole solar disc has to be
      // clear before this spot honestly counts as sunlit.
      let cl = Infinity;
      for (const s of profile.samples) {
        cl = Math.min(cl, clearance(profile, s.azimuth, sunAltitude));
      }
      if (!Number.isFinite(cl)) continue;

      if (cl > 0) open++;
      if (!best || cl > best.clearance) {
        best = { lat: p.lat, lng: p.lng, clearance: cl, elevation: profile.groundElevation };
      }

      features.push({
        type: 'Feature',
        properties: { clearance: Math.round(cl * 100) / 100 },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [p.lng - dLng, p.lat - dLat],
              [p.lng + dLng, p.lat - dLat],
              [p.lng + dLng, p.lat + dLat],
              [p.lng - dLng, p.lat + dLat],
              [p.lng - dLng, p.lat - dLat],
            ],
          ],
        },
      });
    }

    onProgress?.((j + 1) / rows.length);
    await yieldToBrowser();
    if (cancelled()) return null;
  }

  const first = rows[0][0];
  const last = rows[rows.length - 1][rows[0].length - 1];

  return {
    grid: { type: 'FeatureCollection', features },
    bounds: [
      [first.lng - dLng, first.lat - dLat],
      [last.lng + dLng, last.lat + dLat],
    ],
    best,
    openFraction: features.length ? open / features.length : 0,
  };
}

/**
 * Fetch every terrain tile the scan can touch, in one pass.
 *
 * Left to itself `computeHorizon` would discover tiles a spot at a time, so a
 * missing tile in the far west would stall row after row on a fresh network
 * request. Doing it up front means the 1089 per-spot calls hit a warm cache and
 * never wait on anything.
 */
async function preloadTerrain(
  rows: Array<Array<{ lat: number; lng: number }>>,
  sunAzimuth: number,
): Promise<void> {
  // Rays only ever run towards the Sun, so the corners of the grid plus where
  // their rays end bound every sample the scan can take.
  const corners = [
    rows[0][0],
    rows[0][rows[0].length - 1],
    rows[rows.length - 1][0],
    rows[rows.length - 1][rows[0].length - 1],
  ];
  const extremes = [
    ...corners,
    ...corners.map((c) => destination(c.lat, c.lng, sunAzimuth, RAY_DISTANCE_M)),
  ];

  const south = Math.min(...extremes.map((p) => p.lat));
  const north = Math.max(...extremes.map((p) => p.lat));
  const west = Math.min(...extremes.map((p) => p.lng));
  const east = Math.max(...extremes.map((p) => p.lng));

  const stepLat = LATTICE_STEP_M / METRES_PER_DEGREE_LAT;
  const stepLng = stepLat / Math.cos((((south + north) / 2) * Math.PI) / 180);

  const lattice: Array<{ lat: number; lng: number }> = [];
  for (let lat = south; lat <= north + stepLat; lat += stepLat) {
    for (let lng = west; lng <= east + stepLng; lng += stepLng) {
      lattice.push({ lat: Math.min(lat, north), lng: Math.min(lng, east) });
    }
  }

  await preloadTiles(lattice);
  await settleTiles();
}
