// The assembled engine: the real vehicle dynamics driven through the feel layer, as the world will run it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createVehicleCartridge, toDynamicsInput, createTerrain, createDriveSession, PRESET_NAMES } from '../../src/web/buggy.mjs';
import { shape, ZERO } from '../../src/web/feel/controls.mjs';
import { createDriveRecorder, exportDrive, importDrive, replay } from '../../src/web/feel/drive-record.mjs';
import { fakeGate } from './helpers/test-engine.mjs';

// Generic test land: a gentle tilted plane with low bumps.
const heightAt = (x, y) => 10 + 0.02 * x - 0.01 * y + 0.03 * Math.sin(x * 0.7) * Math.cos(y * 0.5);
const terrain = createTerrain({ heightAt });

function script(i, dt) {
  const t = i * dt;
  if (t < 3) return { drive: 1, brake: 0, steer: 0, handbrake: 0 };
  if (t < 5) return { drive: 0.5, brake: 0, steer: 0.6, handbrake: 0 };
  return { drive: 0, brake: 1, steer: 0, handbrake: 0 };
}

function run(engine, steps) {
  let s = engine.spawn({ x: 0, y: 0, yaw: 0 }), u = { ...ZERO };
  const rec = createDriveRecorder({ name: 'test', dt: engine.dt, engine: engine.id, start: s, origin: { e: 0, n: 0 } });
  for (let i = 0; i < steps; i++) { u = shape(u, script(i, engine.dt), s.speed, engine.dt); s = engine.step(s, u, engine.dt); rec.push(u); }
  return { s, d: rec.stop(s) };
}

test('input mapping: forward, reverse, handbrake', () => {
  assert.deepEqual(toDynamicsInput({ drive: 0.5, brake: 0, steer: -0.2 }), { throttle: 0.5, gear: 1, brake: 0, steer: -0.2 });
  assert.deepEqual(toDynamicsInput({ drive: -0.4 }), { throttle: 0.4, gear: -1, brake: 0, steer: 0 });
  assert.equal(toDynamicsInput({ handbrake: 1 }).brake, 1);
});

test('every preset drives forwards, turns and stops through the cartridge contract', () => {
  for (const preset of PRESET_NAMES) {
    const eng = createVehicleCartridge({ preset, groundAt: terrain.heightAt });
    assert.ok(eng.dt > 0 && typeof eng.step === 'function' && typeof eng.atRest === 'function');
    const start = eng.spawn();
    const { s } = run(eng, Math.round(9 / eng.dt));
    assert.ok(s.y.every(Number.isFinite), `${preset} stays finite`);
    assert.ok(Math.hypot(s.pos[0] - start.pos[0], s.pos[1] - start.pos[1]) > 2, `${preset} moved`);
    assert.ok(Math.abs(s.yaw - start.yaw) > 0.01, `${preset} turned`);
    assert.ok(Math.abs(s.speed) < 0.5, `${preset} braked to near rest (${s.speed})`);
  }
});

test('deterministic: the same drive gives the same numbers, and a recorded drive replays to the millimetre', async () => {
  const eng = createVehicleCartridge({ groundAt: terrain.heightAt });
  const a = run(eng, 700), b = run(eng, 700);
  assert.deepEqual(Array.from(a.s.y), Array.from(b.s.y));
  const back = await importDrive(await exportDrive(a.d));
  const r = replay(back, { step: eng.step, engineId: eng.id, start: eng.spawn() });
  assert.equal(r.match, true, r.diff);
});

test('the cartridge refuses a step size it was not built for', () => {
  const eng = createVehicleCartridge({ groundAt: terrain.heightAt });
  assert.throws(() => eng.step(eng.spawn(), ZERO, 1 / 60), /steps in/);
});

test('a moved origin moves the vehicle with it', () => {
  const eng = createVehicleCartridge({ groundAt: (x, y) => 0 });
  const s = eng.spawn({ x: 5, y: 5 });
  const moved = eng.step({ ...s, pos: [s.pos[0] - 3, s.pos[1] - 4, s.pos[2]] }, ZERO, eng.dt);
  assert.ok(Math.abs(moved.pos[0] - 2) < 1e-6 && Math.abs(moved.pos[1] - 1) < 1e-6);
});

test('the drive session runs the real engine and draws 0 frames once parked', () => {
  const eng = createVehicleCartridge({ groundAt: terrain.heightAt });
  const gate = fakeGate();
  let i = 0;
  const session = createDriveSession({ engine: eng, state: eng.spawn(), gate, groundAt: terrain.heightAt,
    raw: () => (i < 90 ? { drive: 1, brake: 0, steer: 0, handbrake: 0 } : i < 200 ? { drive: 0, brake: 1, steer: 0, handbrake: 0 } : { ...ZERO }) });
  let now = 0;
  for (; i < 900 && !(i > 200 && !gate.moving); i++) { now += 1000 / 30; session.frame(now); }
  assert.ok(session.steps > 0);
  assert.equal(gate.moving, false, 'the session parked the gate');
  assert.ok(Math.abs(session.state.speed) < 0.1);
});

test('an idle vehicle on a slope is held by the brake, not left to roll', () => {
  const eng = createVehicleCartridge({ preset: 'utility-4x4', groundAt: (x, y) => 0.08 * y });
  let s = eng.spawn();
  for (let k = 0; k < 600; k++) s = eng.step(s, ZERO, eng.dt);
  assert.ok(Math.hypot(s.pos[0], s.pos[1] - eng.spawn().pos[1]) < 0.5, `held within 0.5 m (${s.pos})`);
  assert.equal(eng.atRest(s), true);
});

test('the web engine has no dependencies outside the repo', () => {
  const root = new URL('../../src/web/', import.meta.url);
  const files = [];
  const walk = u => readdirSync(u, { withFileTypes: true }).forEach(e => e.isDirectory() ? walk(new URL(e.name + '/', u)) : e.name.endsWith('.mjs') && files.push(new URL(e.name, u)));
  walk(root);
  assert.ok(files.length >= 13);
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /^\s*(import|export)[^;]*from\s+'(?!\.{1,2}\/)/m, `${f.pathname} imports a package`);
    assert.doesNotMatch(src, /\bMath\.random\(|\bDate\.now\(|performance\.now\(/, `${f.pathname} reads a clock or randomness`);
  }
});
