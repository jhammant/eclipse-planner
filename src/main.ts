import {
  MapLibreMap,
  Marker,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
  type MapMouseEvent,
} from 'maplibre-gl';
import './style.css';

import {
  buildingSkyline,
  containingBuilding,
  fetchBuildings,
  preloadBuildingTiles,
  BUILDING_RADIUS_M,
} from './buildings';
import {
  circumstances,
  compassPoint,
  formatTime,
  observerAt,
  timeline,
  type Circumstances,
  type Frame,
} from './eclipse';
import {
  clearance,
  computeHorizon,
  destination,
  nearFieldAltitude,
  obstructionAt,
  withBuildings,
  withNearField,
  type HorizonProfile,
} from './horizon';
import { renderSky } from './skyview';
import {
  eclipseWindow,
  fetchCloudForecast,
  fetchCloudGrid,
  meanCloud,
  type CloudForecast,
} from './weather';

/**
 * Open parkland south of Alexandra Palace: high ground with a clear western
 * horizon. Deliberately NOT the palace itself — that coordinate falls inside the
 * building footprint, and the example spot must not open on "move the pin".
 */
const DEFAULT = { lat: 51.593, lng: -0.13 };

const TERRAIN_SOURCE = 'terrarium';

interface State {
  lat: number;
  lng: number;
  label: string;
  profile: HorizonProfile | null;
  circ: Circumstances | null;
  frames: Frame[];
  forecast: CloudForecast[] | null | undefined;
  /** 'pending' while querying, 'failed' if the query died, else how many were found. */
  buildings: 'pending' | 'failed' | number;
  /** The pin sits inside a footprint, so its own walls must not be modelled. */
  insideBuilding: boolean;
  /** Has the user actually told us what is in front of them? */
  nearAnswered: boolean;
  verticalSpan: number;
  frameIndex: number;
  playing: boolean;
  recording: boolean;
  /** Measured skyline, before the user's near-field screen is applied. */
  baseProfile: HorizonProfile | null;
  /** User-described trees / houses in front of them. */
  nearHeight: number;
  nearDistance: number;
}

const state: State = {
  ...DEFAULT,
  label: '',
  profile: null,
  circ: null,
  frames: [],
  forecast: undefined,
  buildings: 'pending',
  insideBuilding: false,
  nearAnswered: false,
  verticalSpan: 26,
  frameIndex: 60,
  playing: false,
  recording: false,
  baseProfile: null,
  nearHeight: 0,
  nearDistance: 20,
};

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const reportEl = $('#report');
const skyCanvas = $<HTMLCanvasElement>('#sky');
const timeInput = $<HTMLInputElement>('#time');
const timeLabel = $<HTMLOutputElement>('#time-label');
const zoomInput = $<HTMLInputElement>('#zoom');
const playBtn = $<HTMLButtonElement>('#play');
const recordBtn = $<HTMLButtonElement>('#record');
const shareBtn = $<HTMLButtonElement>('#share');
const hintEl = $('#finder-hint');

// ---------------------------------------------------------------- permalink

/**
 * The location lives in the URL hash, so any spot can be linked and shared, and
 * refresh/back behave the way people expect.
 */
function readHash(): {
  lat: number;
  lng: number;
  label?: string;
  nearHeight?: number;
  nearDistance?: number;
} | null {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  const latRaw = h.get('lat');
  const lngRaw = h.get('lng');
  // Must test for absence explicitly: Number(null) is 0, not NaN, so a missing
  // hash would otherwise read as a valid position in the Atlantic at 0°,0°.
  if (latRaw === null || lngRaw === null) return null;

  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  const nh = Number(h.get('nh'));
  const nd = Number(h.get('nd'));
  return {
    lat,
    lng,
    label: h.get('at') ?? undefined,
    nearHeight: Number.isFinite(nh) && nh > 0 ? nh : undefined,
    nearDistance: Number.isFinite(nd) && nd > 0 ? nd : undefined,
  };
}

/**
 * Update the shareable URL.
 *
 * `location.hash = ...` was wrong on two counts: it pushed a history entry for
 * every step of a slider drag (hundreds of them, trapping the back button), and
 * it fired `hashchange` asynchronously. The guard against our own event was a
 * `setTimeout(..., 0)` flag, which lost the race under rapid updates — a stray
 * hashchange then re-entered `update()` and kicked off a full terrain recompute
 * and network fetch mid-drag. `replaceState` fires no event at all, so the whole
 * race disappears along with the history spam.
 */
function writeHash(lat: number, lng: number, label: string) {
  const h = new URLSearchParams();
  h.set('lat', lat.toFixed(5));
  h.set('lng', lng.toFixed(5));
  if (label) h.set('at', label);
  if (state.nearHeight > 0) {
    h.set('nh', String(state.nearHeight));
    h.set('nd', String(state.nearDistance));
  }
  history.replaceState(null, '', `#${h.toString()}`);
}

// Only fires for navigation we did not cause — a pasted link, or back/forward.
window.addEventListener('hashchange', () => {
  const h = readHash();
  if (h) {
    marker.setLngLat([h.lng, h.lat]);
    map.flyTo({ center: [h.lng, h.lat] });
    void update(h.lat, h.lng, h.label ?? '');
  }
});

// ---------------------------------------------------------------- map

const start = readHash() ?? DEFAULT;

const map = new MapLibreMap({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [start.lng, start.lat],
  zoom: 14,
  pitch: 55,
  maxPitch: 85,
  attributionControl: { compact: true },
  // Without this the map's touch-action: none swallows one-finger scrolling and
  // the page reads as frozen on a phone. Two fingers still pan; a tap still drops
  // the pin. On desktop it also stops the wheel hijacking page scroll.
  cooperativeGestures: true,
});

if (import.meta.env.DEV) {
  // Test hooks: the map needs a visible tab to render (Chrome throttles
  // requestAnimationFrame when hidden), so automated checks drive `update`
  // directly. See maptest.html for verifying the map itself.
  Object.assign(window, { __map: map, __update: update, __state: state });
}

map.on('error', (e) => {
  // Basemap problems must not take the whole tool down — the eclipse maths and
  // the sky view work without it.
  console.error('[map]', (e as { error?: Error }).error?.message ?? e);
});

map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

const marker = new Marker({ color: '#ffb84d', draggable: true })
  .setLngLat([start.lng, start.lat])
  .addTo(map);

map.on('load', () => {
  map.addSource(TERRAIN_SOURCE, {
    type: 'raster-dem',
    tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
    tileSize: 256,
    encoding: 'terrarium',
    maxzoom: 13,
    attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>',
  });
  map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: 1.3 });

  map.addSource('sightline', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'sightline',
    type: 'line',
    source: 'sightline',
    paint: {
      'line-color': '#ffb84d',
      'line-width': 3,
      'line-dasharray': [2, 1.5],
      'line-opacity': 0.9,
    },
  });

  map.addSource('candidates', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'candidates',
    type: 'circle',
    source: 'candidates',
    paint: {
      'circle-radius': 7,
      'circle-color': ['get', 'colour'],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#0b0e16',
    },
  });

  if (state.circ) drawSightline(state.lat, state.lng, state.circ.peak.sun.azimuth);
});

map.on('click', (e: MapMouseEvent) => {
  marker.setLngLat(e.lngLat);
  clearSearchBox();
  void update(e.lngLat.lat, e.lngLat.lng, '');
});

marker.on('dragend', () => {
  const { lat, lng } = marker.getLngLat();
  clearSearchBox();
  void update(lat, lng, '');
});

function clearSearchBox() {
  const el = document.querySelector<HTMLInputElement>('#place-search');
  if (el) el.value = '';
}

function emptyFC() {
  return { type: 'FeatureCollection' as const, features: [] };
}

function drawSightline(lat: number, lng: number, azimuth: number) {
  const src = map.getSource('sightline') as GeoJSONSource | undefined;
  if (!src) return;
  const far = destination(lat, lng, azimuth, 6000);
  src.setData({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [[lng, lat], [far.lng, far.lat]] },
      },
    ],
  });
}

// ---------------------------------------------------------------- update cycle

let generation = 0;

async function update(lat: number, lng: number, label = '') {
  const gen = ++generation;
  stopPlayback();
  state.lat = lat;
  state.lng = lng;
  state.label = label;
  state.forecast = undefined;
  state.buildings = 'pending';
  state.insideBuilding = false;
  writeHash(lat, lng, label);

  reportEl.innerHTML = '<p class="spinner">Working out the hills around you…</p>';

  // A first pass at sea level tells us which slice of sky to profile.
  const rough = circumstances(observerAt(lat, lng, 0));
  if (!rough) {
    reportEl.innerHTML = '<p class="placeholder">No solar eclipse is visible from here on 12 August 2026.</p>';
    return;
  }

  const azimuths = [rough.partialBegin, rough.peak, rough.partialEnd]
    .filter(Boolean)
    .map((f) => (f as Frame).sun.azimuth);

  const terrain = await computeHorizon(lat, lng, {
    fromAzimuth: Math.floor(Math.min(...azimuths)) - 20,
    toAzimuth: Math.ceil(Math.max(...azimuths)) + 20,
    azimuthStep: 0.5,
  });
  if (gen !== generation) return;

  // Redo the astronomy now that we know how high the ground actually is.
  const observer = observerAt(lat, lng, terrain.groundElevation);
  const circ = circumstances(observer);
  if (!circ) return;

  state.baseProfile = terrain;
  state.profile = applyNearField(terrain);
  state.circ = circ;
  state.frames = timeline(circ, observer, 160);

  timeInput.max = String(state.frames.length - 1);
  state.frameIndex = state.frames.reduce(
    (best, f, i) => (f.obscuration > state.frames[best].obscuration ? i : best),
    0,
  );
  timeInput.value = String(state.frameIndex);

  drawSightline(lat, lng, circ.peak.sun.azimuth);
  renderReport();
  renderCurrentFrame();

  // Buildings and weather refine the answer; neither blocks the first paint.
  void fetchCloudForecast(lat, lng).then((f) => {
    if (gen !== generation) return;
    state.forecast = f;
    renderReport();
  });

  void (async () => {
    const buildings = await fetchBuildings(lat, lng, BUILDING_RADIUS_M);
    if (gen !== generation) return;

    // Each branch repaints: leaving the 'pending' text on screen would keep
    // claiming we were still checking long after we stopped.
    if (buildings === null) {
      state.buildings = 'failed';
      renderReport();
      return;
    }
    if (!buildings.length) {
      state.buildings = 0;
      renderReport();
      return;
    }

    // A geocoded house number, a postcode, or an indoor GPS fix all land inside a
    // footprint. Modelling the observer's own walls would wrap a 30-40° obstruction
    // right around them and report a confident, wrong "hidden".
    if (containingBuilding(lng, lat, buildings)) {
      state.insideBuilding = true;
      state.buildings = 0;
      renderReport();
      renderCurrentFrame();
      return;
    }

    await preloadBuildingTiles(buildings);
    if (gen !== generation) return;

    const bins = buildingSkyline(buildings, {
      lat,
      lng,
      eyeElevation: terrain.groundElevation + terrain.eyeHeight,
    });
    state.baseProfile = withBuildings(terrain, bins);
    state.profile = applyNearField(state.baseProfile);
    state.buildings = buildings.length;
    renderReport();
    renderCurrentFrame();
  })();
}

// ---------------------------------------------------------------- report

function clearanceClass(deg: number): string {
  if (deg > 3) return 'ok';
  if (deg > 0) return 'marginal';
  return 'blocked';
}

function clearanceWord(deg: number): string {
  if (deg > 3) return 'clear';
  if (deg > 0) return 'marginal';
  return 'blocked';
}

function contactRow(label: string, frame: Frame | null, profile: HorizonProfile): string {
  if (!frame) return '';
  const cl = clearance(profile, frame.sun.azimuth, frame.sun.altitude);
  return `
    <tr>
      <td>${label}</td>
      <td>${formatTime(frame.time)}</td>
      <td>${frame.sun.altitude.toFixed(1)}°</td>
      <td>${frame.sun.azimuth.toFixed(0)}° ${compassPoint(frame.sun.azimuth)}</td>
      <td class="${clearanceClass(cl)}">${cl > 0 ? '+' : ''}${cl.toFixed(1)}° ${clearanceWord(cl)}</td>
    </tr>`;
}

/**
 * Always say whose spot this is. Without it, someone in a Sheffield valley reads a
 * confident green verdict that is silently about a park in London.
 */
function whereamiHtml(): string {
  const isExample =
    !state.label && state.lat === DEFAULT.lat && state.lng === DEFAULT.lng;
  if (isExample) {
    return `<p class="whereami example">Example spot: Alexandra Palace, London —
      enter your address above to check yours.</p>`;
  }
  const where = state.label
    ? escapeHtml(state.label)
    : `Pin you dropped: ${state.lat.toFixed(4)}, ${state.lng.toFixed(4)}`;
  return `<p class="whereami">${where}</p>`;
}

/** Say what we actually checked — never imply buildings were included when they weren't. */
function buildingsNote(): string {
  if (state.insideBuilding) return 'Pin is inside a building, so buildings were not applied.';
  if (state.buildings === 'pending') {
    return `Still checking OpenStreetMap for buildings within ${BUILDING_RADIUS_M} m — this answer
      is terrain only so far.`;
  }
  if (state.buildings === 'failed') {
    return `Couldn't load building data (the map server is busy), so this is terrain only and may
      be too optimistic in a town. <button type="button" id="retry-buildings">Try again</button>`;
  }
  if (state.buildings === 0) return `No buildings mapped within ${BUILDING_RADIUS_M} m.`;
  return `Skyline includes ${state.buildings.toLocaleString()} OpenStreetMap buildings within
    ${BUILDING_RADIUS_M} m.`;
}

function renderReport() {
  const { circ, profile, forecast } = state;
  if (!circ || !profile) return;

  const peakClear = clearance(profile, circ.peak.sun.azimuth, circ.peak.sun.altitude);
  const pct = (circ.peakObscuration * 100).toFixed(1);
  const blocker = obstructionAt(profile, circ.peak.sun.azimuth);
  const blockerWord =
    blocker?.source === 'assumed'
      ? 'the trees or buildings you described'
      : blocker?.source === 'building'
      ? 'a building'
      : 'high ground';

  let tone: string;
  let headline: string;
  let detail: string;

  // Scan the whole event, not just maximum: a spot can be wide open at first
  // contact and lost behind a roof well before the deepest point.
  const visible = state.frames.map(
    (f) => clearance(profile, f.sun.azimuth, f.sun.altitude) > 0,
  );
  const firstVis = visible.indexOf(true);
  const lastVis = visible.lastIndexOf(true);
  const bestVis = firstVis < 0
    ? 0
    : Math.max(...state.frames.filter((_, i) => visible[i]).map((f) => f.obscuration));
  const minutesBetween = (a: Date, b: Date) => Math.round(Math.abs(+b - +a) / 60000);

  const checkedBuildings = typeof state.buildings === 'number' && state.buildings > 0;

  if (state.insideBuilding) {
    tone = 'warn';
    headline = 'Move the pin outside';
    detail = `This pin is inside a building, so we can't tell what sky it sees. Drag it to the
      garden, balcony, street or field where you'll actually be standing.`;
  } else if (firstVis < 0) {
    tone = 'bad';
    headline = 'No — not from here';
    detail = `The Sun stays behind ${blockerWord}${
      blocker ? ` about ${Math.round(blocker.distance)} m away` : ''
    } for the whole eclipse. You need somewhere with an open view to the west, where the Sun sets.`;
  } else if (peakClear <= 0) {
    const lostAt = state.frames[lastVis];
    const lateBlocker = obstructionAt(profile, lostAt.sun.azimuth);
    const lateWord =
      lateBlocker?.source === 'assumed'
        ? 'what you described'
        : lateBlocker?.source === 'building'
        ? 'a building'
        : 'high ground';
    tone = 'warn';
    headline = `${Math.round(bestVis * 100)}% — then it disappears`;
    detail = `You'll see the first ${minutesBetween(state.frames[0].time, lostAt.time)} minutes,
      reaching ${Math.round(bestVis * 100)}% covered. Then the Sun slips behind ${lateWord} at
      ${formatTime(lostAt.time)}, before the deepest point.`;
  } else if (peakClear < 3) {
    tone = 'warn';
    headline = 'Maybe — it will be close';
    detail = `The Sun clears your skyline by ${peakClear.toFixed(1)}° — ${
      peakClear < 1.5 ? "about a finger's width" : "about two fingers' width"
    } held at arm's length. Anything you haven't told us about will hide it.`;
  } else {
    tone = 'good';
    headline = `Yes — ${pct}% of the Sun covered`;
    detail = `The Sun sits ${peakClear.toFixed(0)}° above your skyline at the deepest point, so ${
      checkedBuildings ? 'the hills and buildings' : "the hills"
    } won't get in the way${checkedBuildings ? '' : " — we couldn't check buildings here"}.
      It won't go dark: expect a strange, flat, dimmed evening light.`;

    // Clear at maximum but lost before the end is worth saying out loud.
    if (lastVis < state.frames.length - 1) {
      const lostAt = state.frames[lastVis];
      const lostMins = minutesBetween(lostAt.time, state.frames[state.frames.length - 1].time);
      if (lostMins >= 3) {
        detail += ` It drops behind your skyline at ${formatTime(lostAt.time)}, so you'll miss the
          last ${lostMins} minutes.`;
      }
    }
  }

  // Never let a green verdict imply we accounted for trees the user never mentioned.
  if ((tone === 'good' || tone === 'warn') && !state.nearAnswered && !state.insideBuilding) {
    detail += ` <strong>This assumes nothing is in front of you.</strong> Trees and fences aren't on
      any map — tell us what you can actually see, below.`;
  }

  const cloud = forecast ? meanCloud(forecast) : null;
  const window = forecast ? eclipseWindow(forecast) : [];

  reportEl.innerHTML = `
    <div class="verdict ${tone}">
      <span class="big">${headline}</span>
      <p>${detail}</p>
    </div>

    ${whereamiHtml()}

    <div class="stat-row">
      <div class="stat">
        <div class="label">Maximum at</div>
        <div class="value">${formatTime(circ.peak.time)}</div>
      </div>
      <div class="stat">
        <div class="label">Look towards</div>
        <div class="value">${compassPoint(circ.peak.sun.azimuth)} ${circ.peak.sun.azimuth.toFixed(0)}°</div>
      </div>
      <div class="stat">
        <div class="label">Sun altitude</div>
        <div class="value">${circ.peak.sun.altitude.toFixed(1)}°</div>
      </div>
      <div class="stat">
        <div class="label">Ground height</div>
        <div class="value">${profile.groundElevation.toFixed(0)} m</div>
      </div>
    </div>

    <h3 class="section">Timings (BST)</h3>
    <table class="contacts">
      <thead>
        <tr><th>Stage</th><th>Time</th><th>Alt</th><th>Bearing</th><th>Sky clearance</th></tr>
      </thead>
      <tbody>
        ${contactRow('First contact', circ.partialBegin, profile)}
        ${contactRow('Maximum', circ.peak, profile)}
        ${contactRow('Last contact', circ.partialEnd, profile)}
      </tbody>
    </table>
    <p class="note">${buildingsNote()}${
      state.nearHeight > 0
        ? ` Plus your ${state.nearHeight} m screen at ${state.nearDistance} m.`
        : ''
    }</p>

    <h3 class="section">Cloud forecast</h3>
    ${
      forecast === undefined
        ? '<p class="spinner">Loading forecast…</p>'
        : cloud === null
        ? '<p class="placeholder">Forecast unavailable.</p>'
        : `<div class="stat" style="margin-bottom:8px">
             <div class="label">Mean cloud cover, 18:00–21:00</div>
             <div class="value">${cloud.toFixed(0)}%</div>
             <div class="cloud-bar" style="margin-top:6px"><span style="width:${cloud}%"></span></div>
           </div>
           <table class="contacts">
             <thead><tr><th>Hour</th><th>Total</th><th>Low</th><th>Visibility</th></tr></thead>
             <tbody>
               ${window
                 .map(
                   (f) => `<tr>
                     <td>${f.time.slice(11, 16)}</td>
                     <td>${f.totalCloud}%</td>
                     <td>${f.lowCloud}%</td>
                     <td>${f.visibilityKm.toFixed(0)} km</td>
                   </tr>`,
                 )
                 .join('')}
             </tbody>
           </table>
           <p class="note">Forecasts this far out are indicative. Re-check on the day.</p>`
    }
  `;
}

function escapeHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// The buildings note can render a retry button; delegate so it survives re-renders.
reportEl.addEventListener('click', (e) => {
  if ((e.target as HTMLElement)?.id === 'retry-buildings') {
    void update(state.lat, state.lng, state.label);
  }
});

// ---------------------------------------------------------------- sky view

function renderCurrentFrame() {
  const frame = state.frames[state.frameIndex];
  if (!frame) return;

  // Keep the horizon and the Sun both in shot if they fit; past that, lock on.
  const bottom = -2;
  const top = frame.sun.altitude + 3;
  const centerAltitude =
    top - bottom <= state.verticalSpan ? (top + bottom) / 2 : frame.sun.altitude;

  renderSky(skyCanvas, state.profile, frame, {
    centerAzimuth: frame.sun.azimuth,
    centerAltitude,
    verticalSpanDeg: state.verticalSpan,
    assumedAltitude:
      state.nearHeight > 0 && state.profile
        ? nearFieldAltitude(state.profile, state.nearHeight, state.nearDistance)
        : undefined,
  });

  const cl = state.profile
    ? clearance(state.profile, frame.sun.azimuth, frame.sun.altitude)
    : frame.sun.altitude;

  timeLabel.value =
    `${formatTime(frame.time)}  ·  ${(frame.obscuration * 100).toFixed(1)}% covered` +
    (cl <= 0 ? '  ·  hidden' : '');
}

let framePending = 0;

/** Draw at most once per animation frame while a slider is being dragged. */
function scheduleFrame() {
  if (framePending) return;
  framePending = requestAnimationFrame(() => {
    framePending = 0;
    renderCurrentFrame();
  });
}

timeInput.addEventListener('input', () => {
  stopPlayback();
  state.frameIndex = Number(timeInput.value);
  scheduleFrame();
});

/** Slider runs left-to-right as "more zoomed in", so invert it. */
function spanFromSlider(v: number): number {
  return 62 - v;
}

zoomInput.addEventListener('input', () => {
  state.verticalSpan = spanFromSlider(Number(zoomInput.value));
  scheduleFrame();
});
state.verticalSpan = spanFromSlider(Number(zoomInput.value));

window.addEventListener('resize', renderCurrentFrame);

// ---------------------------------------------------------------- playback

let rafId = 0;
let playStart = 0;
/** Wall-clock seconds for one run through the whole eclipse. */
const PLAY_SECONDS = 20;

function stopPlayback() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  state.playing = false;
  playBtn.textContent = '▶ Play';
}

function startPlayback(onEnd?: () => void) {
  if (!state.frames.length) return;
  state.playing = true;
  playBtn.textContent = '❚❚ Pause';
  playStart = performance.now();

  const step = (now: number) => {
    const t = (now - playStart) / (PLAY_SECONDS * 1000);
    if (t >= 1) {
      state.frameIndex = state.frames.length - 1;
      timeInput.value = String(state.frameIndex);
      renderCurrentFrame();
      stopPlayback();
      onEnd?.();
      return;
    }
    state.frameIndex = Math.round(t * (state.frames.length - 1));
    timeInput.value = String(state.frameIndex);
    renderCurrentFrame();
    rafId = requestAnimationFrame(step);
  };

  state.frameIndex = 0;
  rafId = requestAnimationFrame(step);
}

playBtn.addEventListener('click', () => {
  if (state.playing) stopPlayback();
  else startPlayback();
});

// ---------------------------------------------------------------- video export

function pickMimeType(): string | null {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? null;
}

recordBtn.addEventListener('click', () => {
  if (state.recording || !state.frames.length) return;

  const mimeType = pickMimeType();
  if (!mimeType || typeof skyCanvas.captureStream !== 'function') {
    setHint('Video export is not supported in this browser — try Chrome or Firefox.');
    return;
  }

  state.recording = true;
  recordBtn.textContent = 'Recording…';
  recordBtn.disabled = true;

  const stream = skyCanvas.captureStream(30);
  const chunks: BlobPart[] = [];
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });

  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eclipse-2026-${state.lat.toFixed(3)}_${state.lng.toFixed(3)}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);

    state.recording = false;
    recordBtn.textContent = 'Save video';
    recordBtn.disabled = false;
    setHint('Video saved.');
  };

  rec.start();
  startPlayback(() => {
    // Let the last frame land in the stream before closing the file.
    setTimeout(() => rec.stop(), 250);
  });
});

// ---------------------------------------------------------------- share

shareBtn.addEventListener('click', async () => {
  const url = location.href;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Will I see the eclipse?', url });
      return;
    }
    await navigator.clipboard.writeText(url);
    shareBtn.textContent = 'Copied';
    setTimeout(() => { shareBtn.textContent = 'Copy link'; }, 1800);
  } catch {
    setHint('Copy the address bar to share this spot.');
  }
});

// ---------------------------------------------------------------- address search

const searchForm = $<HTMLFormElement>('#search-form');
const searchInput = $<HTMLInputElement>('#place-search');
const resultsEl = $<HTMLUListElement>('#search-results');
let searchTimer: number | undefined;

function setHint(msg: string) {
  hintEl.textContent = msg;
}

interface Hit { lat: string; lon: string; display_name: string }

async function geocode(q: string): Promise<Hit[]> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'json');
  url.searchParams.set('q', q);
  url.searchParams.set('limit', '6');
  url.searchParams.set('countrycodes', 'gb,ie');
  url.searchParams.set('addressdetails', '0');
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return [];
  return res.json();
}

function shortLabel(displayName: string): string {
  return displayName.split(',').slice(0, 3).join(',').trim();
}

function showResults(hits: Hit[]) {
  resultsEl.innerHTML = hits
    .map(
      (h) =>
        `<li role="option" data-lat="${h.lat}" data-lon="${h.lon}" data-label="${escapeHtml(
          shortLabel(h.display_name),
        )}">${escapeHtml(h.display_name)}</li>`,
    )
    .join('');
  resultsEl.hidden = hits.length === 0;
}

searchInput.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 3) {
    resultsEl.hidden = true;
    return;
  }
  // Nominatim asks for at most 1 request/second; debounce generously.
  searchTimer = window.setTimeout(() => {
    void geocode(q).then(showResults).catch(() => { resultsEl.hidden = true; });
  }, 450);
});

searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (!q) return;
  setHint('Looking that up…');
  try {
    const hits = await geocode(q);
    if (!hits.length) {
      setHint('No match found — try a postcode, or scroll down and tap the map.');
      return;
    }
    resultsEl.hidden = true;
    goTo(Number(hits[0].lat), Number(hits[0].lon), shortLabel(hits[0].display_name));
    setHint('Or scroll down and tap the map.');
  } catch {
    setHint('Address lookup failed — scroll down and tap the map instead.');
  }
});

resultsEl.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest('li');
  if (!li) return;
  resultsEl.hidden = true;
  searchInput.value = li.dataset.label ?? '';
  goTo(Number(li.dataset.lat), Number(li.dataset.lon), li.dataset.label ?? '');
});

document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('.search')) resultsEl.hidden = true;
});

function goTo(lat: number, lng: number, label: string) {
  marker.setLngLat([lng, lat]);
  map.flyTo({ center: [lng, lat], zoom: 14 });
  void update(lat, lng, label);
}

// ---------------------------------------------------------------- geolocation

$<HTMLButtonElement>('#use-location').addEventListener('click', () => {
  if (!navigator.geolocation) {
    setHint('This browser cannot share your location.');
    return;
  }
  setHint('Finding you…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setHint('Or scroll down and tap the map.');
      goTo(pos.coords.latitude, pos.coords.longitude, 'My location');
    },
    () => setHint('Location unavailable — type an address instead.'),
    { enableHighAccuracy: true, timeout: 10_000 },
  );
});

// ---------------------------------------------------------------- best spot near me

const findBtn = $<HTMLButtonElement>('#find-best');

findBtn.addEventListener('click', async () => {
  if (!state.circ) return;
  findBtn.disabled = true;
  findBtn.textContent = 'Scanning…';
  setHint('Scanning spots within 6 km…');

  try {
    const sunAz = state.circ.peak.sun.azimuth;
    const sunAlt = state.circ.peak.sun.altitude;

    // A 5×5 grid over ~12 km. The DEM tiles are already cached from the main
    // profile, so this is mostly arithmetic.
    const candidates: Array<{ lat: number; lng: number }> = [];
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const east = destination(state.lat, state.lng, 90, dx * 3000);
        const p = destination(east.lat, east.lng, 0, dy * 3000);
        candidates.push(p);
      }
    }

    interface Candidate {
      lat: number;
      lng: number;
      clearance: number;
      elevation: number;
      score: number;
    }

    const scored: Candidate[] = [];
    for (const c of candidates) {
      const prof = await computeHorizon(c.lat, c.lng, {
        fromAzimuth: sunAz - 4,
        toAzimuth: sunAz + 4,
        azimuthStep: 2,
        distanceSteps: 28,
        maxDistance: 12000,
      });
      scored.push({
        ...c,
        clearance: clearance(prof, sunAz, sunAlt),
        elevation: prof.groundElevation,
        score: 0,
      });
    }

    const clouds = await fetchCloudGrid(candidates);
    scored.forEach((s, i) => {
      // Clearance is the hard constraint; cloud only breaks ties between open
      // spots, and extra clearance stops mattering once you can plainly see out.
      s.score = Math.min(s.clearance, 12) * 10 - (clouds[i] ?? 50) * 0.3;
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 5);

    const src = map.getSource('candidates') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: top.map((s, i) => ({
        type: 'Feature',
        properties: { colour: i === 0 ? '#4ade80' : '#7dd3fc' },
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      })),
    });

    const best = top[0];
    if (best && best.clearance > 0) {
      setHint(
        `Best nearby: ${best.clearance.toFixed(1)}° clearance at ${best.elevation.toFixed(0)} m ` +
          `— pinned green on the map. Click it to check it properly.`,
      );
      map.fitBounds(
        [
          [Math.min(...top.map((t) => t.lng)), Math.min(...top.map((t) => t.lat))],
          [Math.max(...top.map((t) => t.lng)), Math.max(...top.map((t) => t.lat))],
        ],
        { padding: 60, duration: 900 },
      );
    } else {
      setHint('Nothing nearby has a clear western horizon — try a wider search area.');
    }
  } finally {
    findBtn.disabled = false;
    findBtn.textContent = 'Find the best spot near me';
  }
});

// ---------------------------------------------------------------- near field

const nfPresets = $('#nf-presets');
const nfHeight = $<HTMLInputElement>('#nf-height');
const nfDistance = $<HTMLInputElement>('#nf-distance');
const nfHeightOut = $<HTMLOutputElement>('#nf-h-out');
const nfDistanceOut = $<HTMLOutputElement>('#nf-d-out');

/** Overlay the user's described screen on top of the measured skyline. */
function applyNearField(profile: HorizonProfile): HorizonProfile {
  return state.nearHeight > 0
    ? withNearField(profile, state.nearHeight, state.nearDistance)
    : profile;
}

function syncNearFieldUI() {
  nfHeight.value = String(state.nearHeight);
  nfDistance.value = String(state.nearDistance);
  nfHeightOut.value = state.nearHeight > 0 ? `${state.nearHeight} m` : 'none';
  nfDistanceOut.value = state.nearHeight > 0 ? `${state.nearDistance} m` : '—';

  for (const b of nfPresets.querySelectorAll('button')) {
    const h = Number((b as HTMLElement).dataset.h);
    const d = Number((b as HTMLElement).dataset.d);
    const active =
      state.nearAnswered && h === state.nearHeight && (h === 0 || d === state.nearDistance);
    b.classList.toggle('on', active);
  }
}

let repaintPending = 0;

/**
 * Recompute the verdict and repaint without re-fetching any data.
 *
 * Sliders fire `input` far faster than we can rebuild the report and redraw the
 * canvas, so the work is coalesced into a single animation frame. Without this
 * the queue backs up behind the drag and the control feels like it is fighting
 * your thumb.
 */
function reapplyNearField() {
  if (!state.baseProfile) return;
  state.profile = applyNearField(state.baseProfile);
  syncNearFieldUI();

  if (repaintPending) return;
  repaintPending = requestAnimationFrame(() => {
    repaintPending = 0;
    writeHash(state.lat, state.lng, state.label);
    renderReport();
    renderCurrentFrame();
  });
}

nfPresets.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  state.nearHeight = Number(btn.dataset.h);
  if (state.nearHeight > 0) state.nearDistance = Number(btn.dataset.d);
  state.nearAnswered = true;
  reapplyNearField();
});

nfHeight.addEventListener('input', () => {
  state.nearHeight = Number(nfHeight.value);
  state.nearAnswered = true;
  reapplyNearField();
});

nfDistance.addEventListener('input', () => {
  state.nearDistance = Number(nfDistance.value);
  state.nearAnswered = true;
  reapplyNearField();
});

// ---------------------------------------------------------------- start
// Last, so every binding above is initialised before `update` runs.
const seed = start as { label?: string; nearHeight?: number; nearDistance?: number };
if (seed.nearHeight) {
  state.nearHeight = seed.nearHeight;
  state.nearDistance = seed.nearDistance ?? 20;
  state.nearAnswered = true;
}
syncNearFieldUI();
void update(start.lat, start.lng, seed.label ?? '');
