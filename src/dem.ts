/**
 * Digital elevation model sampling from AWS "Terrarium" terrain tiles.
 *
 * Terrarium encodes height in the RGB channels of a PNG:
 *   elevation_metres = (R * 256 + G + B / 256) - 32768
 *
 * The tiles are public, free and serve `Access-Control-Allow-Origin: *`, so we can
 * decode them client-side in a canvas without a proxy or an API key.
 */

const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const TILE_SIZE = 256;

/** z12 is ~24 m/px at UK latitudes — a good match for SRTM's native 30 m posting. */
export const DEM_ZOOM = 12;

type Tile = Float32Array;

const cache = new Map<string, Promise<Tile | null>>();

function tileUrl(z: number, x: number, y: number): string {
  return TILE_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

/** Fractional tile coordinates (Web Mercator) for a lat/lon at a given zoom. */
export function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  return {
    x: ((lng + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  };
}

async function loadTile(z: number, x: number, y: number): Promise<Tile | null> {
  const key = `${z}/${x}/${y}`;
  let pending = cache.get(key);
  if (pending) return pending;

  pending = (async () => {
    try {
      // fetch + createImageBitmap rather than an <img>: the DOM image pipeline is
      // throttled hard in background tabs, which would stall the whole horizon
      // calculation if the user switched away mid-computation.
      const res = await fetch(tileUrl(z, x, y));
      if (!res.ok) return null;
      const bitmap = await createImageBitmap(await res.blob());

      const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();

      const { data } = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
      const heights = new Float32Array(TILE_SIZE * TILE_SIZE);
      for (let i = 0; i < heights.length; i++) {
        const p = i * 4;
        heights[i] = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
      }
      return heights;
    } catch {
      // Signals "no data", NOT "sea level" — see sampleElevation.
      return null;
    }
  })();

  cache.set(key, pending);
  return pending;
}

/**
 * Pre-load every tile touched by a set of points. Sampling is synchronous after
 * this resolves, which keeps the ray-marching loop simple.
 */
export async function preloadTiles(points: Array<{ lng: number; lat: number }>, z = DEM_ZOOM): Promise<void> {
  const needed = new Set<string>();
  for (const p of points) {
    const t = lngLatToTile(p.lng, p.lat, z);
    needed.add(`${Math.floor(t.x)},${Math.floor(t.y)}`);
  }
  await Promise.all(
    [...needed].map((k) => {
      const [x, y] = k.split(',').map(Number);
      return loadTile(z, x, y);
    }),
  );
}

/**
 * Bilinearly-interpolated elevation in metres, or `NaN` where the DEM has no data.
 *
 * It must NOT fall back to 0. A failed tile fetch would then be indistinguishable
 * from sea level, which produces a textbook flat horizon and a confident "yes, you
 * will see it" built on data that was never loaded — and tile failures get *more*
 * likely as traffic rises. Callers must handle NaN explicitly.
 *
 * Only valid for tiles already fetched by `preloadTiles`/`settleTiles`.
 */
export function sampleElevation(lng: number, lat: number, z = DEM_ZOOM): number {
  const t = lngLatToTile(lng, lat, z);
  const tx = Math.floor(t.x);
  const ty = Math.floor(t.y);

  const px = (t.x - tx) * TILE_SIZE;
  const py = (t.y - ty) * TILE_SIZE;

  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const fx = px - x0;
  const fy = py - y0;

  const at = (gx: number, gy: number): number => {
    // Walk into the neighbouring tile when the sample falls off the edge.
    let tileX = tx;
    let tileY = ty;
    let ix = gx;
    let iy = gy;
    if (ix < 0) { tileX -= 1; ix += TILE_SIZE; }
    if (ix >= TILE_SIZE) { tileX += 1; ix -= TILE_SIZE; }
    if (iy < 0) { tileY -= 1; iy += TILE_SIZE; }
    if (iy >= TILE_SIZE) { tileY += 1; iy -= TILE_SIZE; }

    const tile = syncTile(z, tileX, tileY);
    if (!tile) return NaN;
    return tile[iy * TILE_SIZE + ix];
  };

  const h00 = at(x0, y0);
  const h10 = at(x0 + 1, y0);
  const h01 = at(x0, y0 + 1);
  const h11 = at(x0 + 1, y0 + 1);

  return (
    h00 * (1 - fx) * (1 - fy) +
    h10 * fx * (1 - fy) +
    h01 * (1 - fx) * fy +
    h11 * fx * fy
  );
}

/** Resolved tiles, for synchronous access during ray-marching. */
const resolved = new Map<string, Tile | null>();

function syncTile(z: number, x: number, y: number): Tile | null {
  const key = `${z}/${x}/${y}`;
  if (resolved.has(key)) return resolved.get(key)!;
  const pending = cache.get(key);
  if (!pending) return null;
  // Tiles are resolved by preloadTiles before sampling; record on first touch.
  void pending.then((t) => resolved.set(key, t));
  return resolved.get(key) ?? null;
}

/** Await all in-flight tile loads and populate the synchronous lookup table. */
export async function settleTiles(): Promise<void> {
  const entries = [...cache.entries()];
  const tiles = await Promise.all(entries.map(([, p]) => p));
  entries.forEach(([k], i) => resolved.set(k, tiles[i]));
}
