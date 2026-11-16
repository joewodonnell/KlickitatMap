import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ParcelIndex, computeStatus, feetPerDegree, distanceToEdgesFt } from '../docs/engine.js';

const LAT = 45.8, LON = -121.0;
const { kx, ky } = feetPerDegree(LAT);
const ft = (dxFt, dyFt) => [LON + dxFt / kx, LAT + dyFt / ky];
const square = (x0, y0, x1, y1, holes = []) => ({
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [[ft(x0, y0), ft(x1, y0), ft(x1, y1), ft(x0, y1), ft(x0, y0)], ...holes] },
});

// public 0..1000 ft, private 1000..2000 ft, road gap 2000..2100 ft, private 2100..3000 ft
const features = [
  square(0, 0, 1000, 1000),
  square(1000, 0, 2000, 1000),
  square(2100, 0, 3000, 1000),
  square(0, 2000, 1000, 3000, [[ft(400, 2400), ft(600, 2400), ft(600, 2600), ft(400, 2600), ft(400, 2400)]]),
];
const index = new ParcelIndex(features);
const offLimits = new Set([1, 2, 3]);
const status = (dx, dy, accFt = 16, opts = {}) => {
  const [lon, lat] = ft(dx, dy);
  return computeStatus({
    fix: { lon, lat, accFt }, index,
    isOffLimits: (i) => offLimits.has(i) && !(opts.allowed || []).includes(i),
    isUnknown: (i) => (opts.unknown || []).includes(i),
  });
};

test('distance math is in feet', () => {
  const [lon, lat] = ft(500, 500);
  assert.ok(Math.abs(distanceToEdgesFt(lon, lat, [features[0].geometry.coordinates]) - 500) < 1);
});

test('deep in public land is green', () => assert.equal(status(300, 500).status, 'green'));
test('public land near private edge is yellow', () => assert.equal(status(950, 500).status, 'yellow'));
test('yellow band grows with GPS accuracy', () => {
  assert.equal(status(900, 500, 10).status, 'green');
  assert.equal(status(900, 500, 60).status, 'yellow');
});
test('inside private is red', () => assert.equal(status(1500, 500).status, 'red'));
test('allowed private parcel behaves like public', () => {
  assert.equal(status(1500, 500, 16, { allowed: [1] }).status, 'green');
  assert.equal(status(1990, 500, 16, { allowed: [1] }).status, 'green');
  assert.equal(status(1990, 500, 90, { allowed: [1] }).status, 'yellow');
});
test('road gap counts as public but warns near edges', () => {
  const s = status(2050, 500);
  assert.equal(s.status, 'yellow');
  assert.equal(s.parcel, null);
  assert.equal(status(500, 1500).status, 'green');
});
test('weak or missing GPS is gray', () => {
  assert.equal(status(300, 500, 150).status, 'gray');
  assert.equal(computeStatus({ fix: null, index, isOffLimits: () => false, isUnknown: () => false }).status, 'gray');
});
test('unclassified parcel is gray, and warns when nearby', () => {
  assert.equal(status(300, 500, 16, { unknown: [0] }).status, 'gray');
  assert.equal(status(1500, 500, 16, { allowed: [1], unknown: [2] }).status, 'green');
  assert.equal(status(1990, 500, 90, { allowed: [1], unknown: [2] }).status, 'yellow');
});
test('holes in a private parcel are not private', () => {
  assert.equal(status(300, 2500).status, 'red');
  assert.equal(status(500, 2500).status, 'green');
});

test('real county data: DNR interior is not red, private interior is red', () => {
  const data = JSON.parse(readFileSync(new URL('../docs/data/parcels.json', import.meta.url), 'utf8'));
  const real = new ParcelIndex(data.features);
  const off = (i) => ['p', 'op', 't'].includes(data.features[i].properties.c);
  const unk = (i) => data.features[i].properties.c === 'u';
  const interior = (cls) => {
    for (let i = 0; i < data.features.length; i++) {
      const f = data.features[i];
      if (f.properties.c !== cls || !(f.properties.ac > 200)) continue;
      const [x0, y0, x1, y1] = real.bbox[i];
      const lon = (x0 + x1) / 2, lat = (y0 + y1) / 2;
      if (real.containing(lon, lat).length === 1 && real.containing(lon, lat)[0] === i) return { lon, lat };
    }
  };
  for (const [cls, expected] of [['ps', ['green', 'yellow']], ['p', ['red']]]) {
    const fix = { ...interior(cls), accFt: 20 };
    const s = computeStatus({ fix, index: real, isOffLimits: off, isUnknown: unk });
    assert.ok(expected.includes(s.status), `${cls} -> ${s.status}`);
  }
});
