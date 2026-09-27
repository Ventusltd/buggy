import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createTestEngine, rest, fakeGate } from './helpers/test-engine.mjs';
import { shape, ZERO } from '../../src/web/feel/controls.mjs';
import { createDriveRecorder, exportDrive, importDrive, replay, toTourKeyframes } from '../../src/web/feel/drive-record.mjs';
import { makeSiteTour, compileRoute, createGuide, project } from '../../src/web/feel/site-tour.mjs';
import { createDriveSession } from '../../src/web/feel/drive-session.mjs';

const here = new URL('.', import.meta.url);
const demo = JSON.parse(readFileSync(new URL('../../tours/demo-loop.site-tour.json', here), 'utf8'));
const ORIGIN = { e: 400000, n: 300000 };

// A person's drive: accelerate, weave, brake, reverse a little.
function script(i) {
  const t = i / 120;
  if (t < 3) return { drive: 1, brake: 0, steer: 0, handbrake: 0 };
  if (t < 6) return { drive: 0.6, brake: 0, steer: Math.sign(Math.sin(t * 2)), handbrake: 0 };
  if (t < 8) return { drive: 0, brake: 1, steer: 0, handbrake: 0 };
  return { drive: -0.5, brake: 0, steer: 0.3, handbrake: 0 };
}

function drive(engine, steps) {
  let s = rest(), u = { ...ZERO };
  const rec = createDriveRecorder({ name: 'Test drive', dt: engine.dt, engine: engine.id, start: s, origin: ORIGIN });
  for (let i = 0; i < steps; i++) { u = shape(u, script(i), s.speed, engine.dt); s = engine.step(s, u, engine.dt); rec.push(u); }
  return { d: rec.stop(s), s };
}

test('a recorded drive replays exactly, round-trips its file, and catches tampering and a different engine', async () => {
  const eng = createTestEngine();
  const { d, s } = drive(eng, 1200);
  assert.equal(d.steps, 1200);
  assert.ok(d.runs.length < 1200, 'run-length coding shortens held inputs');
  const text = await exportDrive(d);
  const back = await importDrive(text);
  const poses = [];
  const r = replay(back, { step: eng.step, engineId: eng.id, start: rest(), onStep: p => poses.push(p) });
  assert.equal(r.match, true, r.diff);
  assert.deepEqual(r.state.pos, s.pos);
  const k = toTourKeyframes(back, poses, ORIGIN, 60);
  assert.ok(k.length > 10 && k.every((x, i) => !i || x.t > k[i - 1].t));
  const bad = JSON.parse(text); bad.runs[0][1] = 0.5;
  await assert.rejects(importDrive(JSON.stringify(bad)), /altered/);
  assert.equal(replay(back, { step: eng.step, engineId: 'other.v1', start: rest() }).match, false);
  // a wrong start state is reported, not hidden
  assert.equal(replay(back, { step: eng.step, engineId: eng.id, start: rest(1, 0) }).match, false);
});

test('site tours are validated with plain reasons', () => {
  assert.throws(() => makeSiteTour({ ...demo, schema: 'x' }), /schema/);
  assert.throws(() => makeSiteTour({ ...demo, route: [{ e: 1, n: 2 }] }), /2 to/);
  assert.throws(() => makeSiteTour({ ...demo, stops: [{ at: 99 }] }), /index/);
  assert.throws(() => makeSiteTour({ ...demo, cruiseKmh: 90 }), /cruise/);
  const t = makeSiteTour(demo);
  const r = compileRoute(t, ORIGIN);
  assert.equal(r.stops.length, 4);
  assert.equal(r.stops[3].s, r.length);
});

test('projection never jumps ahead to a later pass of the route', () => {
  const t = makeSiteTour({ schema: 'buggy.site-tour.v1', route: [{ e: 0, n: 0 }, { e: 0, n: 100 }, { e: 5, n: 100 }, { e: 5, n: 0 }], stops: [] });
  const r = compileRoute(t, { e: 0, n: 0 });
  assert.equal(project(r, [2, 10], 0, 1).seg, 0);
});

function runTour(eng) {
  const tour = makeSiteTour(demo);
  const g = createGuide(tour, ORIGIN, { wheelbase: 2.2, maxSteer: 0.6 });
  let s = rest(0, 0, 0), u = { ...ZERO }, t = 0, worst = 0;
  const arrivals = [], captions = [];
  let lastPhase = '', lastCaption = '';
  const r = g.route;
  while (t < 400) {
    const o = g.step(s, eng.dt);
    if (o.phase === 'stopped' && lastPhase !== 'stopped') arrivals.push({ stop: o.stop, gap: Math.abs(project(r, s.pos, 0, r.pts.length).s - r.stops[o.stop].s) });
    if (o.caption && o.caption !== lastCaption) captions.push(o.caption);
    lastPhase = o.phase; lastCaption = o.caption;
    if (o.phase === 'done' && Math.abs(s.speed) < 1e-3) break;
    u = shape(u, o.raw, s.speed, eng.dt); s = eng.step(s, u, eng.dt); t += eng.dt;
    worst = Math.max(worst, project(r, s.pos, 0, r.pts.length).off);
  }
  return { s, t, worst, arrivals, captions, phase: g.phase };
}

test('the guide drives the demonstration loop, stops at every stop with its caption, and ends at rest', () => {
  const eng = createTestEngine();
  const a = runTour(eng);
  assert.equal(a.phase, 'done');
  assert.deepEqual(a.arrivals.map(x => x.stop), [0, 1, 2, 3]);
  for (const x of a.arrivals) assert.ok(x.gap < 1.0, `stopped ${x.gap.toFixed(2)} m from stop ${x.stop}`);
  assert.equal(a.captions.length, 4);
  assert.ok(a.worst < 2.5, `left the track by ${a.worst.toFixed(2)} m`);
  const b = runTour(eng);
  assert.deepEqual(b.s, a.s, 'a guided drive is deterministic');
});

// Frame loop with a fake clock: counts the gate's draw calls the way the world's frame gate would make them.
function harness({ pad = false } = {}) {
  const eng = createTestEngine();
  const gate = fakeGate();
  let held = null; const timers = { n: 0, setInterval: () => ++timers.n, clearInterval: () => { timers.n = 0; } };
  const sess = createDriveSession({ engine: eng, state: rest(), gate, raw: () => (held ? { ...held } : { ...ZERO }), gamepadConnected: () => pad, timers, origin: () => ORIGIN });
  let now = 0, frames = 0;
  const run = seconds => { const end = now + seconds * 1000; while (now < end) { now += 1000 / 30; if (gate.moving) { sess.frame(now); frames++; } } };
  return { sess, gate, timers, run, press: h => { held = h; sess.wake(); }, get frames() { return frames; }, reset() { frames = 0; } };
}

test('a parked buggy draws 0 frames; driving runs at the gate rate; the gamepad poll draws nothing', () => {
  const h = harness();
  h.press({ drive: 1, brake: 0, steer: 0, handbrake: 0 });
  h.run(2);
  assert.ok(h.sess.state.speed > 3 && h.frames >= 59);
  h.press(null); h.run(0.1); h.press({ drive: 0, brake: 1, steer: 0, handbrake: 0 });
  h.run(3); h.press(null);
  h.run(10);
  assert.equal(h.gate.moving, false, 'parked');
  h.reset(); h.run(30);
  assert.equal(h.frames, 0, '0 fps parked');
  const p = harness({ pad: true });
  p.press({ drive: 1, brake: 0, steer: 0, handbrake: 0 }); p.run(0.5); p.press(null); p.run(20);
  assert.equal(p.gate.moving, false);
  assert.ok(p.timers.n > 0, 'a light poll watches the gamepad while parked');
});

test('session runs a whole tour and records it; the record replays to the same place', async () => {
  const h = harness();
  const t = makeSiteTour(demo);
  h.sess.startRecording('tour');
  h.sess.startTour(t);
  h.run(300);
  assert.equal(h.sess.touring, false);
  assert.equal(h.gate.moving, false);
  const d = h.sess.stopRecording();
  const eng = createTestEngine();
  const r = replay(await importDrive(await exportDrive(d)), { step: eng.step, engineId: eng.id, start: rest() });
  assert.equal(r.match, true, r.diff);
});

test('manual input takes the wheel from the guide', () => {
  const h = harness();
  h.sess.startTour(makeSiteTour(demo));
  h.run(2);
  h.press({ drive: 0, brake: 1, steer: 0, handbrake: 0 });
  h.run(0.2);
  assert.equal(h.sess.touring, false);
});

test('public-safe: no local paths, drive letters or network fetches in the shipped modules', () => {
  const dir = new URL('../../src/web/feel/', here);
  for (const f of readdirSync(dir)) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /\b[A-Z]:[\\/]/, `${f} holds a drive path`);
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|localStorage/, `${f} reaches outside the page`);
    assert.doesNotMatch(src, /^import .* from '(?!\.\/)/m, `${f} imports a dependency`);
  }
});
