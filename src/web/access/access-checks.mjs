// access-checks.mjs: can a delivery vehicle use this route? Access-track checks worked out from a driven trace or a designed road.
//
// A plug for the buggy engine. Pure ES module: no DOM, no fetch, no dependencies, no clocks, no randomness. Every walk runs on a
// fixed step along the route, so the same inputs give the same numbers on every device. Nothing runs until a function is called.
//
// Local metres: x east, y north, z up. Chainage s runs along the route in plan.
//
// What it checks, per vehicle:
//   gradient        steepest grade over a short base length, against the vehicle's limit
//   cross-slope     side slope under the wheels, against the vehicle's limit (a tall load rolls over first)
//   bend            the tightest bend, against the tightest circle the vehicle can steer
//   swept path      every body corner and every wheel simulated along the centreline (the rear follows the front on a
//                   tractrix); wheels must stay on the carriageway, body overhang over the verge is reported for a look
//   gate            clear width of each gate against the swept width through it
//   grounding       a long low deck between its supports against the ground rising above the chord (a hump or crest)
//   structure       bridge / culvert gross and axle rating, width limits, headroom (overhead structures and lines)
//   soft ground     the vehicle's ground pressure against the bearing of any soft zone the route crosses unsurfaced
//
// Every figure below is ASSUMED, typical and editable; none is a design value for any site. Standards are cited by number only.
// Results use the check-HUD shape: { id, failed, severity, line, at, working: { inputs, standard, note } }.
// severity 'block' means the vehicle cannot pass at these assumptions; 'check' means an engineer must look (missing data,
// overhang over the verge, a structure without a rating).

export const NOTE = 'Illustrative. Every vehicle figure and limit is assumed and editable; confirm with the haulier, the crane supplier and the structure owner.';
export const STEP = 0.25;      // m, the fixed step of every walk along the route
export const GRADE_BASE = 10;  // m, the base length a gradient is measured over (short enough to find a steep pitch, long enough to ignore noise)
export const CROSS_TRACK = 2;  // m, the track width a cross-slope is measured across when the vehicle gives none
export const BEND_BASE = 5;    // m, half the chord a bend radius is measured over
export const GATE_MARGIN = 0.3;  // m, clearance each side of the swept width through a gate (ASSUMED)
export const HEAD_MARGIN = 0.3;  // m, clearance above the vehicle under a structure (ASSUMED); overhead lines use their own rule
export const NEAR = 10;        // m, a structure, gate or zone further than this from the centreline is not on the route
const EPS = 1e-9;

// ---- vehicles (every figure ASSUMED, typical, editable) --------------------------------------------------------------
// units[]: the rigid parts, front first. wheelbase = steering axle to the rear axle group centre (unit 0), or kingpin to the
// axle group centre (a trailer). front/rear = overhang ahead of the front point / behind the axle. hitch = kingpin distance
// behind the unit's rear axle (0 = over it, negative = ahead of it).
// deckSpan/deckClearance: the longest unsupported low deck and its height over a level road (the grounding check).
export const VEHICLES = Object.freeze({
  'hgv-artic': Object.freeze({
    label: 'Articulated HGV, 16.5 m', width: 2.55, height: 4.0, grossT: 44, axleT: 11.5, groundKPa: 550,
    maxGrade: 0.10, maxCross: 0.05, minRadius: 11.1, deckSpan: 7.7, deckClearance: 0.3,
    units: Object.freeze([
      Object.freeze({ wheelbase: 3.8, front: 1.4, rear: 0.8, hitch: 0 }),
      Object.freeze({ wheelbase: 7.7, front: 1.6, rear: 3.6 }),
    ]),
    source: 'Lengths and the turning circle as the vehicle dimensions directive 96/53/EC allows; the rest assumed',
  }),
  'low-loader-transformer': Object.freeze({
    label: 'Low-loader with a transformer (abnormal indivisible load)', width: 3.5, height: 4.9, grossT: 130, axleT: 12, groundKPa: 600,
    maxGrade: 0.08, maxCross: 0.03, minRadius: 14, deckSpan: 12, deckClearance: 0.15,
    units: Object.freeze([
      Object.freeze({ wheelbase: 4.2, front: 1.4, rear: 0.8, hitch: 0 }),
      Object.freeze({ wheelbase: 12, front: 2.0, rear: 2.0 }),
    ]),
    source: 'Movement under SI 2003/1998 (special types); every figure assumed, the haulier gives the real ones',
  }),
  'mobile-crane': Object.freeze({
    label: 'All-terrain mobile crane, 5 axle', width: 3.0, height: 4.0, grossT: 60, axleT: 12, groundKPa: 650,
    maxGrade: 0.10, maxCross: 0.04, minRadius: 10, deckSpan: 0, deckClearance: 0.35,
    units: Object.freeze([Object.freeze({ wheelbase: 6.6, front: 2.8, rear: 3.0 })]),
    source: 'Effective wheelbase of a multi-axle steered crane is approximate; every figure assumed',
  }),
  'car-4x4': Object.freeze({
    label: 'Four-wheel-drive car (site visit, sales drive-through)', width: 1.9, height: 1.9, grossT: 2.8, axleT: 1.6, groundKPa: 250,
    maxGrade: 0.25, maxCross: 0.15, minRadius: 6, deckSpan: 0, deckClearance: 0.2,
    units: Object.freeze([Object.freeze({ wheelbase: 2.9, front: 0.9, rear: 1.0 })]),
    source: 'Typical figures, assumed',
  }),
});

const vehicleOf = (v) => {
  const o = typeof v === 'string' ? VEHICLES[v] : v;
  if (!o || !Array.isArray(o.units) || !o.units.length) throw new Error(`access: unknown vehicle ${typeof v === 'string' ? v : ''}`.trim());
  return o;
};

// ---- profile: the route as stations every STEP metres --------------------------------------------------------------------
// profileOf(route, { step }) accepts one of:
//   a road object (web/world/road.mjs createRoad): pointAt, designLevel, length2d, width, finishedAt, surface
//   { path: [[x, y], ...], groundAt(x, y), width?, surface? }            a line drawn over the ground
//   { trace: [[x, y, z], ...], width?, surface?, cross?: [slope, ...] }   a driven trace (the buggy's log), cross-slope optional
// Returns { length, width, surface, stations: [{ s, x, y, z, cross, tx, ty }] }. cross = side slope, positive falling to the right.
export function profileOf(route, { step = STEP, track = CROSS_TRACK } = {}) {
  if (!route || typeof route !== 'object') throw new Error('access: route must be an object');
  const width = Number.isFinite(route.width) ? route.width : null;
  const surface = route.surface ?? (route.trace ? 'unknown' : 'none');
  let pointAt, zAt, crossAt, L;
  if (typeof route.pointAt === 'function' && typeof route.designLevel === 'function') {
    L = route.length2d;
    pointAt = route.pointAt; zAt = (s) => route.designLevel(s);
    crossAt = typeof route.finishedAt === 'function'
      ? (s) => (route.finishedAt(s, track / 2) - route.finishedAt(s, -track / 2)) / track
      : () => 0;
  } else {
    const line = route.trace ? route.trace.map((p) => [Number(p[0]), Number(p[1])]) : route.path;
    const pl = polyline(line);
    L = pl.length; pointAt = pl.pointAt;
    if (route.trace) {
      const zs = route.trace.map((p) => Number(p[2]));
      zAt = (s) => pl.interp(s, zs);
      crossAt = Array.isArray(route.cross) ? (s) => pl.interp(s, route.cross.map(Number)) : () => 0;
    } else {
      if (typeof route.groundAt !== 'function') throw new Error('access: a path needs groundAt(x, y)');
      zAt = (s) => { const [x, y] = pointAt(s); return route.groundAt(x, y); };
      crossAt = (s) => {
        const [x, y] = pointAt(s), [tx, ty] = pl.tangentAt(s), nx = -ty, ny = tx; // left normal
        return (route.groundAt(x + nx * track / 2, y + ny * track / 2) - route.groundAt(x - nx * track / 2, y - ny * track / 2)) / track;
      };
    }
  }
  if (!(L > EPS)) throw new Error('access: route has no length');
  const n = Math.max(1, Math.ceil(L / step)), stations = [];
  for (let k = 0; k <= n; k++) {
    const s = (k * L) / n, [x, y] = pointAt(s);
    stations.push({ s, x, y, z: zAt(s), cross: crossAt(s), tx: 0, ty: 0 });
  }
  setTangents(stations);
  return { length: L, width, surface, stations };
}

/** Joins profiles end to start (a route over several roads). Chainage continues; widths keep the narrowest known. */
export function joinProfiles(list) {
  if (!list.length) throw new Error('access: nothing to join');
  const stations = [];
  let s0 = 0;
  for (const p of list) {
    const first = stations.length ? stations.at(-1) : null;
    for (const st of p.stations) {
      if (first && Math.hypot(st.x - first.x, st.y - first.y) < 1e-6 && st === p.stations[0]) continue;
      stations.push({ ...st, s: s0 + st.s });
    }
    s0 += p.length;
  }
  setTangents(stations);
  const widths = list.map((p) => p.width).filter(Number.isFinite);
  const surfaces = [...new Set(list.map((p) => p.surface))];
  return { length: s0, width: widths.length ? Math.min(...widths) : null, surface: surfaces.length === 1 ? surfaces[0] : 'mixed', stations, parts: list.length };
}

function setTangents(st) {
  for (let i = 0; i < st.length; i++) {
    const a = st[Math.max(0, i - 1)], b = st[Math.min(st.length - 1, i + 1)];
    const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    st[i].tx = (b.x - a.x) / d; st[i].ty = (b.y - a.y) / d;
  }
}

function polyline(path) {
  if (!Array.isArray(path)) throw new Error('access: path must be an array of [x, y]');
  const pts = [];
  for (const p of path) {
    const q = [Number(p[0]), Number(p[1])], last = pts.at(-1);
    if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-6) pts.push(q);
  }
  if (pts.length < 2) throw new Error('access: path needs two distinct points');
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const seg = (s) => { let i = 0; while (i < pts.length - 2 && s > cum[i + 1]) i++; return i; };
  const at = (s) => { const c = Math.min(Math.max(s, 0), cum.at(-1)), i = seg(c); return [i, (c - cum[i]) / (cum[i + 1] - cum[i])]; };
  return {
    length: cum.at(-1),
    pointAt: (s) => { const [i, t] = at(s); return [pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1])]; },
    tangentAt: (s) => { const [i] = at(s), d = cum[i + 1] - cum[i]; return [(pts[i + 1][0] - pts[i][0]) / d, (pts[i + 1][1] - pts[i][1]) / d]; },
    interp: (s, v) => { const [i, t] = at(s); return v[i] + t * (v[i + 1] - v[i]); },
  };
}

// ---- helpers on a profile -----------------------------------------------------------------------------------------------
const idxAt = (P, s) => { // nearest station by chainage (stations may be unevenly spaced after a join)
  const st = P.stations; let lo = 0, hi = st.length - 1;
  if (s <= st[0].s) return 0;
  if (s >= st[hi].s) return hi;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (st[m].s <= s) lo = m; else hi = m; }
  return s - st[lo].s <= st[hi].s - s ? lo : hi;
};
const zAtS = (P, s) => {
  const st = P.stations, c = Math.min(Math.max(s, 0), P.length);
  let lo = 0, hi = st.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (st[m].s <= c) lo = m; else hi = m; }
  const a = st[lo], b = st[hi], t = b.s > a.s ? (c - a.s) / (b.s - a.s) : 0;
  return a.z + t * (b.z - a.z);
};
/** Contiguous runs of stations where bad(i) holds: [{ from, to, i0, i1 }]. */
function runs(P, bad) {
  const out = []; let open = null;
  P.stations.forEach((st, i) => {
    if (bad(i)) { if (!open) open = { from: st.s, to: st.s, i0: i, i1: i }; open.to = st.s; open.i1 = i; }
    else if (open) { out.push(open); open = null; }
  });
  if (open) out.push(open);
  return out;
}
const pct = (g) => `${(100 * g).toFixed(1)}%`;
const ch = (s) => `CH ${Math.round(s)} M`;
const atOf = (P, s) => { const st = P.stations[idxAt(P, s)]; return { s, x: st.x, y: st.y }; };

/** Grade at every station over GRADE_BASE (central difference, ends one-sided). */
export function grades(P, base = GRADE_BASE) {
  return P.stations.map((st) => {
    const a = Math.max(0, st.s - base / 2), b = Math.min(P.length, st.s + base / 2);
    return b - a > EPS ? (zAtS(P, b) - zAtS(P, a)) / (b - a) : 0;
  });
}

/** Plan radius at every station: the circle through the points BEND_BASE before and after (Infinity on a straight). */
export function radii(P, half = BEND_BASE) {
  const st = P.stations;
  return st.map((m) => {
    if (m.s - half < 0 || m.s + half > P.length) return Infinity;
    const a = st[idxAt(P, m.s - half)], b = st[idxAt(P, m.s + half)];
    const ab = Math.hypot(b.x - a.x, b.y - a.y), am = Math.hypot(m.x - a.x, m.y - a.y), mb = Math.hypot(b.x - m.x, b.y - m.y);
    const cross2 = Math.abs((m.x - a.x) * (b.y - a.y) - (m.y - a.y) * (b.x - a.x));
    return cross2 < 1e-9 ? Infinity : (ab * am * mb) / (2 * cross2);
  });
}

// ---- swept path: the pair ------------------------------------------------------------------------------------------------
/**
 * Analytic steady state on a circle: the radius of each axle when the front axle centre runs on radius R.
 * Returns { axles: [R0, R1, ...], innerWheel, outerBody } or null when R is tighter than the first wheelbase.
 */
export function steadyState(vehicle, R) {
  const V = vehicleOf(vehicle), w = V.width / 2, axles = [];
  let front = R;
  for (let k = 0; k < V.units.length; k++) {
    const u = V.units[k];
    if (front <= u.wheelbase) return null;
    const rear = Math.sqrt(front * front - u.wheelbase * u.wheelbase);
    axles.push(rear);
    front = Math.sqrt(rear * rear + (u.hitch ?? 0) ** 2); // the kingpin behind (or ahead of) the axle, on its own radius
  }
  const u0 = V.units[0];
  return {
    front: R, axles,
    innerWheel: Math.min(...axles) - w,
    outerBody: Math.hypot(R + w, u0.front),
  };
}

/**
 * Simulates the vehicle along the centreline on the fixed step: the front axle centre follows the centreline exactly,
 * each rear axle follows its front point on a tractrix (it moves straight towards it, keeping the wheelbase), a trailer's
 * front point is the tractor's kingpin. Before the start the vehicle stands straight behind the first tangent.
 * Returns per station the furthest left and right offsets of the wheels and of the body: { wheelL, wheelR, bodyL, bodyR }
 * (metres from the centreline, left positive in wheelL/bodyL, right positive in wheelR/bodyR), and the poses when asked.
 */
export function sweep(P, vehicle, { step = STEP, keepPoses = false } = {}) {
  const V = vehicleOf(vehicle), st = P.stations, n = st.length, w = V.width / 2;
  const wheelL = new Float64Array(n), wheelR = new Float64Array(n), bodyL = new Float64Array(n), bodyR = new Float64Array(n);
  const s0 = st[0], t0 = [s0.tx, s0.ty];
  // initial pose: straight behind the start
  const units = []; let fx = s0.x, fy = s0.y;
  for (const u of V.units) {
    const rx = fx - t0[0] * u.wheelbase, ry = fy - t0[1] * u.wheelbase;
    units.push({ u, fx, fy, rx, ry });
    fx = rx - t0[0] * (u.hitch ?? 0); fy = ry - t0[1] * (u.hitch ?? 0);
  }
  const poses = keepPoses ? [] : null;
  const L = P.length, nSteps = Math.max(1, Math.ceil(L / step));
  for (let k = 0; k <= nSteps; k++) {
    const s = Math.min(L, (k * L) / nSteps);
    // advance: front point of unit 0 to the centreline; each rear axle on its tractrix; the next unit's front to the kingpin
    let [px, py] = interpXY(P, s);
    for (let j = 0; j < units.length; j++) {
      const U = units[j];
      U.fx = px; U.fy = py;
      let dx = U.fx - U.rx, dy = U.fy - U.ry; const d = Math.hypot(dx, dy) || 1;
      dx /= d; dy /= d;
      U.rx = U.fx - dx * U.u.wheelbase; U.ry = U.fy - dy * U.u.wheelbase;
      U.hx = dx; U.hy = dy;
      px = U.rx - dx * (U.u.hitch ?? 0); py = U.ry - dy * (U.u.hitch ?? 0);
    }
    if (poses) poses.push(units.map((U) => ({ fx: U.fx, fy: U.fy, rx: U.rx, ry: U.ry })));
    // wheels (the axle ends) and body corners, each offset against the nearest centreline station near this step
    for (const U of units) {
      const nx = -U.hy, ny = U.hx; // left normal of the unit
      const front = [U.fx + U.hx * U.u.front, U.fy + U.hy * U.u.front], rear = [U.rx - U.hx * U.u.rear, U.ry - U.hy * U.u.rear];
      const wheels = [[U.fx, U.fy], [U.rx, U.ry]].flatMap(([x, y]) => [[x + nx * w, y + ny * w], [x - nx * w, y - ny * w]]);
      const body = [front, rear].flatMap(([x, y]) => [[x + nx * w, y + ny * w], [x - nx * w, y - ny * w]]);
      for (const [x, y] of wheels) mark(P, x, y, s, wheelL, wheelR);
      for (const [x, y] of body) mark(P, x, y, s, bodyL, bodyR);
    }
  }
  return { wheelL, wheelR, bodyL, bodyR, poses };
}

function interpXY(P, s) {
  const st = P.stations, c = Math.min(Math.max(s, 0), P.length);
  let lo = 0, hi = st.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (st[m].s <= c) lo = m; else hi = m; }
  const a = st[lo], b = st[hi], t = b.s > a.s ? (c - a.s) / (b.s - a.s) : 0;
  return [a.x + t * (b.x - a.x), a.y + t * (b.y - a.y)];
}

// Offset of (x, y) from the centreline: nearest station within 60 m behind and 10 m ahead of the front axle.
function mark(P, x, y, s, Lft, Rgt) {
  const st = P.stations, i0 = idxAt(P, s - 60), i1 = idxAt(P, s + 10);
  let best = -1, bd = Infinity;
  for (let i = i0; i <= i1; i++) { const d = (st[i].x - x) ** 2 + (st[i].y - y) ** 2; if (d < bd) { bd = d; best = i; } }
  const m = st[best], off = (x - m.x) * -m.ty + (y - m.y) * m.tx; // left positive
  if (off >= 0) { if (off > Lft[best]) Lft[best] = off; } else if (-off > Rgt[best]) Rgt[best] = -off;
}

// ---- the checks --------------------------------------------------------------------------------------------------------
/**
 * accessChecks(profile, vehicle, { gates, structures, softZones, limits }) -> [check]
 * gates:      [{ x, y, width, label? }]                          clear opening
 * structures: [{ x, y, kind, grossT?, axleT?, widthM?, clearanceM?, label? }]
 *             kind: 'bridge' | 'culvert' (rated for load), 'overhead' (a structure over the road: clearance),
 *                   'line' (an overhead line: clearance under the lowest conductor), 'width' (a width restriction)
 * softZones:  [{ polygon: [[x, y], ...], bearingKPa, label? }]
 * limits:     overrides of the vehicle's maxGrade / maxCross / minRadius
 */
export function accessChecks(P, vehicle, { gates = [], structures = [], softZones = [], limits = {} } = {}) {
  const V = { ...vehicleOf(vehicle), ...limits }, name = String(V.label).toUpperCase().split(/[,(]/)[0].trim();
  const out = [];
  const add = (id, failed, severity, line, at, inputs, standard, extra = {}) =>
    out.push({ id, failed: !!failed, severity: failed ? severity : null, line, at, working: { inputs, standard, note: NOTE }, ...extra });

  // gradient
  const g = grades(P), gAbs = g.map(Math.abs), gMax = Math.max(...gAbs), iG = gAbs.indexOf(gMax);
  const steep = runs(P, (i) => gAbs[i] > V.maxGrade + 1e-12).map((r) => ({ from: r.from, to: r.to, max: Math.max(...gAbs.slice(r.i0, r.i1 + 1)) }));
  add('gradient', steep.length > 0, 'block', `${name} GRADIENT ${pct(gMax)}${steep.length ? ` > ${pct(V.maxGrade)} AT ${ch(P.stations[iG].s)}` : ` ≤ ${pct(V.maxGrade)}`}`,
    atOf(P, P.stations[iG].s), [['Steepest grade', `${pct(gMax)} over ${GRADE_BASE} m`], ['Limit for this vehicle', `${pct(V.maxGrade)} (assumed)`],
      ['Direction', g[iG] >= 0 ? 'rising in the direction of travel' : 'falling in the direction of travel'], ['Runs above the limit', steep.length]],
    'Assumed limit; the haulier sets it for the loaded vehicle (traction, braking, a pusher unit)', { sections: steep });

  // cross-slope
  const c = P.stations.map((st) => Math.abs(st.cross)), cMax = Math.max(...c), iC = c.indexOf(cMax);
  const side = runs(P, (i) => c[i] > V.maxCross + 1e-12).map((r) => ({ from: r.from, to: r.to, max: Math.max(...c.slice(r.i0, r.i1 + 1)) }));
  add('cross-slope', side.length > 0, 'block', `${name} CROSS-SLOPE ${pct(cMax)}${side.length ? ` > ${pct(V.maxCross)} AT ${ch(P.stations[iC].s)}` : ` ≤ ${pct(V.maxCross)}`}`,
    atOf(P, P.stations[iC].s), [['Steepest side slope', pct(cMax)], ['Limit for this vehicle', `${pct(V.maxCross)} (assumed; a tall load sets it)`]],
    'Assumed limit; the haulier and the load centre of gravity set it', { sections: side });

  // bend radius
  const R = radii(P), rMin = Math.min(...R), iR = R.indexOf(rMin);
  add('bend', rMin < V.minRadius - 1e-9, 'block', Number.isFinite(rMin) ? `${name} BEND R ${rMin.toFixed(1)} M${rMin < V.minRadius ? ` < ${V.minRadius} M AT ${ch(P.stations[iR].s)}` : ''}` : `${name} NO BENDS`,
    atOf(P, P.stations[Number.isFinite(rMin) ? iR : 0].s), [['Tightest centreline radius', Number.isFinite(rMin) ? `${rMin.toFixed(1)} m over a ${2 * BEND_BASE} m chord` : 'straight'],
      ['Tightest the vehicle steers', `${V.minRadius} m at the front axle (assumed)`]],
    '96/53/EC (turning circle of a compliant vehicle: 12.5 m outer, 5.3 m inner radius); others assumed');

  // swept path
  const S = sweep(P, V), half = Number.isFinite(P.width) ? P.width / 2 : null;
  if (half != null) {
    const wheelOut = runs(P, (i) => S.wheelL[i] > half + 1e-9 || S.wheelR[i] > half + 1e-9);
    const bodyOut = runs(P, (i) => S.bodyL[i] > half + 1e-9 || S.bodyR[i] > half + 1e-9);
    const worst = Math.max(...S.wheelL, ...S.wheelR), bw = Math.max(...S.bodyL, ...S.bodyR);
    const iW = wheelOut.length ? wheelOut[0].i0 : 0;
    add('swept-wheels', wheelOut.length > 0, 'block', `${name} SWEPT PATH: WHEELS ${(worst - half).toFixed(2)} M OFF THE ${P.width} M CARRIAGEWAY${wheelOut.length ? ` AT ${ch(wheelOut[0].from)}` : ''}`,
      atOf(P, P.stations[iW].s), [['Carriageway width', `${P.width} m`], ['Furthest wheel from the centreline', `${worst.toFixed(2)} m`], ['Runs off the carriageway', wheelOut.length]],
      'Swept path by simulation (tractrix); a local widening or a larger bend radius clears it', { sections: wheelOut.map(({ from, to }) => ({ from, to })) });
    if (wheelOut.length === 0) out.at(-1).line = `${name} SWEPT PATH: WHEELS ON THE ${P.width} M CARRIAGEWAY`;
    add('swept-body', bodyOut.length > 0, 'check', `${name} BODY OVERHANG ${(bw - half).toFixed(2)} M OVER THE VERGE${bodyOut.length ? ` AT ${ch(bodyOut[0].from)}` : ''}`,
      atOf(P, P.stations[bodyOut.length ? bodyOut[0].i0 : 0].s), [['Furthest body corner', `${bw.toFixed(2)} m from the centreline`], ['Half carriageway', `${half} m`]],
      'Check the verge is clear of posts, cabinets and fences over the marked runs', { sections: bodyOut.map(({ from, to }) => ({ from, to })) });
  } else {
    add('swept-wheels', true, 'check', `${name} SWEPT PATH: NO CARRIAGEWAY WIDTH HELD`, atOf(P, 0), [['Carriageway width', 'not given']], 'Give the road width to check the swept path');
  }

  // gates
  for (const [k, gt] of gates.entries()) {
    const i = nearest(P, gt.x, gt.y);
    if (i.d > NEAR) continue;
    let need = 0;
    const lo = idxAt(P, P.stations[i.i].s - 2), hi = idxAt(P, P.stations[i.i].s + 2);
    for (let j = lo; j <= hi; j++) need = Math.max(need, S.bodyL[j] + S.bodyR[j]);
    const req = need + 2 * GATE_MARGIN;
    add(`gate-${k}`, !(gt.width >= req - 1e-9), 'block', `${name} GATE ${gt.label ?? k + 1} ${gt.width} M ${gt.width >= req ? '≥' : '<'} ${req.toFixed(2)} M NEEDED`, atOf(P, P.stations[i.i].s),
      [['Clear opening', `${gt.width} m`], ['Swept width through it', `${need.toFixed(2)} m`], ['Margin each side', `${GATE_MARGIN} m (assumed)`]],
      'Swept width by simulation plus an assumed margin');
  }

  // grounding over a crest: a deck of span D, supported at both ends, clears the ground by deckClearance on the level
  if (V.deckSpan > 0) {
    const D = V.deckSpan, h = P.stations.length > 1 ? P.stations[1].s : 1, m = Math.max(2, Math.round(D / h));
    let worst = -Infinity, iWorst = 0;
    const hits = new Uint8Array(P.stations.length);
    for (let i = m; i < P.stations.length; i++) {
      const a = P.stations[i - m], b = P.stations[i];
      for (let j = i - m + 1; j < i; j++) {
        const t = (P.stations[j].s - a.s) / (b.s - a.s), rise = P.stations[j].z - (a.z + t * (b.z - a.z));
        if (rise > worst) { worst = rise; iWorst = j; }
        if (rise > V.deckClearance) hits[j] = 1;
      }
    }
    const gr = runs(P, (i) => hits[i]);
    add('grounding', gr.length > 0, 'block', `${name} GROUNDING: GROUND ${worst.toFixed(2)} M ABOVE A ${D} M DECK CHORD${gr.length ? ` > ${V.deckClearance} M AT ${ch(P.stations[iWorst].s)}` : ''}`,
      atOf(P, P.stations[iWorst].s), [['Unsupported deck', `${D} m (assumed)`], ['Deck clearance on the level', `${V.deckClearance} m (assumed)`], ['Largest rise above the chord', `${worst.toFixed(3)} m`]],
      'Geometry only; hydraulic suspension travel is not credited', { sections: gr.map(({ from, to }) => ({ from, to })) });
  }

  // structures
  for (const [k, sd] of structures.entries()) {
    const i = nearest(P, sd.x, sd.y);
    if (i.d > NEAR) continue;
    const at = atOf(P, P.stations[i.i].s), lab = String(sd.label ?? `${sd.kind} ${k + 1}`).toUpperCase();
    if (sd.kind === 'bridge' || sd.kind === 'culvert') {
      if (!Number.isFinite(sd.grossT) && !Number.isFinite(sd.axleT)) {
        add(`structure-${k}`, true, 'check', `${lab}: NO LOAD RATING HELD, ASSESSMENT NEEDED FOR ${V.grossT} T`, at,
          [['Structure', sd.kind], ['Rating', 'none held'], ['Vehicle gross', `${V.grossT} t`], ['Heaviest axle', `${V.axleT} t`]],
          'CS 454 (assessment of highway bridges and structures); the structure owner confirms');
      } else {
        const overG = Number.isFinite(sd.grossT) && V.grossT > sd.grossT, overA = Number.isFinite(sd.axleT) && V.axleT > sd.axleT;
        add(`structure-${k}`, overG || overA, 'block', `${lab}: ${overG ? `GROSS ${V.grossT} T > ${sd.grossT} T` : overA ? `AXLE ${V.axleT} T > ${sd.axleT} T` : 'RATING COVERS THIS VEHICLE'}`, at,
          [['Rated gross', sd.grossT ?? 'not given'], ['Rated axle', sd.axleT ?? 'not given'], ['Vehicle gross', `${V.grossT} t`], ['Heaviest axle', `${V.axleT} t`]],
          'CS 454; ratings as given, not checked here');
      }
      if (Number.isFinite(sd.widthM) && sd.widthM < V.width + 2 * GATE_MARGIN)
        add(`structure-${k}-width`, true, 'block', `${lab}: WIDTH ${sd.widthM} M < ${(V.width + 2 * GATE_MARGIN).toFixed(2)} M`, at,
          [['Width between parapets', `${sd.widthM} m`], ['Vehicle width', `${V.width} m`]], 'Assumed margin each side');
    } else if (sd.kind === 'overhead' || sd.kind === 'line') {
      const margin = sd.kind === 'line' ? (sd.marginM ?? 1) : HEAD_MARGIN;
      const need = V.height + margin, ok = Number.isFinite(sd.clearanceM) && sd.clearanceM >= need;
      add(`structure-${k}`, !ok, sd.kind === 'line' || !Number.isFinite(sd.clearanceM) ? 'check' : 'block',
        Number.isFinite(sd.clearanceM) ? `${lab}: CLEARANCE ${sd.clearanceM} M ${ok ? '≥' : '<'} ${need.toFixed(1)} M` : `${lab}: NO CLEARANCE HELD`, at,
        [['Clearance', sd.clearanceM ?? 'not given'], ['Vehicle height', `${V.height} m`], ['Margin', `${margin} m (assumed)`]],
        sd.kind === 'line' ? 'HSE GS6 (avoiding danger from overhead power lines); the line owner sets the safe clearance' : 'CD 127 (headroom); margin assumed');
    } else if (sd.kind === 'width') {
      add(`structure-${k}`, !(sd.widthM >= V.width + 2 * GATE_MARGIN), 'block', `${lab}: WIDTH ${sd.widthM ?? '?'} M FOR A ${V.width} M VEHICLE`, at,
        [['Width', sd.widthM ?? 'not given'], ['Vehicle width', `${V.width} m`]], 'Assumed margin each side');
    }
  }

  // soft ground
  const unsurfaced = P.surface === 'none' || P.surface === 'unknown';
  for (const [k, z] of softZones.entries()) {
    const inside = runs(P, (i) => pointInPolygon(P.stations[i].x, P.stations[i].y, z.polygon));
    if (!inside.length) continue;
    const lab = String(z.label ?? `soft zone ${k + 1}`).toUpperCase();
    if (unsurfaced) {
      const over = V.groundKPa > z.bearingKPa;
      add(`soft-${k}`, over, 'block', `${lab}: ${V.groundKPa} KPA ${over ? '>' : '≤'} ${z.bearingKPa} KPA BEARING, UNSURFACED`, atOf(P, inside[0].from),
        [['Vehicle ground pressure', `${V.groundKPa} kPa (assumed)`], ['Bearing', `${z.bearingKPa} kPa (as given)`], ['Length crossed', `${inside.reduce((t, r) => t + r.to - r.from, 0).toFixed(0)} m`]],
        'Temporary matting or a stone road; the geotechnical engineer confirms', { sections: inside.map(({ from, to }) => ({ from, to })) });
    } else {
      add(`soft-${k}`, true, 'check', `${lab}: ROAD CROSSES SOFT GROUND, CHECK THE BUILD-UP FOR ${V.axleT} T AXLES`, atOf(P, inside[0].from),
        [['Bearing', `${z.bearingKPa} kPa (as given)`], ['Surface', P.surface]], 'Road build-up design for the heaviest axle; the geotechnical engineer confirms',
        { sections: inside.map(({ from, to }) => ({ from, to })) });
    }
  }
  return out;
}

function nearest(P, x, y) {
  let i = 0, d = Infinity;
  P.stations.forEach((st, k) => { const e = Math.hypot(st.x - x, st.y - y); if (e < d) { d = e; i = k; } });
  return { i, d };
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** { passable, blockers, checks } for one vehicle along one profile. */
export function verdict(P, vehicle, ctx = {}) {
  const checks = accessChecks(P, vehicle, ctx);
  const blockers = checks.filter((c) => c.failed && c.severity === 'block'), toCheck = checks.filter((c) => c.failed && c.severity === 'check');
  return { vehicle: typeof vehicle === 'string' ? vehicle : vehicle.label, passable: blockers.length === 0, blockers, toCheck, checks };
}

// ---- "can the transformer get to the station?" -----------------------------------------------------------------------
/**
 * canReach({ roads, from, to, vehicle, ctx, snap }) -> { reached, via, length, blockers, toCheck, checks, reason }
 * roads: routes as profileOf takes them (road objects, paths over the ground, traces). Road ends within snap metres join.
 * from / to: [x, y], each snapped to the nearest road end. The search keeps only the roads this vehicle can use on their own
 * and takes the shortest way through them; the whole way is then checked again as one route, so the turns between roads
 * are checked too. When no way exists, it reports the shortest way ignoring the vehicle and what blocks it.
 */
export function canReach({ roads, from, to, vehicle = 'low-loader-transformer', ctx = {}, snap = 5 }) {
  const profiles = roads.map((r) => profileOf(r));
  const nodes = [];
  const nodeOf = (x, y) => {
    let k = nodes.findIndex((n) => Math.hypot(n[0] - x, n[1] - y) <= snap);
    if (k < 0) { nodes.push([x, y]); k = nodes.length - 1; }
    return k;
  };
  const edges = profiles.map((P, e) => {
    const a = P.stations[0], b = P.stations.at(-1);
    return { e, a: nodeOf(a.x, a.y), b: nodeOf(b.x, b.y), length: P.length, ok: verdict(P, vehicle, ctx).passable };
  });
  const near = ([x, y]) => nodes.reduce((best, n, k) => (Math.hypot(n[0] - x, n[1] - y) < Math.hypot(nodes[best][0] - x, nodes[best][1] - y) ? k : best), 0);
  const src = near(from), dst = near(to);
  const way = (useAll) => dijkstra(nodes.length, edges.filter((E) => useAll || E.ok), src, dst);
  let w = way(false), reason = null;
  if (!w) { w = way(true); reason = w ? 'every way has a blocker for this vehicle' : 'the roads do not connect the two points'; }
  if (!w) return { reached: false, via: [], length: 0, blockers: [], toCheck: [], checks: [], reason };
  const parts = w.map(({ e, forward }) => (forward ? profiles[e] : reverse(profiles[e])));
  const whole = joinProfiles(parts), v = verdict(whole, vehicle, ctx);
  if (!reason && !v.passable) reason = 'each road passes on its own; the turn or run between roads blocks';
  return { reached: v.passable, via: w.map((x) => x.e), length: whole.length, blockers: v.blockers, toCheck: v.toCheck, checks: v.checks, reason, profile: whole };
}

function reverse(P) {
  const L = P.length, st = P.stations.slice().reverse().map((x) => ({ ...x, s: L - x.s, cross: -x.cross }));
  setTangents(st);
  return { ...P, stations: st };
}

function dijkstra(n, edges, src, dst) {
  const dist = new Array(n).fill(Infinity), prev = new Array(n).fill(null), done = new Uint8Array(n);
  dist[src] = 0;
  for (;;) {
    let u = -1;
    for (let k = 0; k < n; k++) if (!done[k] && (u < 0 || dist[k] < dist[u])) u = k;
    if (u < 0 || dist[u] === Infinity) break;
    if (u === dst) break;
    done[u] = 1;
    for (const E of edges) {
      const [v, fwd] = E.a === u ? [E.b, true] : E.b === u ? [E.a, false] : [-1];
      if (v >= 0 && dist[u] + E.length < dist[v]) { dist[v] = dist[u] + E.length; prev[v] = { e: E.e, forward: fwd, from: u }; }
    }
  }
  if (dist[dst] === Infinity) return null;
  if (src === dst) return [];
  const path = [];
  for (let v = dst; v !== src; v = prev[v].from) path.unshift({ e: prev[v].e, forward: prev[v].forward });
  return path;
}

// ---- sales view: a drive-through of a proposed layout -------------------------------------------------------------------
/**
 * tour(profile, { speed, dt, eye, lookAhead, stops }) -> { duration, keys: [{ t, x, y, z, yaw, pitch, caption }] }
 * A fixed-step camera path for the world's chase or driver camera: the eye rides eye metres above the route at speed m/s and
 * looks lookAhead metres ahead; at each stop ({ x, y, caption, holdS }) it pauses and shows the caption. Pure data: the
 * player owns the clock, so nothing runs while the viewer is parked.
 */
export function tour(P, { speed = 6, dt = 0.5, eye = 1.6, lookAhead = 15, stops = [] } = {}) {
  const placed = stops.map((sp) => ({ ...sp, s: P.stations[nearest(P, sp.x, sp.y).i].s, hold: sp.holdS ?? 4 }))
    .filter((sp) => nearest(P, sp.x, sp.y).d <= NEAR).sort((a, b) => a.s - b.s);
  const keys = [];
  let t = 0, s = 0, next = 0, caption = '';
  const pose = (s1) => {
    const [x, y] = interpXY(P, s1), [ax, ay] = interpXY(P, Math.min(P.length, s1 + lookAhead));
    const z = zAtS(P, s1) + eye, za = zAtS(P, Math.min(P.length, s1 + lookAhead)) + eye;
    const d = Math.hypot(ax - x, ay - y);
    return { x, y, z, yaw: d > EPS ? Math.atan2(ay - y, ax - x) : 0, pitch: d > EPS ? Math.atan2(za - z, d) : 0 };
  };
  keys.push({ t: 0, ...pose(0), caption });
  for (;;) {
    if (next < placed.length && s >= placed[next].s - EPS) {
      caption = placed[next].caption;
      const steps = Math.max(1, Math.round(placed[next].hold / dt));
      for (let k = 0; k < steps; k++) { t += dt; keys.push({ t: +t.toFixed(3), ...pose(s), caption }); }
      next++;
      continue;
    }
    if (s >= P.length - EPS) break;
    const sNext = Math.min(P.length, s + speed * dt, next < placed.length ? placed[next].s : Infinity);
    t += (sNext - s) / speed; s = sNext;
    if (next > 0 && s > placed[next - 1].s + 20) caption = ''; // a caption stays for 20 m after its stop
    keys.push({ t: +t.toFixed(3), ...pose(s), caption });
  }
  return { duration: t, keys };
}

/** Plain lines for a landowner or client: the route in numbers, and the delivery answer for each vehicle asked about. */
export function summary(P, verdicts = []) {
  const g = grades(P).map(Math.abs);
  const lines = [
    `Route ${(P.length / 1000).toFixed(2)} km, steepest ${pct(Math.max(...g))}, ${P.width ? `${P.width} m carriageway` : 'width not given'}.`,
  ];
  for (const v of verdicts) {
    lines.push(v.passable
      ? `${v.vehicle}: passes every check at these assumptions${v.toCheck.length ? `; ${v.toCheck.length} item(s) for an engineer to confirm` : ''}.`
      : `${v.vehicle}: ${v.blockers.length} item(s) to resolve before delivery, first at chainage ${Math.round(v.blockers[0].at.s)} m.`);
  }
  lines.push('Illustrative: every vehicle figure and limit is assumed and editable.');
  return lines;
}
