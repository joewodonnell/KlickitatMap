export const FT_PER_M = 3.28084;

export function feetPerDegree(lat) {
  const r = (lat * Math.PI) / 180;
  const latM = 111132.92 - 559.82 * Math.cos(2 * r) + 1.175 * Math.cos(4 * r);
  const lonM = 111412.84 * Math.cos(r) - 93.5 * Math.cos(3 * r);
  return { kx: lonM * FT_PER_M, ky: latM * FT_PER_M };
}

function polygonsOf(geometry) {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function bboxOf(polygons) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polygons) {
    for (const [x, y] of poly[0]) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygons(x, y, polygons) {
  for (const poly of polygons) {
    if (!inRing(x, y, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) {
      if (inRing(x, y, poly[h])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

export function distanceToEdgesFt(lon, lat, polygons) {
  const { kx, ky } = feetPerDegree(lat);
  let best = Infinity;
  for (const poly of polygons) {
    for (const ring of poly) {
      for (let i = 1; i < ring.length; i++) {
        const ax = (ring[i - 1][0] - lon) * kx, ay = (ring[i - 1][1] - lat) * ky;
        const bx = (ring[i][0] - lon) * kx, by = (ring[i][1] - lat) * ky;
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const px = ax + t * dx, py = ay + t * dy;
        const d = px * px + py * py;
        if (d < best) best = d;
      }
    }
  }
  return Math.sqrt(best);
}

export class ParcelIndex {
  constructor(features, cellDeg = 0.01) {
    this.cell = cellDeg;
    this.polys = new Array(features.length);
    this.bbox = new Array(features.length);
    this.grid = new Map();
    features.forEach((f, i) => {
      const polys = polygonsOf(f.geometry);
      const bb = bboxOf(polys);
      this.polys[i] = polys;
      this.bbox[i] = bb;
      const [x0, y0, x1, y1] = this.cellRange(bb);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const key = cx * 100000 + cy;
          let list = this.grid.get(key);
          if (!list) this.grid.set(key, (list = []));
          list.push(i);
        }
      }
    });
  }

  cellRange([minX, minY, maxX, maxY]) {
    const c = this.cell;
    return [Math.floor(minX / c), Math.floor(minY / c), Math.floor(maxX / c), Math.floor(maxY / c)];
  }

  candidates(minX, minY, maxX, maxY) {
    const out = new Set();
    const [x0, y0, x1, y1] = this.cellRange([minX, minY, maxX, maxY]);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const list = this.grid.get(cx * 100000 + cy);
        if (!list) continue;
        for (const i of list) {
          const b = this.bbox[i];
          if (b[0] <= maxX && b[2] >= minX && b[1] <= maxY && b[3] >= minY) out.add(i);
        }
      }
    }
    return out;
  }

  containing(lon, lat) {
    const hits = [];
    for (const i of this.candidates(lon, lat, lon, lat)) {
      if (pointInPolygons(lon, lat, this.polys[i])) hits.push(i);
    }
    return hits;
  }

  near(lon, lat, radiusFt) {
    const { kx, ky } = feetPerDegree(lat);
    const dx = radiusFt / kx, dy = radiusFt / ky;
    return this.candidates(lon - dx, lat - dy, lon + dx, lat + dy);
  }
}

/**
 * fix: {lon, lat, accFt} or null. isOffLimits/isUnknown: (parcelIndex) => boolean.
 * Returns {status: 'green'|'yellow'|'red'|'gray', reason, parcel, nearest: {i, distFt}|null}.
 */
export function computeStatus({ fix, index, isOffLimits, isUnknown, bufferFt = 50, maxAccFt = 100, lookFt = 1320 }) {
  if (!fix) return { status: 'gray', reason: 'nofix', parcel: null, nearest: null };
  if (fix.accFt > maxAccFt) return { status: 'gray', reason: 'weak', parcel: null, nearest: null };

  const inside = index.containing(fix.lon, fix.lat);
  const off = inside.find(isOffLimits);
  if (off !== undefined) return { status: 'red', reason: 'inside', parcel: off, nearest: null };
  const unk = inside.find(isUnknown);
  if (unk !== undefined) return { status: 'gray', reason: 'unclassified', parcel: unk, nearest: null };

  const warnFt = bufferFt + fix.accFt;
  let nearest = null;
  for (const i of index.near(fix.lon, fix.lat, Math.max(warnFt, lookFt))) {
    if (!isOffLimits(i) && !isUnknown(i)) continue;
    const d = distanceToEdgesFt(fix.lon, fix.lat, index.polys[i]);
    if (!nearest || d < nearest.distFt) nearest = { i, distFt: d };
  }
  const parcel = inside.length ? inside[0] : null;
  if (nearest && nearest.distFt <= warnFt) return { status: 'yellow', reason: 'near', parcel, nearest };
  return { status: 'green', reason: parcel === null ? 'gap' : 'public', parcel, nearest };
}
