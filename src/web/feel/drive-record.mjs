// drive-record.mjs: recorded drives. A drive is stored as its shaped inputs, one per fixed step (run-length coded),
// plus the start state and the engine that ran it. Because the vehicle engine is fixed-step and deterministic, playing
// the inputs back through the same engine reproduces the drive exactly; the file carries the end state it reached
// and a sha256 of its own content, so a replay that ends anywhere else, or a file that was altered, is caught.
// No DOM and no randomness. Grid placement: start.e / start.n are national grid metres, like the world's tours.

export const SCHEMA = 'buggy.drive.v1';
export const LIMITS = Object.freeze({ fileBytes: 8 * 1024 * 1024, steps: 4 * 3600 * 240, runs: 500000, name: 200 });
const HEX64 = /^[0-9a-f]{64}$/;
const mm = x => Math.round(x * 1e3) / 1e3;
const rad = x => Math.round(x * 1e6) / 1e6;
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];

// The part of a vehicle state a drive promises to reproduce, rounded to millimetres and micro-radians.
export function endState(s) {
  return { x: mm(s.pos[0]), y: mm(s.pos[1]), z: mm(s.pos[2]), yaw: rad(s.yaw), pitch: rad(s.pitch || 0), roll: rad(s.roll || 0), speed: mm(s.speed || 0) };
}

// Recorder. push(input) once per fixed step with the shaped input the engine was given.
export function createDriveRecorder({ name = '', dt, engine, start, origin }) {
  if (!(dt > 0)) throw Error('a drive needs its fixed step dt');
  if (!engine) throw Error('a drive needs the engine id that ran it');
  const runs = [];
  let steps = 0;
  const startRec = { e: mm(origin.e + start.pos[0]), n: mm(origin.n + start.pos[1]), z: mm(start.pos[2]), yaw: rad(start.yaw), speed: mm(start.speed || 0) };
  return {
    get steps() { return steps; },
    push(input) {
      const v = [input.drive, input.brake, input.steer, input.handbrake ? 1 : 0];
      const last = runs[runs.length - 1];
      if (last && same(last.slice(1), v)) last[0]++; else runs.push([1, ...v]);
      steps++;
    },
    // stop(endVehicleState) -> the drive, ready for exportDrive()
    stop(end) {
      return { schema: SCHEMA, name: String(name).slice(0, LIMITS.name), dt, engine: String(engine), start: startRec, steps, runs: runs.map(r => r.slice()), end: endState(end) };
    }
  };
}

// Canonical text of a drive without its hash: fixed key order, so the hash does not depend on how it was built.
export function canonical(d) {
  return JSON.stringify({ schema: d.schema, name: d.name, dt: d.dt, engine: d.engine, start: d.start, steps: d.steps, runs: d.runs, end: d.end });
}

export async function sha256(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function exportDrive(d) {
  const body = canonical(d);
  return JSON.stringify({ ...JSON.parse(body), sha256: await sha256(body) });
}

// Parse and check a drive file. Throws with a plain reason on anything wrong.
export async function importDrive(text) {
  if (text.length > LIMITS.fileBytes) throw Error(`the file is over ${LIMITS.fileBytes / 1048576} MB`);
  let d;
  try { d = JSON.parse(text); } catch { throw Error('the file is not JSON'); }
  if (d?.schema !== SCHEMA) throw Error(`not a drive file (schema should be ${SCHEMA})`);
  if (!(d.dt > 0) || !Array.isArray(d.runs) || !d.start || !d.end || typeof d.engine !== 'string') throw Error('the drive is missing a field');
  if (d.runs.length > LIMITS.runs || d.steps > LIMITS.steps) throw Error('the drive is too long');
  let n = 0;
  for (const r of d.runs) {
    if (!Array.isArray(r) || r.length !== 5 || !Number.isInteger(r[0]) || r[0] < 1 || !r.every(Number.isFinite)) throw Error('a step in the drive is malformed');
    n += r[0];
  }
  if (n !== d.steps) throw Error(`the drive says ${d.steps} steps but holds ${n}`);
  if (!HEX64.test(d.sha256 || '')) throw Error('the drive has no sha256');
  if (await sha256(canonical(d)) !== d.sha256) throw Error('the drive has been altered since it was saved (sha256 differs)');
  return d;
}

// Expand the runs lazily: yields one input per step.
export function* inputs(d) {
  for (const [count, drive, brake, steer, handbrake] of d.runs) {
    const input = Object.freeze({ drive, brake, steer, handbrake });
    for (let i = 0; i < count; i++) yield input;
  }
}

// Replay a drive through an engine step(state, input, dt) -> state. Returns { state, match, diff } where match is
// true only when the end state is the recorded one to the millimetre. onStep(state, i) may sample poses for a tour.
// The engine id is checked first: a different engine is not expected to reproduce the drive, and says so.
export function replay(d, { step, engineId, start, onStep = () => {} }) {
  if (engineId !== d.engine) return { state: start, match: false, diff: `recorded with ${d.engine}, replaying with ${engineId}` };
  let s = start, i = 0;
  for (const input of inputs(d)) { s = step(s, input, d.dt); onStep(s, i++); }
  const got = endState(s), want = d.end;
  const bad = Object.keys(want).filter(k => got[k] !== want[k]);
  return { state: s, match: bad.length === 0, diff: bad.map(k => `${k}: ${got[k]} vs ${want[k]}`).join(', ') };
}

// Poses sampled during a replay -> keyframes in the world tour's field names ({ t, e, n, z, yaw, pitch }), so a
// drive can be shown by the world's tour player. `every` is in steps.
export function toTourKeyframes(d, poses, origin, every) {
  const k = [];
  poses.forEach((p, i) => {
    if (i % every && i !== poses.length - 1) return;
    k.push({ t: Math.round((i + 1) * d.dt * 1e3) / 1e3, e: mm(origin.e + p.pos[0]), n: mm(origin.n + p.pos[1]), z: mm(p.pos[2] + 1.25), yaw: rad(p.yaw), pitch: rad(p.pitch || 0) });
  });
  return k;
}
