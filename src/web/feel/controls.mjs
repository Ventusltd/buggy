// controls.mjs: keyboard, gamepad and touch turned into one driver input, then shaped the same way for all three.
// Pure mapping and shaping; the only DOM code is attachControls() at the bottom, which the world calls once.
// Driver input (the contract with the vehicle engine): { drive: -1..1, brake: 0..1, steer: -1..1, handbrake: 0|1 }.
// drive > 0 pulls forwards, drive < 0 pulls in reverse; steer > 0 turns right (clockwise seen from above).
// Keys: W / Up accelerate, S / Down brake, then reverse once stopped, A / D or Left / Right steer, Space handbrake,
// Shift held = fine steering. C camera, X mount or dismount, N sound, P pause a site tour.
// Gamepad (standard mapping): left stick steers, right trigger accelerates, left trigger brakes and reverses,
// A handbrake, Y camera, B mount or dismount. Touch: the pad's sideways travel steers, up accelerates, down brakes.

export const ZERO = Object.freeze({ drive: 0, brake: 0, steer: 0, handbrake: 0 });
export const KEYS = Object.freeze({
  up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'], fine: ['ShiftLeft', 'ShiftRight']
});
export const ACTION_KEYS = Object.freeze({ KeyC: 'camera', KeyX: 'mount', KeyN: 'sound', KeyP: 'pause' });
export const PAD_ACTIONS = Object.freeze({ 3: 'camera', 1: 'mount' });
// Rates are per second of simulated time, so shaping is deterministic under a fixed step.
export const SHAPE = Object.freeze({
  driveUp: 2.5, driveDown: 5, brakeUp: 6, brakeDown: 8, steerUp: 2.2, steerBack: 4, fineSteer: 0.4,
  steerFadeSpeed: 12, reverseBelow: 0.4, deadzone: 0.12
});

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const any = (held, codes) => codes.some(c => held.has(c));
const q = x => Math.round(x * 1e4) / 1e4; // quantised, so recorded drives read back as the same numbers

// Held key codes -> raw driver intent. `speed` is the signed forward speed in m/s: the down key brakes while moving
// forwards and reverses once nearly stopped, and the up key brakes while rolling backwards.
export function fromKeys(held, speed = 0) {
  const up = any(held, KEYS.up), down = any(held, KEYS.down);
  const steer = (any(held, KEYS.right) ? 1 : 0) - (any(held, KEYS.left) ? 1 : 0);
  return pedals(up ? 1 : 0, down ? 1 : 0, steer, any(held, KEYS.handbrake) ? 1 : 0, speed, any(held, KEYS.fine));
}

// One axis with a dead zone, rescaled so the edge of the dead zone reads 0 and the rim reads 1.
export function deadzone(v, dz = SHAPE.deadzone) {
  const a = Math.abs(v);
  return a <= dz ? 0 : Math.sign(v) * Math.min(1, (a - dz) / (1 - dz));
}

// A standard-mapping gamepad snapshot ({ axes, buttons: [{ value, pressed }] }) -> raw intent.
export function fromGamepad(pad, speed = 0) {
  if (!pad) return { ...ZERO, fine: false };
  const val = i => {
    const b = pad.buttons?.[i];
    return b ? (+b.value || (b.pressed ? 1 : 0)) : 0;
  };
  return pedals(deadzone(val(7), 0.05), deadzone(val(6), 0.05), deadzone(pad.axes?.[0] ?? 0), val(0) > 0.5 ? 1 : 0, speed, false);
}

// The touch pad's thumb offset (CSS px from the pad centre) and its radius -> raw intent.
export function fromTouch(dx, dy, radius, speed = 0) {
  if (!(radius > 0)) return { ...ZERO, fine: false };
  const x = deadzone(clamp(dx / radius, -1, 1)), y = deadzone(clamp(-dy / radius, -1, 1));
  return pedals(Math.max(0, y), Math.max(0, -y), x, 0, speed, false);
}

function pedals(fwd, back, steer, handbrake, speed, fine) {
  let drive = 0, brake = 0;
  if (speed > SHAPE.reverseBelow) { drive = fwd; brake = back; }
  else if (speed < -SHAPE.reverseBelow) { drive = back ? -back : 0; brake = fwd; }
  else drive = fwd - back; // stopped or creeping: either pedal pulls its own way
  return { drive, brake, steer: clamp(steer, -1, 1), handbrake, fine: !!fine };
}

// The strongest of several sources wins, axis by axis, so a gamepad and a keyboard can both be live.
export function merge(...raws) {
  const out = { drive: 0, brake: 0, steer: 0, handbrake: 0, fine: false };
  for (const r of raws) {
    if (!r) continue;
    for (const k of ['drive', 'brake', 'steer']) if (Math.abs(r[k]) > Math.abs(out[k])) out[k] = r[k];
    out.handbrake = Math.max(out.handbrake, r.handbrake ? 1 : 0);
    out.fine ||= !!r.fine;
  }
  return out;
}

// Move `from` toward `to` by at most rate * dt: `up` while the magnitude grows on the same side, `down` otherwise
// (easing off, or crossing through zero to the other side).
function toward(from, to, up, down, dt) {
  const growing = Math.abs(to) > Math.abs(from) && (from === 0 || Math.sign(to) === Math.sign(from));
  const step = (growing ? up : down) * dt;
  return to > from ? Math.min(to, from + step) : Math.max(to, from - step);
}

// Shape the raw intent over one fixed step dt (s). Pedals ramp, steering ramps and self-centres faster than it
// winds on, and its reach narrows with speed so a full key press at speed is a lane change, not a spin.
// raw.exact (set by the tour guide, never by a person) skips the narrowing: the guide already asks for the angle it needs.
// Pure: the same previous input, raw intent, speed and dt give the same result every time.
export const steerReach = (speed, fine = false) => (fine ? SHAPE.fineSteer : 1) / (1 + Math.abs(speed) / SHAPE.steerFadeSpeed);

export function shape(prev, raw, speed, dt) {
  const reach = raw.exact ? 1 : steerReach(speed, raw.fine);
  return {
    drive: q(toward(prev.drive, raw.drive, SHAPE.driveUp, SHAPE.driveDown, dt)),
    brake: q(toward(prev.brake, raw.brake, SHAPE.brakeUp, SHAPE.brakeDown, dt)),
    steer: q(toward(prev.steer, raw.steer * reach, SHAPE.steerUp, SHAPE.steerBack, dt)),
    handbrake: raw.handbrake ? 1 : 0
  };
}

export const isIdle = input => !input.drive && !input.brake && !input.steer && !input.handbrake;

// ---------- DOM (the only part that touches the page) ----------

// Attach to the page. Returns { raw(speed), stick, gamepadConnected(), detach() }.
// onAction(name) gets 'camera' | 'mount' | 'sound' | 'pause'; onChange() fires whenever a key or the stick changes,
// so the caller can wake its frame gate. Gamepads are polled only when raw() is called, once per drawn frame while
// driving, so a parked world polls nothing.
export function attachControls({ target = globalThis, pad = null, onChange = () => {}, onAction = () => {}, getPads = () => globalThis.navigator?.getGamepads?.() ?? [] } = {}) {
  const held = new Set(), watched = new Set(Object.values(KEYS).flat());
  let stick = null, radius = 0;
  const padPressed = {};
  const key = down => e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser shortcuts alone
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target?.tagName || '')) return; // typing in a form field
    if (down && ACTION_KEYS[e.code]) { if (!e.repeat) onAction(ACTION_KEYS[e.code]); e.preventDefault?.(); return; }
    if (!watched.has(e.code)) return;
    const had = held.has(e.code);
    if (down) held.add(e.code); else held.delete(e.code);
    if (had !== down) onChange();
    if (down) e.preventDefault?.();
  };
  const kd = key(true), ku = key(false), blur = () => { held.clear(); stick = null; onChange(); };
  target.addEventListener('keydown', kd); target.addEventListener('keyup', ku); target.addEventListener('blur', blur);

  const pdown = e => {
    if (stick) return;
    const b = pad.getBoundingClientRect(); radius = b.width / 2;
    stick = { id: e.pointerId, x0: b.left + radius, y0: b.top + b.height / 2, dx: 0, dy: 0 };
    stick.dx = e.clientX - stick.x0; stick.dy = e.clientY - stick.y0;
    pad.setPointerCapture?.(e.pointerId); onChange(); e.preventDefault?.();
  };
  const pmove = e => { if (stick && e.pointerId === stick.id) { stick.dx = e.clientX - stick.x0; stick.dy = e.clientY - stick.y0; onChange(); } };
  const pup = e => { if (stick && e.pointerId === stick.id) { stick = null; onChange(); } };
  const padEvents = [['pointerdown', pdown], ['pointermove', pmove], ['pointerup', pup], ['pointercancel', pup]];
  if (pad) for (const [n, f] of padEvents) pad.addEventListener(n, f);

  const gamepad = () => { for (const g of getPads() || []) if (g && g.mapping === 'standard') return g; return null; };
  return {
    held,
    get stick() { return stick; },
    raw(speed = 0) {
      const g = gamepad();
      if (g) for (const [i, name] of Object.entries(PAD_ACTIONS)) {
        const on = !!g.buttons[i]?.pressed;
        if (on && !padPressed[i]) onAction(name);
        padPressed[i] = on;
      }
      return merge(fromKeys(held, speed), g && fromGamepad(g, speed), stick && fromTouch(stick.dx, stick.dy, radius, speed));
    },
    // true while a standard gamepad is connected: the caller keeps a slow poll rather than parking blind to it
    gamepadConnected: () => !!gamepad(),
    detach() {
      target.removeEventListener('keydown', kd); target.removeEventListener('keyup', ku); target.removeEventListener('blur', blur);
      if (pad) for (const [n, f] of padEvents) pad.removeEventListener(n, f);
    }
  };
}
