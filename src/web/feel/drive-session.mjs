// drive-session.mjs: the feel layer wired together, for the world to import. It owns no physics: the vehicle engine
// cartridge supplies { id, dt, step(state, input, dt) -> state, atRest?(state) }, and this session runs it on a fixed
// step, shapes the driver's input, moves the camera, updates the HUD and sound, records drives and runs site tours.
// Frames: it drives the world's frame gate. While anything moves it asks for 30 fps; once the buggy is at rest, no
// input is held and the camera has settled, it tells the gate to stop, so a parked buggy draws 0 frames per second.
// A connected gamepad cannot raise events, so while parked with one connected a light timer (no drawing) polls it
// a few times a second and wakes the gate on a press.

import { ZERO, shape, isIdle } from './controls.mjs';
import { createRig } from './cameras.mjs';
import { createDriveRecorder } from './drive-record.mjs';
import { createGuide } from './site-tour.mjs';

export const DRIVE_FPS = 30;
export const MAX_CATCH_UP_S = 0.25; // after a stall the simulation drops time rather than running a burst of steps
export const REST_SPEED = 0.01;
export const PAD_POLL_MS = 150;

const rawIdle = r => !r.drive && !r.brake && !r.steer && !r.handbrake;

// deps: engine, state (initial vehicle state), gate, raw(speed) -> raw intent (controls.raw), origin() -> { e, n },
// onCamera(cam), hud, sound, gamepadConnected(), timers ({ setInterval, clearInterval }), groundAt.
export function createDriveSession({
  engine, state, gate, raw = () => ({ ...ZERO }), origin = () => ({ e: 0, n: 0 }), onCamera = () => {}, hud = null, sound = null,
  gamepadConnected = () => false, timers = globalThis, groundAt = null, camera = 'chase', onTourEnd = () => {}
}) {
  if (!engine || !(engine.dt > 0) || typeof engine.step !== 'function') throw Error('the drive session needs a fixed-step vehicle engine');
  const dt = engine.dt;
  const rig = createRig({ mode: camera, groundAt });
  let input = { ...ZERO }, acc = 0, last = null, moving = false, steps = 0, recorder = null, guide = null, caption = '', poll = null;
  const atRest = s => (engine.atRest ? engine.atRest(s) : Math.abs(s.speed || 0) < REST_SPEED);

  const stopPoll = () => { if (poll !== null) { timers.clearInterval(poll); poll = null; } };
  function wake() {
    stopPoll();
    if (!moving) { moving = true; last = null; gate.setMoving(true, DRIVE_FPS); }
  }
  function park() {
    moving = false; last = null; acc = 0;
    gate.setMoving(false);
    if (gamepadConnected()) poll = timers.setInterval(() => { if (!rawIdle(raw(state.speed || 0))) wake(); }, PAD_POLL_MS);
  }

  function oneStep() {
    let r;
    if (guide) {
      const person = raw(state.speed || 0);
      if (!rawIdle(person)) { guide = null; caption = ''; hud?.caption(''); r = person; } // the driver takes over
      else {
        const g = guide.step(state, dt);
        if (g.caption !== caption) { caption = g.caption; hud?.caption(caption); }
        r = g.raw;
        if (g.phase === 'done' && atRest(state)) { guide = null; onTourEnd(); }
      }
    } else r = raw(state.speed || 0);
    input = shape(input, r, state.speed || 0, dt);
    state = engine.step(state, input, dt);
    recorder?.push(input);
    steps++;
    return r;
  }

  const self = {
    get state() { return state; },
    get input() { return input; },
    get steps() { return steps; },
    get moving() { return moving; },
    get rig() { return rig; },
    get touring() { return !!guide; },
    get recording() { return !!recorder; },
    wake,
    // Called from the gate's draw(now) with the time in ms. Runs whole fixed steps for the time that has passed.
    frame(now) {
      if (last === null) { last = now - dt * 1000; acc = 0; }
      acc = Math.min(acc + (now - last) / 1000, MAX_CATCH_UP_S);
      last = now;
      let r = null;
      while (acc >= dt - 1e-9) { acc -= dt; r = oneStep(); rig.step(state, dt); }
      const cam = rig.camera || rig.snap(state);
      onCamera(cam, state);
      hud?.update(state);
      sound?.update({ speed: state.speed, drive: input.drive });
      const person = r ?? raw(state.speed || 0);
      const guideBusy = guide && guide.phase !== 'paused';
      if (atRest(state) && isIdle(input) && rawIdle(person) && rig.settled() && !guideBusy) park();
      else if (!moving) wake();
      return cam;
    },
    toggleCamera() { const m = rig.toggle(); wake(); return m; },
    look(a) { rig.look(a); wake(); },
    startRecording(name = '') {
      const o = origin();
      recorder = createDriveRecorder({ name, dt, engine: engine.id, start: state, origin: o });
      return recorder;
    },
    stopRecording() { if (!recorder) return null; const d = recorder.stop(state); recorder = null; return d; },
    startTour(tour) { guide = createGuide(tour, origin()); caption = ''; wake(); return guide; },
    pauseTour() { if (!guide) return false; const p = guide.pause(); wake(); return p; },
    stopTour() { guide = null; caption = ''; hud?.caption(''); wake(); },
    // The world moved its origin by [dx, dy]: move the vehicle, camera and tour with it.
    rebase(shift) {
      state = { ...state, pos: [state.pos[0] - shift[0], state.pos[1] - shift[1], state.pos[2]] };
      if (rig.camera) rig.camera.pos = [rig.camera.pos[0] - shift[0], rig.camera.pos[1] - shift[1], rig.camera.pos[2]];
      guide?.rebase(shift);
    },
    dispose() { stopPoll(); gate.setMoving(false); sound?.close?.(); }
  };
  return self;
}
