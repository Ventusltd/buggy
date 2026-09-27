import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRig, chaseTarget, driverTarget, bodyToWorld, blend, wrap, CHASE, DRIVER } from '../../src/web/feel/cameras.mjs';
import { hudLines, headingDeg, compass, DEFAULT_LIMITS, mountDriveHud } from '../../src/web/feel/hud.mjs';
import { createMount, dismountPose, MOUNT } from '../../src/web/feel/mount.mjs';
import { createSound, engineNote } from '../../src/web/feel/sound.mjs';

const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const pose = (x, y, yaw, pitch = 0) => ({ pos: [x, y, 0], yaw, pitch, roll: 0, speed: 0 });

test('body frame: forward is along the heading, right is clockwise of it', () => {
  const p = bodyToWorld(pose(0, 0, Math.PI / 2), [1, 2, 0]); // facing east: forward +x, right -y
  assert.ok(near(p[0], 2) && near(p[1], -1));
});

test('chase camera sits behind and above, looking at the buggy; driver camera sits in the seat', () => {
  const c = chaseTarget(pose(10, 20, 0));
  assert.ok(near(c.pos[0], 10) && near(c.pos[1], 20 - CHASE.back) && near(c.pos[2], CHASE.up));
  assert.ok(near(c.yaw, 0) && c.pitch < 0);
  const g = chaseTarget(pose(0, 0, 0), { groundAt: () => 5 }); // a bank behind the buggy lifts the camera clear
  assert.ok(g.pos[2] >= 5 + CHASE.clearance - 1e-9);
  const d = driverTarget(pose(0, 0, 0, 0.1));
  assert.ok(near(d.pos[0], DRIVER.seat[0]) && near(d.pitch, 0.1));
});

test('smoothing converges, settles, and is independent of the step size for a still target', () => {
  const a = createRig(), b = createRig(), p = pose(0, 0, 0);
  a.snap(pose(-20, 0, 1)); b.snap(pose(-20, 0, 1));
  for (let i = 0; i < 120; i++) a.step(p, 1 / 120);
  for (let i = 0; i < 60; i++) b.step(p, 1 / 60);
  for (let k = 0; k < 3; k++) assert.ok(near(a.camera.pos[k], b.camera.pos[k], 1e-9));
  assert.ok(near(blend(0.5, 0.25), 1 - Math.exp(-2)));
  for (let i = 0; i < 2000; i++) a.step(p, 1 / 120);
  assert.equal(a.settled(), true);
});

test('yaw smoothing turns the short way across north-south', () => {
  const r = createRig({ mode: 'driver' });
  r.snap(pose(0, 0, Math.PI - 0.05));
  r.step(pose(0, 0, -Math.PI + 0.05), 1 / 120);
  assert.ok(Math.abs(wrap(r.camera.yaw - Math.PI)) < 0.1, 'did not swing through north');
});

test('camera toggle cycles chase and driver and snaps to the new seat', () => {
  const r = createRig();
  r.step(pose(0, 0, 0), 1 / 120);
  assert.equal(r.toggle(), 'driver');
  r.step(pose(0, 0, 0), 1 / 120);
  assert.ok(near(r.camera.pos[2], DRIVER.seat[2]));
  assert.equal(r.toggle(), 'chase');
});

test('HUD: speed, gradient and heading; red only beyond a limit', () => {
  const ok = hudLines({ speed: 5, pitch: Math.atan(0.05), yaw: Math.PI / 2 });
  assert.deepEqual(ok.map(l => l.limit), [false, false, false]);
  assert.match(ok[0].text, /SPD +18 km\/h/);
  assert.match(ok[1].text, /GRD \+5\.0 %/);
  assert.equal(ok[2].text, 'HDG 090 E');
  const fast = hudLines({ speed: DEFAULT_LIMITS.speedKmh / 3.6 + 0.5, pitch: 0, yaw: 0 });
  assert.deepEqual(fast.map(l => l.limit), [true, false, false]);
  const steep = hudLines({ speed: 1, pitch: -Math.atan(0.2), yaw: 0 });
  assert.deepEqual(steep.map(l => l.limit), [false, true, false]);
  assert.match(hudLines({ speed: -1, pitch: 0, yaw: 0 })[0].text, / R$/);
  assert.equal(headingDeg(-Math.PI / 2), 270);
  assert.equal(compass(359), 'N');
});

test('HUD mount redraws only when its text changes', () => {
  const el = () => ({ children: [], hidden: false, className: '', textContent: '', setAttribute() {}, append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; }, remove() {} });
  const doc = { head: el(), body: el(), createElement: el, getElementById: () => null };
  const h = mountDriveHud({ doc });
  assert.equal(h.update({ speed: 3, pitch: 0, yaw: 0 }), true);
  assert.equal(h.update({ speed: 3.01, pitch: 0, yaw: 0 }), false);
  assert.equal(h.update({ speed: 30, pitch: 0, yaw: 0 }), true);
  assert.equal(h.box.children[0].className, 'lim');
});

test('mount: refused out of reach; dismount refused while moving, then beside the driver door', () => {
  const m = createMount({ groundAt: () => 2 });
  const v = { pos: [0, 0, 2], yaw: 0, speed: 0 };
  assert.equal(m.toggle({ pos: [10, 0, 3.7] }, v).ok, false);
  assert.equal(m.toggle({ pos: [2, 1, 3.7] }, v).mode, 'drive');
  assert.equal(m.toggle(null, { ...v, speed: 3 }).ok, false);
  const out = m.toggle(null, v);
  assert.equal(out.mode, 'walk');
  assert.ok(near(out.walker.pos[0], MOUNT.door[0]) && near(out.walker.pos[2], 2 + MOUNT.eye));
  assert.deepEqual(dismountPose({ pos: [0, 0, 0], yaw: 0 }).pos.map(x => Math.round(x * 10) / 10), [-1.4, 0.2, 1.7]);
});

test('sound: off by default, no audio created until turned on, updates only on a real change', () => {
  let made = 0;
  const param = () => ({ value: 0 });
  const audio = () => { made++; return { destination: {}, createOscillator: () => ({ frequency: param(), connect() {}, start() {} }), createGain: () => ({ gain: param(), connect() {} }), resume() {}, suspend() {}, close() {} }; };
  const s = createSound({ audio });
  assert.equal(s.on, false);
  assert.equal(s.update({ speed: 5, drive: 1 }), false);
  assert.equal(made, 0);
  s.toggle();
  assert.equal(made, 1);
  assert.equal(s.update({ speed: 5, drive: 1 }), true);
  assert.equal(s.update({ speed: 5.01, drive: 1 }), false);
  assert.ok(engineNote({ speed: 100, drive: 1 }).hz <= 320);
});
