import { ParcelIndex, computeStatus, feetPerDegree, FT_PER_M } from './engine.js';

const TILE_CACHE = 'tiles-v1';
const COUNTY_MAP = 'https://imap.klickitatcounty.gov/';
const USGS = 'https://basemap.nationalmap.gov/arcgis/rest/services';
const COUNTY_EXPORT = 'https://geo.gartrellgroup.com/server/rest/services/Klickitat/Layers/MapServer/export' +
  '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=1024,1024&dpi=192&format=png32&transparent=true&f=image&layers=show:';

const BASEMAPS = {
  topo: { name: 'USGS Topo', url: `${USGS}/USGSTopo/MapServer/tile/{z}/{y}/{x}` },
  imagery: { name: 'Aerial (USGS)', url: `${USGS}/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}` },
  hybrid: { name: 'Aerial + topo labels', url: `${USGS}/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}` },
  none: { name: 'None (parcels only)' },
};
const BASEMAP_MAXZOOM = 16;
const OVERLAYS = {
  plss: { name: 'Sections & townships', layers: '11,12' },
  roads: { name: 'County roads & waterways', layers: '8,9' },
  zoning: { name: 'Zoning', layers: '18' },
  city: { name: 'City limits', layers: '4' },
};

const CLASS_INFO = {
  pf: { name: 'Public — federal', short: 'Federal land', badge: 'public', off: false },
  ps: { name: 'Public — state', short: 'State land', badge: 'public', off: false },
  t: { name: 'Tribal land', short: 'Tribal land', badge: 'tribal', off: true },
  op: { name: 'Other public (off-limits by default)', short: 'Off-limits public land', badge: 'other', off: true },
  p: { name: 'Private', short: 'Private land', badge: 'private', off: true },
  u: { name: 'Unclassified — needs review', short: 'Unclassified parcel', badge: 'unknown', off: false },
};
const USE_CODES = {
  11: 'Single-family residence', 12: 'Residence, 2–4 units', 13: 'Residence, multi-unit', 18: 'Other residential',
  19: 'Vacation / cabin', 41: 'Railroad / transit', 45: 'Highway & street right-of-way', 47: 'Communication',
  48: 'Utilities', 67: 'Governmental services', 68: 'Educational services', 74: 'Recreational activities',
  76: 'Parks', 81: 'Agriculture', 83: 'Agriculture (current use)', 88: 'Designated forest land',
  91: 'Undeveloped land', 92: 'Noncommercial forest', 93: 'Water areas', 94: 'Open space', 95: 'Timberland',
};
const STATUS_COLORS = { green: '#2e9e44', yellow: '#e0ad00', red: '#d63a3a', gray: '#8a8f94' };

const $ = (id) => document.getElementById(id);
const S = {
  feats: [], index: null, byPn: new Map(), meta: null, map: null,
  user: load('kpm.user.v1', { parcels: {} }),
  settings: { basemap: 'topo', overlays: {}, sound: true, vibrate: true, wake: true, introSeen: false, ...load('kpm.settings.v1', {}) },
  fix: null, status: null, lastLevel: null, tracking: false, geoError: null, watchId: null,
  following: true, firstFix: true, selected: null, measuring: false, measurePts: [], audio: null, wakeLock: null,
  download: null,
};

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { toast('Could not save — storage is unavailable'); }
}
const saveUser = () => save('kpm.user.v1', S.user);
const saveSettings = () => save('kpm.settings.v1', S.settings);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = true;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmtFt = (ft) => (ft < 1000 ? `${Math.round(ft)} ft` : `${(ft / 5280).toFixed(ft < 52800 ? 2 : 1)} mi`);
const fmtMoney = (v) => (v == null ? '—' : `$${Math.round(v).toLocaleString()}`);

// ---------- user marks (Allowed / Off-limits) ----------

function userEntry(pn) { return S.user.parcels[pn] || null; }
function userState(pn) {
  const e = userEntry(pn);
  if (!e) return null;
  if (e.status === 'allowed' && e.expires && e.expires < today()) return null;
  return e.status;
}
function isOffLimits(i) {
  const pr = S.feats[i].properties;
  const u = userState(pr.p);
  if (u === 'allowed') return false;
  if (u === 'blocked') return true;
  return CLASS_INFO[pr.c].off;
}
function isUnknown(i) {
  const pr = S.feats[i].properties;
  return pr.c === 'u' && !userState(pr.p);
}
function syncFeatureState(pn) {
  for (const id of S.byPn.get(pn) || []) S.map.setFeatureState({ source: 'parcels', id }, { u: userState(pn) });
}
function setUserMark(pn, entry) {
  if (entry) S.user.parcels[pn] = { ...entry, updated: today() };
  else delete S.user.parcels[pn];
  saveUser();
  syncFeatureState(pn);
  updateStatus();
}

// ---------- map ----------

function initMap() {
  const view = load('kpm.view.v1', null);
  const map = new maplibregl.Map({
    container: 'map',
    style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e8ebe4' } }] },
    center: view ? view.center : [-120.85, 45.85],
    zoom: view ? view.zoom : 8.6,
    maxZoom: 20,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: 'Parcels: Klickitat County · Public lands: USGS PAD-US · Basemap: USGS',
  }), 'bottom-left');
  map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
  map.once('load', () => document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
  let saveTimer;
  map.on('moveend', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save('kpm.view.v1', { center: map.getCenter().toArray(), zoom: map.getZoom() }), 500);
  });
  map.on('dragstart', () => setFollowing(false));
  map.on('click', onMapClick);
  S.map = map;
  return new Promise((resolve) => map.on('load', resolve));
}

function addLayers(parcels, county) {
  const map = S.map;
  for (const [key, bm] of Object.entries(BASEMAPS)) {
    if (!bm.url) continue;
    map.addSource(`bm-${key}`, { type: 'raster', tiles: [bm.url], tileSize: 256, maxzoom: BASEMAP_MAXZOOM, attribution: 'USGS The National Map' });
    map.addLayer({ id: `bm-${key}`, type: 'raster', source: `bm-${key}`, layout: { visibility: 'none' } });
  }

  map.addSource('parcels', { type: 'geojson', data: parcels });
  const u = ['feature-state', 'u'];
  map.addLayer({
    id: 'parcels-fill', type: 'fill', source: 'parcels',
    paint: {
      'fill-color': ['case',
        ['==', u, 'allowed'], '#26b3a2',
        ['==', u, 'blocked'], '#e05555',
        ['match', ['get', 'c'], ['pf', 'ps'], '#4caf50', 't', '#9466c9', 'op', '#e07a4f', 'u', '#9aa0a6', '#e05555']],
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 15, 0.3, 18, 0.18],
    },
  });

  for (const [key, ov] of Object.entries(OVERLAYS)) {
    map.addSource(`ov-${key}`, { type: 'raster', tiles: [COUNTY_EXPORT + ov.layers], tileSize: 512, attribution: 'Klickitat County' });
    map.addLayer({ id: `ov-${key}`, type: 'raster', source: `ov-${key}`, layout: { visibility: 'none' } });
  }

  map.addLayer({
    id: 'parcels-line', type: 'line', source: 'parcels',
    paint: {
      'line-color': ['case',
        ['==', u, 'allowed'], '#0b7a6d',
        ['match', ['get', 'c'], ['pf', 'ps'], '#2b7a30', 't', '#6a3fa0', 'op', '#a8502b', 'u', '#5f6368', '#a83232']],
      'line-width': ['interpolate', ['linear'], ['zoom'],
        10, ['case', ['==', u, 'allowed'], 1.5, 0.3],
        14, ['case', ['==', u, 'allowed'], 3, 0.9],
        17, ['case', ['==', u, 'allowed'], 4.5, 1.8]],
    },
  });
  map.addLayer({
    id: 'parcel-selected', type: 'line', source: 'parcels', filter: ['==', ['id'], -1],
    paint: { 'line-color': '#1a73e8', 'line-width': 4 },
  });

  map.addSource('county', { type: 'geojson', data: county });
  map.addLayer({ id: 'county', type: 'line', source: 'county', paint: { 'line-color': '#333', 'line-width': 2, 'line-dasharray': [3, 2] } });

  map.addSource('measure', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'measure-fill', type: 'fill', source: 'measure', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#1a73e8', 'fill-opacity': 0.15 } });
  map.addLayer({ id: 'measure-line', type: 'line', source: 'measure', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#1a73e8', 'line-width': 3, 'line-dasharray': [2, 1] } });
  map.addLayer({ id: 'measure-pts', type: 'circle', source: 'measure', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': '#1a73e8', 'circle-stroke-width': 2 } });

  map.addSource('me', { type: 'geojson', data: emptyFC() });
  const meColor = ['match', ['get', 's'], 'green', STATUS_COLORS.green, 'yellow', STATUS_COLORS.yellow, 'red', STATUS_COLORS.red, STATUS_COLORS.gray];
  map.addLayer({ id: 'me-acc', type: 'fill', source: 'me', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': meColor, 'fill-opacity': 0.15 } });
  map.addLayer({ id: 'me-acc-line', type: 'line', source: 'me', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': meColor, 'line-width': 1.5, 'line-opacity': 0.7 } });
  map.addLayer({ id: 'me-dot', type: 'circle', source: 'me', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 10, 'circle-color': meColor, 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });

  applyLayerSettings();
  for (const pn of Object.keys(S.user.parcels)) syncFeatureState(pn);
}

function applyLayerSettings() {
  for (const key of Object.keys(BASEMAPS)) {
    if (BASEMAPS[key].url) S.map.setLayoutProperty(`bm-${key}`, 'visibility', S.settings.basemap === key ? 'visible' : 'none');
  }
  for (const key of Object.keys(OVERLAYS)) {
    S.map.setLayoutProperty(`ov-${key}`, 'visibility', S.settings.overlays[key] ? 'visible' : 'none');
  }
}

const emptyFC = () => ({ type: 'FeatureCollection', features: [] });

function parcelCenter(i) {
  const [x0, y0, x1, y1] = S.index.bbox[i];
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

function zoomToParcel(i) {
  const [x0, y0, x1, y1] = S.index.bbox[i];
  setFollowing(false);
  S.map.fitBounds([[x0, y0], [x1, y1]], {
    padding: { top: 90, left: 30, right: 70, bottom: Math.min(window.innerHeight * 0.5, 420) },
    maxZoom: 17, duration: 600,
  });
}

function select(i) {
  S.selected = i;
  S.map.setFilter('parcel-selected', ['==', ['id'], i ?? -1]);
}

function onMapClick(e) {
  if (S.measuring) {
    S.measurePts.push([e.lngLat.lng, e.lngLat.lat]);
    renderMeasure();
    return;
  }
  const hits = S.index.containing(e.lngLat.lng, e.lngLat.lat);
  if (!hits.length) { select(null); closeSheet(); return; }
  select(hits[0]);
  showParcel(hits[0]);
}

// ---------- location + status ----------

function startTracking() {
  if (!('geolocation' in navigator)) {
    S.geoError = 'This browser has no location access.';
    updateStatus();
    return;
  }
  if (S.watchId != null) return;
  S.tracking = true;
  S.geoError = null;
  S.watchId = navigator.geolocation.watchPosition(onFix, onGeoError, { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 });
  requestWakeLock();
  updateStatus();
}

function onFix(pos) {
  const { longitude: lon, latitude: lat, accuracy } = pos.coords;
  S.fix = { lon, lat, accFt: accuracy * FT_PER_M, t: Date.now() };
  S.geoError = null;
  updateStatus();
  if (S.following) {
    const opts = { center: [lon, lat], duration: 500 };
    if (S.firstFix) opts.zoom = Math.max(S.map.getZoom(), 15.5);
    S.map.easeTo(opts);
  }
  S.firstFix = false;
}

function onGeoError(err) {
  if (err.code === 1) {
    S.geoError = 'Location is blocked. Allow it in Settings › Privacy & Security › Location Services › Safari Websites (or this app).';
    navigator.geolocation.clearWatch(S.watchId);
    S.watchId = null;
    S.tracking = false;
  }
  updateStatus();
}

function setFollowing(on) {
  S.following = on;
  $('btn-locate').classList.toggle('following', on && S.tracking);
}

function accuracyCircle(lon, lat, radiusFt) {
  const { kx, ky } = feetPerDegree(lat);
  const ring = [];
  for (let k = 0; k <= 48; k++) {
    const a = (k / 48) * 2 * Math.PI;
    ring.push([lon + (Math.cos(a) * radiusFt) / kx, lat + (Math.sin(a) * radiusFt) / ky]);
  }
  return ring;
}

function updateStatus() {
  if (!S.ready) return;
  const r = computeStatus({ fix: S.fix, index: S.index, isOffLimits, isUnknown });
  S.status = r;
  renderBanner(r);
  if (S.fix) {
    const s = r.status;
    S.map.getSource('me').setData({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { s }, geometry: { type: 'Polygon', coordinates: [accuracyCircle(S.fix.lon, S.fix.lat, S.fix.accFt)] } },
        { type: 'Feature', properties: { s }, geometry: { type: 'Point', coordinates: [S.fix.lon, S.fix.lat] } },
      ],
    });
  }
  maybeAlert(r.status);
}

function placeLabel(i) {
  if (i == null) return 'Road, river, or unparceled gap';
  const pr = S.feats[i].properties;
  if (userState(pr.p) === 'allowed') return `Allowed · ${pr.o || pr.p}`;
  return pr.g || CLASS_INFO[pr.c].short;
}

function boundaryKind(i) {
  const pr = S.feats[i].properties;
  if (userState(pr.p) === 'blocked') return 'off-limits';
  return { p: 'private', t: 'tribal', op: 'off-limits', u: 'unclassified' }[pr.c] || 'off-limits';
}

function renderBanner(r) {
  const banner = $('banner');
  let title, sub = '';
  const acc = S.fix ? `±${Math.round(S.fix.accFt)} ft` : '';
  const age = S.fix ? (Date.now() - S.fix.t) / 1000 : 0;
  const stale = age > 60 ? ` · last fix ${Math.round(age / 60)} min ago` : '';
  let status = r.status;

  if (r.reason === 'nofix') {
    status = 'gray';
    if (S.geoError) { title = 'Location unavailable'; sub = S.geoError; }
    else if (S.tracking) { title = 'Finding your location…'; sub = 'Works best with a clear view of the sky'; }
    else { title = 'Location off'; sub = 'Tap the target button to start'; }
  } else if (r.reason === 'weak') {
    title = 'Weak GPS — status unknown';
    sub = `Accuracy ${acc}; need ±100 ft or better`;
  } else if (status === 'red') {
    const pr = S.feats[r.parcel].properties;
    title = userState(pr.p) === 'blocked' ? 'Marked off-limits' : CLASS_INFO[pr.c].short;
    sub = `${pr.o || 'Unknown owner'} · ${acc}`;
  } else if (r.reason === 'unclassified') {
    const pr = S.feats[r.parcel].properties;
    title = 'Unclassified parcel — check before entering';
    sub = `${pr.o || 'Unknown owner'} · ${acc}`;
  } else {
    const here = placeLabel(r.parcel);
    if (status === 'yellow') {
      title = `${fmtFt(r.nearest.distFt)} to ${boundaryKind(r.nearest.i)} boundary`;
      sub = `${here} · ${S.feats[r.nearest.i].properties.o || ''} · ${acc}`;
    } else {
      title = here;
      sub = r.nearest
        ? `${fmtFt(r.nearest.distFt)} to ${boundaryKind(r.nearest.i)} (${S.feats[r.nearest.i].properties.o || 'no owner listed'}) · ${acc}`
        : `No off-limits land within ¼ mi · ${acc}`;
    }
  }
  banner.className = status;
  $('banner-title').textContent = title;
  $('banner-sub').textContent = sub + stale;
}

const RANK = { green: 0, yellow: 1, red: 2 };
function maybeAlert(status) {
  if (!(status in RANK)) return;
  if (S.lastLevel === null ? status !== 'green' : RANK[status] > RANK[S.lastLevel]) alertUser(status);
  S.lastLevel = status;
}

function alertUser(status) {
  if (S.settings.vibrate && navigator.vibrate) navigator.vibrate(status === 'red' ? [300, 120, 300, 120, 300] : [200, 100, 200]);
  if (S.settings.sound) beep(status === 'red' ? [[1320, 0.18], [1320, 0.18], [1320, 0.18]] : [[880, 0.15], [880, 0.15]]);
}

function unlockAudio() {
  try {
    if (!S.audio) S.audio = new (window.AudioContext || window.webkitAudioContext)();
    if (S.audio.state === 'suspended') S.audio.resume();
  } catch { /* audio unsupported */ }
}

function beep(pattern) {
  const ctx = S.audio;
  if (!ctx) return;
  let t = ctx.currentTime + 0.02;
  for (const [freq, dur] of pattern) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
    t += dur + 0.09;
  }
}

async function requestWakeLock() {
  if (!S.settings.wake || !S.tracking || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try { S.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not allowed right now */ }
}

// ---------- sheet + panels ----------

function openSheet(title, ...body) {
  $('sheet-title').textContent = title;
  $('sheet-body').replaceChildren(...body.filter((el) => el != null && el !== false));
  $('sheet-body').scrollTop = 0;
  $('sheet').hidden = false;
}
function closeSheet() {
  $('sheet').hidden = true;
  select(null);
}

function classBadge(pr) {
  const u = userState(pr.p);
  const info = CLASS_INFO[pr.c];
  return h('div', { class: 'row' },
    h('span', { class: `badge ${info.badge}` }, info.name),
    u === 'allowed' && h('span', { class: 'badge allowed' }, 'Allowed'),
    u === 'blocked' && h('span', { class: 'badge private' }, 'Marked off-limits'));
}

function showParcel(i) {
  const pr = S.feats[i].properties;
  const entry = userEntry(pr.p);
  const u = userState(pr.p);
  const [lon, lat] = parcelCenter(i);
  const kv = (k, v) => (v || v === 0 ? [h('dt', null, k), h('dd', null, v)] : []);
  const use = pr.u ? `${pr.u}${USE_CODES[+pr.u] ? ` · ${USE_CODES[+pr.u]}` : ''}` : '';

  const actions = h('div', { class: 'row' });
  if (u === 'allowed') {
    actions.append(
      h('button', { class: 'btn', onclick: () => allowForm(i) }, 'Edit note'),
      h('button', { class: 'btn danger', onclick: () => { setUserMark(pr.p, null); showParcel(i); } }, 'Remove Allowed'));
  } else if (u === 'blocked') {
    actions.append(h('button', { class: 'btn', onclick: () => { setUserMark(pr.p, null); showParcel(i); } }, 'Clear off-limits mark'));
  } else {
    if (CLASS_INFO[pr.c].off || pr.c === 'u') actions.append(h('button', { class: 'btn primary', onclick: () => allowForm(i) }, 'Mark Allowed'));
    if (!CLASS_INFO[pr.c].off) {
      actions.append(h('button', { class: 'btn', onclick: () => { setUserMark(pr.p, { status: 'blocked', owner: pr.o }); showParcel(i); } }, 'Mark off-limits'));
    }
  }

  openSheet(pr.o || 'Unknown owner',
    classBadge(pr),
    pr.r && h('div', { class: 'note warn' }, `Flagged for review: ${pr.r}. Shown gray until you mark it.`),
    entry && entry.status === 'allowed' && h('div', { class: 'note' },
      entry.note ? `“${entry.note}”` : 'Allowed (no note)',
      entry.expires && h('div', { class: 'small' }, (u ? 'Expires ' : 'EXPIRED ') + entry.expires)),
    h('dl', { class: 'kv' },
      kv('Parcel #', pr.p),
      kv('Acres', pr.ac),
      kv('Agency', pr.g),
      kv('Mailing address', pr.a),
      kv('Legal', pr.l),
      kv('Land use', use),
      kv('Assessed land', pr.lv ? fmtMoney(pr.lv) : ''),
      kv('Improvements', pr.iv ? fmtMoney(pr.iv) : ''),
      kv('Total assessed', pr.v ? fmtMoney(pr.v) : '')),
    actions,
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('button', { class: 'btn', onclick: () => zoomToParcel(i) }, 'Zoom to parcel'),
      h('a', { class: 'btn', href: `${COUNTY_MAP}#17/${lat.toFixed(5)}/${lon.toFixed(5)}`, target: '_blank', rel: 'noopener' }, 'Open in county map')));
}

function allowForm(i) {
  const pr = S.feats[i].properties;
  const e = userEntry(pr.p) || {};
  const note = h('textarea', { placeholder: 'e.g. Permission from owner (J. Smith), Oct 2026' }, e.note || '');
  const expires = h('input', { type: 'date', value: e.expires || '' });
  openSheet(`Allow: ${pr.o || pr.p}`,
    h('p', { class: 'small' }, 'Allowed parcels are treated like public land: green inside, with yellow warnings near other off-limits edges.'),
    h('label', { class: 'field' }, 'Note (who gave permission, terms)'), note,
    h('label', { class: 'field' }, 'Expires (optional)'), expires,
    h('div', { class: 'row', style: 'margin-top:14px' },
      h('button', { class: 'btn primary', onclick: () => {
        setUserMark(pr.p, { status: 'allowed', note: note.value.trim(), expires: expires.value || '', owner: pr.o });
        showParcel(i);
      } }, 'Save'),
      h('button', { class: 'btn', onclick: () => showParcel(i) }, 'Cancel')));
  select(i);
}

function showSearch() {
  const input = h('input', { type: 'search', placeholder: 'Parcel #, owner, or address', autocomplete: 'off', enterkeyhint: 'search' });
  const results = h('ul', { class: 'list' });
  let timer;
  const run = () => {
    const q = input.value.trim().toUpperCase();
    const digits = q.replace(/[^0-9]/g, '');
    results.replaceChildren();
    if (q.length < 2) return;
    const out = [];
    for (let i = 0; i < S.feats.length && out.length < 60; i++) {
      const pr = S.feats[i].properties;
      if ((digits.length >= 4 && digits === q.replace(/[\s-]/g, '') && pr.p.includes(digits)) ||
          pr.o.includes(q) || pr.a.includes(q) || pr.l.includes(q)) out.push(i);
    }
    if (!out.length) results.append(h('li', { class: 'small' }, 'No matches'));
    for (const i of out) {
      const pr = S.feats[i].properties;
      results.append(h('li', { onclick: () => { select(i); zoomToParcel(i); showParcel(i); } },
        h('div', { class: 't' }, pr.o || '(no owner)'),
        h('div', { class: 's' }, `#${pr.p} · ${pr.ac ?? '?'} ac · ${CLASS_INFO[pr.c].short}`)));
    }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 150); });
  openSheet('Search parcels', input, results);
  setTimeout(() => input.focus(), 50);
}

function showLayers() {
  const radios = Object.entries(BASEMAPS).map(([key, bm]) =>
    h('label', { class: 'opt' },
      h('input', { type: 'radio', name: 'bm', checked: S.settings.basemap === key, onchange: () => { S.settings.basemap = key; saveSettings(); applyLayerSettings(); } }),
      bm.name));
  const checks = Object.entries(OVERLAYS).map(([key, ov]) =>
    h('label', { class: 'opt' },
      h('input', { type: 'checkbox', checked: !!S.settings.overlays[key], onchange: (e) => { S.settings.overlays[key] = e.target.checked; saveSettings(); applyLayerSettings(); } }),
      ov.name));

  const status = h('div', { class: 'small' });
  const bar = h('div', { class: 'progress' }, h('div'));
  const dlBtn = h('button', { class: 'btn primary' }, 'Download this area');
  const cancelBtn = h('button', { class: 'btn', hidden: true }, 'Cancel');
  const clearBtn = h('button', { class: 'btn danger' }, 'Delete downloaded maps');
  const refreshStorage = async () => {
    let msg = `Parcel data (${S.meta.count.toLocaleString()} parcels, built ${S.meta.built}) is always stored for offline use.`;
    try {
      const est = await navigator.storage.estimate();
      msg += ` Using ${(est.usage / 1e6).toFixed(0)} MB of storage.`;
    } catch { /* estimate unsupported */ }
    status.textContent = msg;
  };
  refreshStorage();

  dlBtn.onclick = async () => {
    const bm = BASEMAPS[S.settings.basemap];
    if (!bm.url) { toast('Pick a basemap first'); return; }
    const urls = tileUrlsForView(bm.url);
    if (urls.length > 6000) { toast(`That's ${urls.length.toLocaleString()} tiles — zoom in to a smaller area`); return; }
    dlBtn.disabled = true;
    cancelBtn.hidden = false;
    const ctrl = { cancelled: false };
    S.download = ctrl;
    cancelBtn.onclick = () => { ctrl.cancelled = true; };
    const done = await downloadTiles(urls, ctrl, (n) => {
      bar.firstChild.style.width = `${(100 * n) / urls.length}%`;
      status.textContent = `Downloading ${bm.name}: ${n.toLocaleString()} / ${urls.length.toLocaleString()} tiles`;
    });
    dlBtn.disabled = false;
    cancelBtn.hidden = true;
    S.download = null;
    toast(ctrl.cancelled ? 'Download cancelled' : `Saved ${done.toLocaleString()} tiles for offline use`);
    refreshStorage();
  };
  clearBtn.onclick = async () => {
    await caches.delete(TILE_CACHE);
    toast('Downloaded maps deleted');
    refreshStorage();
  };

  openSheet('Layers & offline',
    h('div', { class: 'section' }, 'Basemap'), ...radios,
    h('div', { class: 'section' }, 'County layers'), ...checks,
    h('p', { class: 'small' }, 'County layers need a connection; whatever you view is kept for offline use.'),
    h('div', { class: 'section' }, 'Offline maps'),
    h('p', { class: 'small' }, 'Saves the selected basemap for the area on screen (zoom levels down to ~10 ft detail). Do this on Wi-Fi before a trip.'),
    h('div', { class: 'row' }, dlBtn, cancelBtn, clearBtn), bar, status);
}

function tileUrlsForView(template) {
  const b = S.map.getBounds();
  const zMin = Math.max(8, Math.floor(S.map.getZoom()) - 3);
  const urls = [];
  const tx = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const ty = (lat, z) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
  };
  for (let z = zMin; z <= BASEMAP_MAXZOOM; z++) {
    for (let x = tx(b.getWest(), z); x <= tx(b.getEast(), z); x++) {
      for (let y = ty(b.getNorth(), z); y <= ty(b.getSouth(), z); y++) {
        urls.push(template.replace('{z}', z).replace('{x}', x).replace('{y}', y));
      }
    }
  }
  return urls;
}

async function downloadTiles(urls, ctrl, onProgress) {
  const cache = await caches.open(TILE_CACHE);
  let next = 0, n = 0, saved = 0;
  const worker = async () => {
    while (next < urls.length && !ctrl.cancelled) {
      const url = urls[next++];
      try {
        if (!(await cache.match(url, { ignoreVary: true }))) {
          const res = await fetch(url, { mode: 'cors' });
          if (res.ok) { await cache.put(url, res); saved++; }
        } else saved++;
      } catch { /* skip failed tile */ }
      onProgress(++n);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return saved;
}

function showAllowed() {
  const entries = Object.entries(S.user.parcels).sort((a, b) => (a[1].owner || '').localeCompare(b[1].owner || ''));
  const list = h('ul', { class: 'list' });
  if (!entries.length) list.append(h('li', { class: 'small' }, 'No parcels marked yet. Tap a parcel on the map, then “Mark Allowed”.'));
  for (const [pn, e] of entries) {
    const ids = S.byPn.get(pn);
    const expired = e.status === 'allowed' && e.expires && e.expires < today();
    list.append(h('li', { onclick: () => { if (ids) { select(ids[0]); zoomToParcel(ids[0]); showParcel(ids[0]); } else toast('Parcel not in current data'); } },
      h('div', { class: 't' }, `${e.status === 'blocked' ? '⛔ ' : ''}${e.owner || pn}`),
      h('div', { class: 's' }, `#${pn}${e.note ? ` · ${e.note}` : ''}${e.expires ? ` · ${expired ? 'EXPIRED' : 'expires'} ${e.expires}` : ''}${ids ? '' : ' · not found in data'}`)));
  }
  const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: importMarks });
  openSheet(`Allowed & marked (${entries.length})`, list,
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: exportMarks }, 'Export'),
      h('button', { class: 'btn', onclick: () => file.click() }, 'Import'), file),
    h('p', { class: 'small' }, 'Export saves your list as a file (keep it in iCloud Drive/Files) so you can restore it after reinstalling. Parcels are matched by parcel number.'));
}

async function exportMarks() {
  const body = JSON.stringify({ app: 'klickitat-parcels', version: 1, exported: new Date().toISOString(), parcels: S.user.parcels }, null, 1);
  const name = `klickitat-allowed-${today()}.json`;
  const file = new File([body], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Allowed parcels' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = h('a', { href: URL.createObjectURL(file), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function importMarks(e) {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const parcels = data.parcels || {};
    let n = 0;
    for (const [pn, entry] of Object.entries(parcels)) {
      if (!entry || !['allowed', 'blocked'].includes(entry.status)) continue;
      S.user.parcels[pn] = {
        status: entry.status, note: String(entry.note || ''), expires: String(entry.expires || ''),
        owner: String(entry.owner || ''), updated: String(entry.updated || today()),
      };
      syncFeatureState(pn);
      n++;
    }
    saveUser();
    updateStatus();
    toast(`Imported ${n} parcel${n === 1 ? '' : 's'}`);
    showAllowed();
  } catch {
    toast('That file is not a valid export');
  }
}

function showAbout() {
  const toggle = (key, label) => h('label', { class: 'opt' },
    h('input', { type: 'checkbox', checked: !!S.settings[key], onchange: (e) => {
      S.settings[key] = e.target.checked;
      saveSettings();
      if (key === 'wake') { if (e.target.checked) requestWakeLock(); else if (S.wakeLock) { S.wakeLock.release(); S.wakeLock = null; } }
    } }), label);
  const swatch = (fill, line, label) => h('li', null, h('span', { class: 'swatch', style: `background:${fill};border-color:${line}` }), label);
  const c = S.meta.classes;
  openSheet('About & settings',
    h('div', { class: 'section' }, 'Settings'),
    toggle('sound', 'Alert sound when entering yellow or red'),
    toggle('vibrate', 'Vibrate on alerts (Android only — iPhone web apps can’t vibrate)'),
    toggle('wake', 'Keep screen on while tracking'),
    h('button', { class: 'btn', onclick: () => { unlockAudio(); alertUser('red'); } }, 'Test alert'),
    h('p', { class: 'small' }, 'If you hear nothing, check the ringer/silent switch and volume.'),
    h('div', { class: 'section' }, 'Map colors'),
    h('ul', { class: 'legend-list' },
      swatch('#4caf5080', '#2b7a30', 'Public (state or federal)'),
      swatch('#26b3a280', '#0b7a6d', 'Allowed by you (bold outline)'),
      swatch('#e0555580', '#a83232', 'Private'),
      swatch('#e07a4f80', '#a8502b', 'County, city, district, WSDOT, BPA (off-limits by default)'),
      swatch('#9466c980', '#6a3fa0', 'Tribal / trust land'),
      swatch('#9aa0a680', '#5f6368', 'Unclassified (owner and PAD-US disagree)')),
    h('div', { class: 'section' }, 'Location dot'),
    h('ul', { class: 'legend-list' },
      h('li', null, h('span', { class: 'dot green' }), 'Public/allowed land, more than 50 ft (+GPS error) from off-limits'),
      h('li', null, h('span', { class: 'dot yellow' }), 'Within 50 ft (+GPS error) of an off-limits or unclassified edge'),
      h('li', null, h('span', { class: 'dot red' }), 'Inside off-limits land'),
      h('li', null, h('span', { class: 'dot gray' }), 'Weak GPS (worse than ±100 ft) or unclassified parcel')),
    h('p', { class: 'small' }, 'Gaps between parcels (roads, rivers) count as public.'),
    h('div', { class: 'section' }, 'Accuracy'),
    h('p', { class: 'warn' }, 'Navigation aid only, not a legal determination. County parcel lines are not surveys and can be 20–100+ ft off in rural areas; phone GPS adds error. Posted signs, fences, and survey markers take precedence.'),
    h('div', { class: 'section' }, 'Data'),
    h('p', { class: 'small' },
      `Built ${S.meta.built} from Klickitat County GIS (${S.meta.count.toLocaleString()} parcels). Public land is classified from owner names and cross-checked against USGS PAD-US 3.0. `,
      `Federal ${c.public_federal || 0}, state ${c.public_state || 0}, tribal ${c.tribal || 0}, other public ${c.other_public || 0}, private ${c.private || 0}, unclassified ${c.unknown || 0}.`),
    h('div', { class: 'section' }, 'Install & limits'),
    h('p', { class: 'small' }, 'In Safari, tap Share › Add to Home Screen. Open it once on Wi-Fi so everything is saved; after that it works with no signal. Alerts only work while the app is open on screen — iPhone pauses web apps when the screen locks.'));
}

function toast(msg, action) {
  const t = $('toast');
  t.replaceChildren(msg);
  if (action) {
    t.append(' ', h('button', { class: 'btn', style: 'margin-left:8px;padding:4px 10px', onclick: action.fn }, action.label));
  }
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, action ? 15000 : 3500);
}

// ---------- measure ----------

function segFt(a, b) {
  const { kx, ky } = feetPerDegree((a[1] + b[1]) / 2);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * ky);
}

function renderMeasure() {
  const pts = S.measurePts;
  const features = pts.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }));
  if (pts.length >= 2) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } });
  let text = 'Tap the map to add points';
  if (pts.length >= 2) {
    let d = 0;
    for (let k = 1; k < pts.length; k++) d += segFt(pts[k - 1], pts[k]);
    text = `Distance ${fmtFt(d)}`;
  }
  if (pts.length >= 3) {
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] } });
    const { kx, ky } = feetPerDegree(pts[0][1]);
    let a = 0;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k], q = pts[(k + 1) % pts.length];
      a += (p[0] * kx) * (q[1] * ky) - (q[0] * kx) * (p[1] * ky);
    }
    const acres = Math.abs(a) / 2 / 43560;
    text += ` · Area ${acres < 10 ? acres.toFixed(2) : acres.toFixed(1)} ac`;
  }
  $('measure-text').textContent = text;
  S.map.getSource('measure').setData({ type: 'FeatureCollection', features });
}

function setMeasuring(on) {
  S.measuring = on;
  $('measure-bar').hidden = !on;
  $('btn-measure').classList.toggle('active', on);
  S.measurePts = [];
  renderMeasure();
  if (on) closeSheet();
}

// ---------- boot ----------

function wireUi() {
  $('sheet-close').onclick = closeSheet;
  $('btn-search').onclick = showSearch;
  $('btn-layers').onclick = showLayers;
  $('btn-allowed').onclick = showAllowed;
  $('btn-about').onclick = showAbout;
  $('btn-measure').onclick = () => setMeasuring(!S.measuring);
  $('measure-undo').onclick = () => { S.measurePts.pop(); renderMeasure(); };
  $('measure-clear').onclick = () => { S.measurePts = []; renderMeasure(); };
  $('measure-done').onclick = () => setMeasuring(false);
  $('btn-locate').onclick = () => {
    unlockAudio();
    if (!S.tracking) startTracking();
    setFollowing(true);
    if (S.fix) S.map.easeTo({ center: [S.fix.lon, S.fix.lat], zoom: Math.max(S.map.getZoom(), 15.5), duration: 500 });
  };
  $('banner').onclick = () => {
    const r = S.status;
    const i = r && (r.parcel ?? r.nearest?.i);
    if (i != null) { select(i); showParcel(i); }
  };
  $('intro-start').onclick = () => {
    unlockAudio();
    S.settings.introSeen = true;
    saveSettings();
    $('intro').hidden = true;
    startTracking();
  };
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { requestWakeLock(); updateStatus(); }
  });
  setInterval(() => { if (S.status && S.fix) renderBanner(S.status); }, 15000);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('App or map data updated.', { label: 'Reload', fn: () => location.reload() });
  });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

async function main() {
  wireUi();
  registerServiceWorker();
  const mapReady = initMap();
  const [parcels, county, meta] = await Promise.all(
    ['data/parcels.json', 'data/county.json', 'data/meta.json'].map((u) => fetch(u).then((r) => {
      if (!r.ok) throw new Error(`${u}: ${r.status}`);
      return r.json();
    })));
  S.meta = meta;
  S.feats = parcels.features;
  S.index = new ParcelIndex(S.feats);
  S.feats.forEach((f, i) => {
    const list = S.byPn.get(f.properties.p);
    if (list) list.push(i); else S.byPn.set(f.properties.p, [i]);
  });
  await mapReady;
  addLayers(parcels, county);
  S.ready = true;
  if (S.settings.introSeen) startTracking();
  else $('intro').hidden = false;
  updateStatus();
}

main().catch((err) => {
  $('banner').className = 'gray';
  $('banner-title').textContent = 'Could not load the map';
  $('banner-sub').textContent = `${err.message}. Open once with a connection to save it for offline use.`;
});
