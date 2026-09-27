// site-tour.mjs: guided site tours for demonstrations. A tour is a route along the site's tracks with stops; at each
// stop the buggy comes to rest, a caption shows for the stop's hold time, and it drives on. The guide does not move the
// buggy itself: it produces the same raw driver intent a person would (drive, brake, steer), which goes through the
// same shaping and the same vehicle engine, so a guided drive obeys the same physics and can be recorded like any other.
// Route points are national grid metres ({ e, n }), like the world's tours, so a tour survives any origin rebase.
// Pure: no DOM, no randomness; the caller supplies the vehicle state and the fixed step.

export const SCHEMA = 'buggy.site-tour.v1';
export const LIMITS = Object.freeze({ points: 20000, stops: 200, caption: 280, name: 200, cruiseKmh: [2, 30], hold: [0, 120] });
export const GUIDE = Object.freeze({ wheelbase: 2.2, maxSteer: 0.6, decel: 1.2, gain: 0.9, arrive: 0.8, stopped: 0.15, minLook: 4, lookPerMs: 1.1, captionAfter: 5 });

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// Validate a tour object and return it frozen and normalised, or throw with a plain reason.
export function makeSiteTour(t) {
  if (t?.schema !== SCHEMA) throw Error(`not a site tour (schema should be ${SCHEMA})`);
  const name = String(t.name || '').slice(0, LIMITS.name);
  const route = t.route;
  if (!Array.isArray(route) || route.length < 2 || route.length > LIMITS.points) throw Error(`a tour route needs 2 to ${LIMITS.points} points`);
  route.forEach((p, i) => { if (!Number.isFinite(p?.e) || !Number.isFinite(p?.n)) throw Error(`route point ${i} needs e and n in grid metres`); });
  const cruiseKmh = t.cruiseKmh ?? 12;
  if (!(cruiseKmh >= LIMITS.cruiseKmh[0] && cruiseKmh <= LIMITS.cruiseKmh[1])) throw Error(`cruise speed must be ${LIMITS.cruiseKmh.join(' to ')} km/h`);
  const stops = (t.stops || []).map((s, i) => {
    if (!Number.isInteger(s.at) || s.at < 0 || s.at >= route.length) throw Error(`stop ${i} must name a route point by index`);
    const hold = s.hold ?? 6;
    if (!(hold >= LIMITS.hold[0] && hold <= LIMITS.hold[1])) throw Error(`stop ${i} hold must be ${LIMITS.hold.join(' to ')} s`);
    const caption = String(s.caption || '');
    if (caption.length > LIMITS.caption) throw Error(`stop ${i} caption is over ${LIMITS.caption} characters`);
    return Object.freeze({ at: s.at, hold, caption });
  }).sort((a, b) => a.at - b.at);
  if (stops.length > LIMITS.stops) throw Error(`a tour holds at most ${LIMITS.stops} stops`);
  if (stops.some((s, i) => i && s.at === stops[i - 1].at)) throw Error('two stops share a route point');
  return Object.freeze({ schema: SCHEMA, name, cruiseKmh, route: Object.freeze(route.map(p => Object.freeze({ e: p.e, n: p.n }))), stops: Object.freeze(stops) });
}

// The route in local metres under an origin, with the arc length at every point and the stops as arc lengths.
// The route's last point is always a stop, so a tour ends at rest.
export function compileRoute(tour, origin) {
  const pts = tour.route.map(p => [p.e - origin.e, p.n - origin.n]);
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const stops = tour.stops.map(st => ({ s: s[st.at], hold: st.hold, caption: st.caption }));
  if (!stops.length || stops[stops.length - 1].s < s[s.length - 1]) stops.push({ s: s[s.length - 1], hold: 0, caption: '' });
  return { pts, s, length: s[s.length - 1], stops };
}

// Point at arc length a along the route.
export function pointAt(r, a) {
  a = clamp(a, 0, r.length);
  let i = 1;
  while (i < r.s.length - 1 && r.s[i] < a) i++;
  const s0 = r.s[i - 1], seg = r.s[i] - s0 || 1, u = (a - s0) / seg;
  return [r.pts[i - 1][0] + (r.pts[i][0] - r.pts[i - 1][0]) * u, r.pts[i - 1][1] + (r.pts[i][1] - r.pts[i - 1][1]) * u];
}

// Project a local point onto the route, searching forward from segment `from` only (a window of segments), so a route
// that doubles back on itself is never mistaken for its own later part. Returns { s, seg, off } (off = lateral metres).
export function project(r, [x, y], from = 0, window = 40) {
  let best = { s: r.s[from], seg: from, off: Infinity };
  const end = Math.min(r.pts.length - 1, from + window);
  for (let i = Math.max(1, from); i <= end; i++) {
    const [ax, ay] = r.pts[i - 1], [bx, by] = r.pts[i];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
    const u = clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1);
    const px = ax + dx * u, py = ay + dy * u, d = Math.hypot(x - px, y - py);
    if (d < best.off) best = { s: r.s[i - 1] + (r.s[i] - r.s[i - 1]) * u, seg: i - 1, off: d };
  }
  return best;
}

// The guide. step(vehicle, dt) -> { raw, phase, caption, stop }. vehicle: { pos, yaw, speed } in local metres.
// phase: 'drive' | 'arriving' | 'stopped' | 'paused' | 'done'. raw is marked exact (see controls.shape).
// rebase(shift) keeps the guide on the route when the world moves its origin: pass the same [dx, dy] shift.
export function createGuide(tour, origin, opts = {}) {
  const o = { ...GUIDE, ...opts };
  let r = compileRoute(tour, origin);
  const cruise = tour.cruiseKmh / 3.6;
  let seg = 0, s = 0, next = 0, phase = 'drive', held = 0, caption = '', captionLeft = 0, paused = false;
  const brakeHard = () => ({ drive: 0, brake: 1, steer: 0, handbrake: 0, exact: true });
  return {
    get route() { return r; },
    get phase() { return phase; },
    get progress() { return r.length ? s / r.length : 1; },
    pause(on = !paused) { paused = on; return paused; },
    rebase([dx, dy]) { r = { ...r, pts: r.pts.map(([x, y]) => [x - dx, y - dy]) }; },
    step(v, dt) {
      const p = project(r, v.pos, seg);
      seg = p.seg; s = Math.max(s, p.s);
      if (phase === 'done') return { raw: brakeHard(), phase, caption: '', stop: next };
      if (paused) return { raw: brakeHard(), phase: 'paused', caption, stop: next };
      const stop = r.stops[next];
      if (phase === 'stopped') {
        held += dt;
        if (held >= stop.hold) {
          next++;
          if (next >= r.stops.length) { phase = 'done'; caption = ''; return { raw: brakeHard(), phase, caption, stop: next }; }
          phase = 'drive'; captionLeft = o.captionAfter;
        }
        return { raw: brakeHard(), phase: next >= r.stops.length ? 'done' : 'stopped', caption, stop: next };
      }
      if (captionLeft > 0) { captionLeft -= dt; if (captionLeft <= 0) caption = ''; }
      const togo = r.stops[next].s - s;
      if (togo <= o.arrive && Math.abs(v.speed) < o.stopped) { phase = 'stopped'; held = 0; caption = r.stops[next].caption; captionLeft = 0; return { raw: brakeHard(), phase, caption, stop: next }; }
      phase = togo < 15 ? 'arriving' : 'drive';
      // speed: cruise, less what is needed to stop at the next stop at a gentle deceleration
      const want = Math.min(cruise, Math.sqrt(2 * o.decel * Math.max(0, togo - o.arrive * 0.5)));
      const err = want - v.speed;
      const drive = clamp(err * o.gain, 0, 1), brake = clamp(-err * o.gain, 0, 1);
      // steering: pure pursuit towards a point one look-ahead along the route
      const look = Math.max(o.minLook, o.lookPerMs * Math.abs(v.speed));
      const [tx, ty] = pointAt(r, s + look);
      const dx = tx - v.pos[0], dy = ty - v.pos[1];
      const fwd = dx * Math.sin(v.yaw) + dy * Math.cos(v.yaw), right = dx * Math.cos(v.yaw) - dy * Math.sin(v.yaw);
      const L = Math.max(1e-3, Math.hypot(fwd, right));
      const angle = Math.atan((2 * o.wheelbase * right) / (L * L));
      const steer = clamp(angle / o.maxSteer, -1, 1);
      return { raw: { drive, brake, steer, handbrake: 0, exact: true }, phase, caption, stop: next };
    }
  };
}
