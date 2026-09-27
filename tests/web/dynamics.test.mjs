import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRESETS, PRESET_NAMES } from '../../src/web/engine/vehicle-presets.mjs';
import { geometry, spinStiffness, steerAngles, spawn, step, derivative, pose, isParked, createDriver, DT, G }
  from '../../src/web/engine/vehicle-dynamics.mjs';
import { goldenRuns } from '../../tools/golden-dynamics.mjs';

const flat = () => 0;
const slope10 = (x, y) => 0.1 * y;                  // rises 10 % to the north
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const run = (y, geo, ground, input, seconds, method) => {
  const f = typeof input === 'function' ? input : () => input;
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) step(y, f(i * DT, y), geo, ground, method);
  return y;
};
const speed = y => Math.hypot(y[6], y[7]);
const METHODS = ['euler', 'rk4'];

test('presets: complete, positive, and the JSON the Python mirror reads is identical', () => {
  const keys = Object.keys(PRESETS['site-buggy']);
  for (const [name, p] of Object.entries(PRESETS)) {
    assert.deepEqual(Object.keys(p), keys, name);
    for (const k of keys) if (typeof p[k] === 'number') assert.ok(p[k] > 0 && Number.isFinite(p[k]), `${name}.${k}`);
    assert.ok(p.basis.length > 20, name);
    assert.ok(p.mass * G * Math.max(p.frontLoadFraction, 1 - p.frontLoadFraction) / 2 / p.springRate < p.travel,
      `${name}: static sag inside the travel`);
  }
  const json = JSON.parse(readFileSync(new URL('../../src/cartridges/dynamics/presets.json', import.meta.url), 'utf8'));
  assert.deepEqual(json, JSON.parse(JSON.stringify(PRESETS)));
  near(PRESETS['site-buggy'].turningCircle, 7, 0.5, 'site buggy turning circle about 7 m');
});

test('stability: every preset keeps the wheel-spin stiffness inside the explicit limit at DT', () => {
  for (const name of PRESET_NAMES) assert.ok(spinStiffness(name) * DT < 1.5, `${name}: ${spinStiffness(name).toFixed(0)} 1/s`);
});

test('Ackermann: every wheel axis passes through one turn centre; inner wheel steers more', () => {
  for (const name of PRESET_NAMES) {
    const geo = geometry(name);
    for (const steer of [1, 0.4, -0.7]) {
      const d = steerAngles(geo, steer), R = 1 / (steer * geo.maxCurvature);
      for (let i = 0; i < 4; i++) {
        // the wheel's right-pointing axis from its contact must reach the centre (steerCentre, R)
        const ex = geo.steerCentre - geo.s[i], ey = R - geo.l[i];
        const cross = Math.sin(d[i]) * ey + Math.cos(d[i]) * ex;          // forward dir (cos d, sin d) · (ex, ey)
        near(cross / Math.hypot(ex, ey), 0, 1e-12, `${name} wheel ${i} steer ${steer}`);
      }
      const inner = steer > 0 ? 1 : 0, outer = 1 - inner;
      assert.ok(Math.abs(d[inner]) > Math.abs(d[outer]), `${name} inner > outer`);
    }
    assert.ok(Array.from(steerAngles(geo, 0)).every(v => v === 0), `${name} straight ahead`);
  }
  const crane = steerAngles(geometry('mobile-crane'), 1);
  assert.ok(crane[0] > 0 && crane[2] < 0, 'crane rear wheels counter-steer');
});

test('rest: settles at design height with the static load split, both integrators', () => {
  for (const name of PRESET_NAMES) for (const m of METHODS) {
    const geo = geometry(name), y = run(spawn(geo, flat), geo, flat, {}, 3, m);
    near(y[2], geo.p.cgHeight, 1e-3, `${name} ${m} height`);
    near(y[3], 0, 1e-6, `${name} ${m} roll`); near(y[4], 0, 1e-4, `${name} ${m} pitch`);
    const diag = new Float64Array(24);
    derivative(y, {}, geo, flat, new Float64Array(16), diag);
    const N = [0, 6, 12, 18].map(o => diag[o]);
    near(N.reduce((a, b) => a + b, 0), geo.p.mass * G, 1e-3 * geo.p.mass * G, `${name} ${m} total load`);
    for (let i = 0; i < 4; i++) near(N[i], geo.staticLoad[i], 5e-3 * geo.staticLoad[i], `${name} ${m} wheel ${i}`);
  }
});

test('turning circle at full lock matches the preset within 2 %, both integrators', () => {
  for (const name of PRESET_NAMES) for (const m of METHODS) {
    const geo = geometry(name), y = spawn(geo, flat);
    let xs = [], ys = [];
    run(y, geo, flat, (t, s) => ({ throttle: speed(s) < 1.5 ? 0.3 : 0, brake: speed(s) > 1.7 ? 0.1 : 0, steer: 1 }), 20, m);
    const P = geo.p.turningCircle * Math.PI / 1.5;             // one lap at about 1.5 m/s
    run(y, geo, flat, (t, s) => {
      if (Math.round(t / DT) % 50 === 0) { const w = pose(s, geo, flat).wheels[0]; xs.push(w.x); ys.push(w.y); }
      return { throttle: speed(s) < 1.5 ? 0.3 : 0, brake: speed(s) > 1.7 ? 0.1 : 0, steer: 1 };
    }, P * 1.2, m);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    const d = 2 * xs.reduce((a, x, i) => a + Math.hypot(x - cx, ys[i] - cy), 0) / xs.length;
    near(d, geo.p.turningCircle, 0.02 * geo.p.turningCircle, `${name} ${m} turning circle`);
  }
});

test('braking: never beats the friction bound v^2 / (2 mu g); pitch dives; wheels stay inside the friction circle', () => {
  for (const name of PRESET_NAMES) for (const m of METHODS) {
    const geo = geometry(name), y = spawn(geo, flat);
    run(y, geo, flat, (t, s) => ({ throttle: speed(s) < 10 ? 1 : 0 }), 40, m);
    const v0 = speed(y), y0 = y[1];
    assert.ok(v0 > 9.5, `${name} ${m} reached 10 m/s`);
    let minPitch = 0, n = 0;
    const diag = new Float64Array(24), dy = new Float64Array(16);
    while (speed(y) > 0.05 && n < 60000) {
      step(y, { brake: 1 }, geo, flat, m); n++;
      minPitch = Math.min(minPitch, y[4]);
      derivative(y, { brake: 1 }, geo, flat, dy, diag);
      for (let i = 0; i < 4; i++) assert.ok(Math.hypot(diag[6 * i + 1], diag[6 * i + 2]) <= diag[6 * i + 3] * (1 + 1e-12) + 1e-9);
    }
    const dist = y[1] - y0, bound = v0 * v0 / (2 * geo.p.mu * G);
    assert.ok(dist >= bound, `${name} ${m}: stopped in ${dist.toFixed(2)} m, bound ${bound.toFixed(2)} m`);
    assert.ok(dist < 2 * bound, `${name} ${m}: brakes work (${dist.toFixed(2)} m)`);
    assert.ok(minPitch < 0, `${name} ${m} nose dives`);
  }
});

test('drive: approaches top speed without passing it; pulls away nose up', () => {
  for (const name of PRESET_NAMES) {
    const geo = geometry(name), y = spawn(geo, flat);
    run(y, geo, flat, {}, 1, 'rk4');
    run(y, geo, flat, { throttle: 1 }, 0.5, 'rk4');
    assert.ok(y[4] > 0, `${name} squat on pull-away`);
    run(y, geo, flat, { throttle: 1 }, 60, 'rk4');
    assert.ok(speed(y) < geo.p.topSpeed && speed(y) > 0.8 * geo.p.topSpeed, `${name}: ${speed(y)} of ${geo.p.topSpeed}`);
    const r = spawn(geo, flat);
    run(r, geo, flat, { throttle: 1, gear: -1 }, 20, 'rk4');
    assert.ok(r[7] < 0 && speed(r) < geo.p.reverseTopSpeed, `${name} reverses`);
  }
});

test('signs: steer right turns clockwise; a left turn rolls the right side down', () => {
  const geo = geometry('site-buggy'), y = spawn(geo, flat);
  run(y, geo, flat, (t, s) => ({ throttle: speed(s) < 6 ? 1 : 0 }), 6, 'rk4');
  const a = y.slice();
  run(a, geo, flat, { throttle: 0.3, steer: 0.5 }, 1, 'rk4');
  assert.ok(a[5] > 0.1 && a[0] > y[0], 'right turn: yaw grows, drifts east');
  const b = y.slice();
  run(b, geo, flat, { throttle: 0.3, steer: -0.5 }, 1, 'rk4');
  assert.ok(b[5] < -0.1 && b[3] > 0, 'left turn: yaw falls, roll positive');
});

test('slope: unbraked rolls downhill near g sin(theta); braked holds and parks', () => {
  for (const name of PRESET_NAMES) {
    const geo = geometry(name), free = spawn(geo, slope10);
    run(free, geo, slope10, {}, 2, 'rk4');
    const a = -free[7] / 2;                                        // mean acceleration down the slope over 2 s
    const gs = G * 0.1 / Math.sqrt(1.01);
    assert.ok(a > 0.6 * gs && a < gs, `${name}: ${a.toFixed(3)} vs ${gs.toFixed(3)} m/s2`);
    const held = spawn(geo, slope10);
    run(held, geo, slope10, { brake: 1 }, 5, 'rk4');
    assert.ok(speed(held) < 0.1, `${name} braked creep ${speed(held)} m/s`);
    assert.ok(isParked(held, { brake: 1 }, geo, slope10), `${name} parks on the slope`);
  }
});

test('Euler and RK4 agree on a manoeuvre (the pair) within 5 cm and 0.5 degree', () => {
  const golden = goldenRuns();
  for (const name of PRESET_NAMES) {
    const e = golden.find(r => r.preset === name && r.method === 'euler').samples.at(-1);
    const k = golden.find(r => r.preset === name && r.method === 'rk4').samples.at(-1);
    near(Math.hypot(e[0] - k[0], e[1] - k[1]), 0, 0.05, `${name} position`);
    near(e[5], k[5], 0.5 * Math.PI / 180, `${name} yaw`);
  }
});

test('deterministic: the golden file reproduces bit for bit', () => {
  const file = JSON.parse(readFileSync(new URL('../data/dynamics-golden.json', import.meta.url), 'utf8'));
  assert.deepEqual(goldenRuns(), file.runs);
});

test('driver: frame splits with the same total time give the same state; parked costs no steps; input wakes it', () => {
  const mk = () => createDriver({ preset: 'site-buggy', groundAt: slope10, x: 3, y: 4, yaw: 1 });
  const a = mk(), b = mk();
  a.setInput({ throttle: 0.6, steer: 0.3 }); b.setInput({ throttle: 0.6, steer: 0.3 });
  for (let i = 0; i < 250; i++) a.advance(0.008);                // frame times are counted in whole microseconds
  for (let i = 0; i < 100; i++) b.advance(i % 2 ? 0.0137 : 0.0263);
  assert.equal(a.ticks(), 2000); assert.equal(b.ticks(), 2000);
  assert.deepEqual(Array.from(a.state), Array.from(b.state));
  a.setInput({ throttle: 0, steer: 0, brake: 1 });
  let r; for (let i = 0; i < 600 && !a.parked(); i++) r = a.advance(1 / 60);
  assert.ok(a.parked(), 'parks under brake');
  const t = a.ticks();
  assert.deepEqual(a.advance(1 / 60), { steps: 0, moving: false });
  assert.equal(a.ticks(), t, 'no work while parked');
  a.setInput({ brake: 0, throttle: 0.5 });
  assert.equal(a.advance(1 / 60).moving, true);
  const p = a.pose();
  assert.equal(p.wheels.length, 4); assert.ok(p.yaw >= 0 && p.yaw < 2 * Math.PI);
  assert.throws(() => createDriver({ groundAt: flat, method: 'midpoint' }));
});
