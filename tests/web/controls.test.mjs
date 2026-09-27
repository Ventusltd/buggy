import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromKeys, fromGamepad, fromTouch, deadzone, merge, shape, steerReach, ZERO, SHAPE, attachControls } from '../../src/web/feel/controls.mjs';

const keys = (...c) => new Set(c);

test('keys: up drives, down brakes while moving and reverses once stopped', () => {
  assert.equal(fromKeys(keys('KeyW'), 0).drive, 1);
  assert.deepEqual([fromKeys(keys('KeyS'), 5).drive, fromKeys(keys('KeyS'), 5).brake], [0, 1]);
  assert.equal(fromKeys(keys('ArrowDown'), 0).drive, -1);
  const back = fromKeys(keys('KeyW'), -3); // rolling backwards: up brakes
  assert.deepEqual([back.drive, back.brake], [0, 1]);
  assert.equal(fromKeys(keys('KeyA'), 0).steer, -1);
  assert.equal(fromKeys(keys('KeyD', 'KeyA'), 0).steer, 0);
  assert.equal(fromKeys(keys('Space'), 0).handbrake, 1);
  assert.equal(fromKeys(keys('ShiftLeft'), 0).fine, true);
});

test('dead zone rescales to 0 at its edge and 1 at the rim', () => {
  assert.equal(deadzone(0.1), 0);
  assert.equal(deadzone(1), 1);
  assert.equal(deadzone(-1), -1);
  assert.ok(Math.abs(deadzone(0.56) - 0.5) < 1e-9);
});

test('gamepad standard mapping: triggers, stick, A handbrake', () => {
  const b = v => ({ value: v, pressed: v > 0.5 });
  const pad = { axes: [0.5, 0], buttons: [b(1), b(0), b(0), b(0), b(0), b(0), b(0), b(0.8)] };
  const r = fromGamepad(pad, 0);
  assert.ok(r.drive > 0.7 && r.steer > 0.4 && r.handbrake === 1);
  assert.deepEqual(fromGamepad(null), { ...ZERO, fine: false });
});

test('touch pad: up drives, down reverses from rest, sideways steers', () => {
  assert.ok(fromTouch(0, -40, 40, 0).drive > 0.99);
  assert.ok(fromTouch(0, 40, 40, 0).drive < -0.99);
  assert.ok(fromTouch(40, 0, 40, 0).steer > 0.99);
  assert.equal(fromTouch(2, 2, 40, 0).drive, 0);
});

test('merge takes the strongest source per axis', () => {
  const m = merge({ drive: 0.3, brake: 0, steer: -0.2, handbrake: 0 }, { drive: 1, brake: 0, steer: 0.1, handbrake: 1 }, null);
  assert.deepEqual([m.drive, m.steer, m.handbrake], [1, -0.2, 1]);
});

test('shaping ramps at the set rates and is deterministic', () => {
  const dt = 1 / 120, raw = { drive: 1, brake: 0, steer: 1, handbrake: 0 };
  let a = { ...ZERO }, b = { ...ZERO }, n = 0;
  while (a.drive < 1) { a = shape(a, raw, 0, dt); b = shape(b, raw, 0, dt); n++; }
  assert.deepEqual(a, b);
  assert.ok(Math.abs(n * dt - 1 / SHAPE.driveUp) <= dt + 1e-9, `full throttle after ${n * dt} s`);
  // steering self-centres faster than it winds on
  let up = 0, back = 0, s = { ...ZERO };
  while (s.steer < 1) { s = shape(s, raw, 0, dt); up++; }
  while (s.steer > 0) { s = shape(s, { ...raw, steer: 0 }, 0, dt); back++; }
  assert.ok(back < up);
});

test('steering reach narrows with speed and with fine control; the guide can ask for exact', () => {
  assert.ok(steerReach(20) < steerReach(5) && steerReach(5) < steerReach(0));
  assert.equal(steerReach(0, true), SHAPE.fineSteer);
  let s = { ...ZERO };
  for (let i = 0; i < 600; i++) s = shape(s, { drive: 0, brake: 0, steer: 1, handbrake: 0 }, 12, 1 / 120);
  assert.ok(Math.abs(s.steer - 0.5) < 1e-3);
  let e = { ...ZERO };
  for (let i = 0; i < 600; i++) e = shape(e, { drive: 0, brake: 0, steer: 1, handbrake: 0, exact: true }, 12, 1 / 120);
  assert.equal(e.steer, 1);
});

test('attachControls: keys held, action keys fire once, form fields ignored, blur clears', () => {
  const ls = {}, target = { addEventListener: (n, f) => { ls[n] = f; }, removeEventListener: n => { delete ls[n]; } };
  const acts = []; let changes = 0;
  const c = attachControls({ target, onChange: () => changes++, onAction: a => acts.push(a), getPads: () => [] });
  const ev = (code, extra = {}) => ({ code, target: { tagName: 'CANVAS' }, preventDefault() {}, ...extra });
  ls.keydown(ev('KeyW'));
  assert.equal(c.raw(0).drive, 1);
  ls.keydown(ev('KeyC')); ls.keydown(ev('KeyC', { repeat: true }));
  assert.deepEqual(acts, ['camera']);
  ls.keydown(ev('KeyD', { target: { tagName: 'INPUT' } }));
  assert.equal(c.raw(0).steer, 0);
  ls.blur();
  assert.equal(c.raw(0).drive, 0);
  assert.ok(changes >= 2);
  c.detach();
  assert.equal(Object.keys(ls).length, 0);
});

test('gamepad buttons fire actions on the press edge only', () => {
  const ls = {}, target = { addEventListener: (n, f) => { ls[n] = f; }, removeEventListener() {} };
  const acts = [], buttons = Array.from({ length: 16 }, () => ({ value: 0, pressed: false }));
  const pad = { mapping: 'standard', axes: [0, 0], buttons };
  const c = attachControls({ target, onAction: a => acts.push(a), getPads: () => [pad] });
  buttons[3] = { value: 1, pressed: true };
  c.raw(); c.raw();
  buttons[3] = { value: 0, pressed: false }; c.raw();
  buttons[1] = { value: 1, pressed: true }; c.raw();
  assert.deepEqual(acts, ['camera', 'mount']);
  assert.equal(c.gamepadConnected(), true);
});
