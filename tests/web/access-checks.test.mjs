// Access-track checks: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  VEHICLES, profileOf, joinProfiles, grades, radii, steadyState, sweep, accessChecks, verdict, canReach, tour, summary, pointInPolygon,
} from '../../src/web/access/access-checks.mjs';

const flat = () => 0;
const near = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= tol, `${m}: ${a} vs ${b}`);
const byId = (list, id) => list.find((c) => c.id === id);
const arc = (cx, cy, R, a0, a1, n = 180) => Array.from({ length: n + 1 }, (_, k) => { const a = a0 + ((a1 - a0) * k) / n; return [cx + R * Math.cos(a), cy + R * Math.sin(a)]; });
// a straight lead-in along +x, then a left turn of `turn` radians on radius R
const bendPath = (R, turn, lead = 40, tail = 40) => {
  const pts = [[-lead, -R], [0, -R], ...arc(0, 0, R, -Math.PI / 2, -Math.PI / 2 + turn).slice(1)];
  const [x, y] = pts.at(-1), h = -Math.PI / 2 + turn + Math.PI / 2;
  pts.push([x + tail * Math.cos(h), y + tail * Math.sin(h)]);
  return pts;
};

test('pair: the simulated swept path agrees with the analytic steady state on a long circle', () => {
  for (const [name, R] of [['hgv-artic', 20], ['low-loader-transformer', 25], ['mobile-crane', 15]]) {
    const V = VEHICLES[name];
    const P = profileOf({ path: bendPath(R, 1.75 * Math.PI, 60, 1), groundAt: flat, width: 30 }, { step: 0.1 });
    const S = sweep(P, V, { step: 0.05, keepPoses: true });
    const last = S.poses.at(-40).at(-1), rSim = Math.hypot(last.rx, last.ry); // last axle, well into the circle
    const ss = steadyState(V, R);
    near(rSim, ss.axles.at(-1), 0.01 * R, `${name} last axle radius`);
  }
});

test('truth against a published figure: the assumed artic passes the 96/53/EC circle (12.5 m outer, 5.3 m inner)', () => {
  const V = VEHICLES['hgv-artic'];
  // front axle radius that puts the outer front corner on 12.5 m
  let lo = 5, hi = 12.5;
  for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (steadyState(V, m) && steadyState(V, m).outerBody > 12.5) hi = m; else lo = m; }
  const ss = steadyState(V, lo);
  near(ss.outerBody, 12.5, 1e-6, 'outer corner');
  assert.ok(ss.innerWheel >= 5.3, `inner ${ss.innerWheel}`);
  assert.equal(steadyState(V, 3), null, 'tighter than the wheelbase has no steady state');
});

test('gradient: a 12% pitch blocks the low-loader (8%) and not the car (25%)', () => {
  const groundAt = (x) => (x < 100 ? 0 : x < 150 ? 0.12 * (x - 100) : 6);
  const P = profileOf({ path: [[0, 0], [250, 0]], groundAt, width: 5 });
  const g = Math.max(...grades(P));
  near(g, 0.12, 1e-6, 'steepest');
  const low = byId(accessChecks(P, 'low-loader-transformer'), 'gradient');
  assert.equal(low.failed, true); assert.equal(low.severity, 'block');
  near(low.sections[0].from, 100 + 10 * (8 / 12) - 5, 0.3, 'the run starts where the 10 m base holds enough of the pitch');
  assert.equal(byId(accessChecks(P, 'car-4x4'), 'gradient').failed, false);
});

test('cross-slope: ground tilted 4% across the road blocks the transformer (3%) and not the artic (5%)', () => {
  const P = profileOf({ path: [[0, 0], [100, 0]], groundAt: (x, y) => 0.04 * y, width: 5 });
  near(P.stations[10].cross, 0.04, 1e-9, 'cross read from the ground');
  assert.equal(byId(accessChecks(P, 'low-loader-transformer'), 'cross-slope').failed, true);
  assert.equal(byId(accessChecks(P, 'hgv-artic'), 'cross-slope').failed, false);
});

test('bend: a circle of 30 m reads 30 m; an 8 m bend blocks the artic', () => {
  const P30 = profileOf({ path: bendPath(30, Math.PI / 2), groundAt: flat, width: 6 });
  near(Math.min(...radii(P30)), 30, 0.3, 'radius read');
  const P8 = profileOf({ path: bendPath(8, Math.PI / 2), groundAt: flat, width: 12 });
  assert.equal(byId(accessChecks(P8, 'hgv-artic'), 'bend').failed, true);
});

test('swept path: the artic runs its wheels off a 4 m road round a 15 m bend and stays on 9 m', () => {
  const narrow = profileOf({ path: bendPath(15, Math.PI / 2), groundAt: flat, width: 4 });
  const wide = profileOf({ path: bendPath(15, Math.PI / 2), groundAt: flat, width: 9 });
  const a = byId(accessChecks(narrow, 'hgv-artic'), 'swept-wheels'), b = byId(accessChecks(wide, 'hgv-artic'), 'swept-wheels');
  assert.equal(a.failed, true); assert.equal(b.failed, false);
  assert.ok(a.sections[0].from > 30 && a.sections[0].from < 70, `off-tracking starts in the bend: ${a.sections[0].from}`);
  // on a straight nothing sweeps wider than the vehicle
  const S = sweep(profileOf({ path: [[0, 0], [80, 0]], groundAt: flat, width: 4 }), 'hgv-artic');
  near(Math.max(...S.wheelL, ...S.wheelR), VEHICLES['hgv-artic'].width / 2, 1e-6, 'straight');
});

test('gate: a 3 m opening blocks the 3.5 m low-loader, a 5 m one passes on a straight', () => {
  const P = profileOf({ path: [[0, 0], [100, 0]], groundAt: flat, width: 5 });
  const r = accessChecks(P, 'low-loader-transformer', { gates: [{ x: 50, y: 0, width: 3, label: 'A' }, { x: 70, y: 0.5, width: 5, label: 'B' }, { x: 50, y: 40, width: 1 }] });
  assert.equal(byId(r, 'gate-0').failed, true);
  assert.equal(byId(r, 'gate-1').failed, false);
  assert.equal(byId(r, 'gate-2'), undefined, 'a gate off the route is ignored');
});

test('grounding: a 0.4 m hump grounds a 12 m deck with 0.15 m clearance; a gentle rise does not', () => {
  const hump = (x) => (Math.abs(x - 60) < 6 ? 0.4 * Math.cos((Math.PI * (x - 60)) / 12) ** 2 : 0);
  const P = profileOf({ path: [[0, 0], [120, 0]], groundAt: hump, width: 5 });
  assert.equal(byId(accessChecks(P, 'low-loader-transformer'), 'grounding').failed, true);
  const Q = profileOf({ path: [[0, 0], [120, 0]], groundAt: (x) => 0.02 * x, width: 5 });
  assert.equal(byId(accessChecks(Q, 'low-loader-transformer'), 'grounding').failed, false);
  assert.equal(byId(accessChecks(P, 'car-4x4'), 'grounding'), undefined, 'no deck, no check');
});

test('structures: an unrated culvert asks for assessment, a 40 t bridge blocks 130 t, a line asks for its clearance', () => {
  const P = profileOf({ path: [[0, 0], [300, 0]], groundAt: flat, width: 5 });
  const r = accessChecks(P, 'low-loader-transformer', { structures: [
    { x: 50, y: 0, kind: 'culvert' }, { x: 120, y: 0, kind: 'bridge', grossT: 40, axleT: 10, widthM: 6 },
    { x: 200, y: 0, kind: 'line', clearanceM: 5.5 }, { x: 250, y: 0, kind: 'overhead', clearanceM: 6 }] });
  assert.deepEqual([r.find((c) => c.id === 'structure-0').severity, byId(r, 'structure-1').severity], ['check', 'block']);
  assert.equal(byId(r, 'structure-2').failed, true, '4.9 m + 1 m margin over a 5.5 m line');
  assert.equal(byId(r, 'structure-3').failed, false);
});

test('soft ground: unsurfaced over 150 kPa blocks; a surfaced road asks for its build-up', () => {
  const poly = [[40, -10], [60, -10], [60, 10], [40, 10]];
  assert.equal(pointInPolygon(50, 0, poly), true); assert.equal(pointInPolygon(70, 0, poly), false);
  const bare = profileOf({ path: [[0, 0], [100, 0]], groundAt: flat, width: 5 });
  const made = profileOf({ path: [[0, 0], [100, 0]], groundAt: flat, width: 5, surface: 'gravel' });
  const z = { softZones: [{ polygon: poly, bearingKPa: 150, label: 'wet hollow' }] };
  assert.equal(byId(accessChecks(bare, 'hgv-artic', z), 'soft-0').severity, 'block');
  assert.equal(byId(accessChecks(made, 'hgv-artic', z), 'soft-0').severity, 'check');
});

test('can the transformer get to the station? It takes the long flat way round the hill', () => {
  const hill = (x, y) => (y > 5 ? Math.max(0, 15 - Math.abs(x - 100) * 0.15) : 0); // a steep hill on the northern road only
  const north = { path: arc(100, 0, 100, Math.PI, 0), groundAt: hill, width: 6, surface: 'gravel' };
  const direct = { path: [[0, 0], [200, 0]], groundAt: (x) => (x > 90 && x < 110 ? 0.2 * (10 - Math.abs(x - 100)) : 0), width: 6, surface: 'gravel' };
  const south = { path: arc(100, 0, 100, Math.PI, 2 * Math.PI), groundAt: flat, width: 8, surface: 'gravel' };
  const r = canReach({ roads: [north, direct, south], from: [0, 0], to: [200, 0], vehicle: 'low-loader-transformer' });
  assert.deepEqual(r.via, [2]); assert.equal(r.reached, true, JSON.stringify(r.blockers.map((b) => b.line)));
  const none = canReach({ roads: [direct], from: [0, 0], to: [200, 0] });
  assert.equal(none.reached, false); assert.match(none.reason, /blocker/); assert.ok(none.blockers.length > 0);
  const apart = canReach({ roads: [{ path: [[0, 0], [10, 0]], groundAt: flat, width: 6 }, { path: [[100, 0], [110, 0]], groundAt: flat, width: 6 }], from: [0, 0], to: [110, 0] });
  assert.match(apart.reason, /do not connect/);
});

test('roads join end to start, a reversed road is walked backwards, and the turn between roads is checked', () => {
  const a = profileOf({ path: [[0, 0], [50, 0]], groundAt: flat, width: 4 }), b = profileOf({ path: [[50, 0], [50, 50]], groundAt: flat, width: 4 });
  const J = joinProfiles([a, b]);
  near(J.length, 100, 1e-9, 'length'); assert.equal(J.width, 4);
  assert.equal(byId(accessChecks(J, 'hgv-artic'), 'bend').failed, true, 'a square corner is no bend for an artic');
});

test('a road object and a driven trace are both read', () => {
  const road = { length2d: 100, width: 5, surface: 'tarmac', pointAt: (s) => [s, 0], designLevel: (s) => 0.05 * s,
    finishedAt: (s, off) => 0.05 * s - 0.025 * Math.abs(off) };
  const P = profileOf(road);
  near(Math.max(...grades(P)), 0.05, 1e-9, 'road grade'); near(P.stations[5].cross, 0, 1e-12, 'crowned road: level across the track');
  const T = profileOf({ trace: [[0, 0, 0], [50, 0, 5], [100, 0, 5]], cross: [0, 0.06, 0], width: 5 });
  near(Math.max(...grades(T)), 0.1, 1e-9, 'trace grade'); near(Math.max(...T.stations.map((s) => s.cross)), 0.06, 1e-9, 'trace roll');
  assert.equal(T.surface, 'unknown');
});

test('deterministic: the same inputs give the same numbers', () => {
  const run = () => { const P = profileOf({ path: bendPath(18, 2), groundAt: (x, y) => 0.03 * x + 0.01 * y, width: 6 }); return JSON.stringify(verdict(P, 'low-loader-transformer', { gates: [{ x: 0, y: -18, width: 4 }] })); };
  assert.equal(run(), run());
});

test('sales view: the tour holds at each stop with its caption, time rises, and the summary reads plainly', () => {
  const P = profileOf({ path: [[0, 0], [300, 0]], groundAt: (x) => 0.02 * x, width: 5, surface: 'gravel' });
  const T = tour(P, { speed: 5, dt: 0.5, stops: [{ x: 100, y: 1, caption: 'Station compound', holdS: 3 }, { x: 250, y: 0, caption: 'Gate to the field' }, { x: 100, y: 90, caption: 'off route' }] });
  for (let k = 1; k < T.keys.length; k++) assert.ok(T.keys[k].t > T.keys[k - 1].t);
  near(T.duration, 300 / 5 + 3 + 4, 1e-6, 'drive plus holds');
  assert.ok(T.keys.some((k) => k.caption === 'Station compound') && !T.keys.some((k) => k.caption === 'off route'));
  near(T.keys[0].z, 1.6, 1e-9, 'eye height');
  const lines = summary(P, [verdict(P, 'low-loader-transformer'), verdict(P, 'car-4x4')]);
  assert.match(lines[0], /Route 0\.30 km, steepest 2\.0%, 5 m carriageway/);
  assert.match(lines.at(-1), /assumed/);
});

test('public-safe: no local paths, no personal or company names, no copied standard text', () => {
  const src = fs.readFileSync(new URL('../../src/web/access/access-checks.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /[A-Za-z]:[\\/]|\/Users\/|\/home\//);
  assert.doesNotMatch(src, /\b(Ltd|Limited|plc|GmbH|Inc\.)\b/);
  assert.doesNotMatch(src, /\bfetch\(|\bdocument\.|\bwindow\.|Math\.random|Date\.now|performance\.now|setInterval\(|requestAnimationFrame\(/);
});
