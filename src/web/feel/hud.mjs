// hud.mjs: the drive HUD. Speed, gradient along the heading, and heading, in the world's HUD style: small
// monospace light-grey text over the view. A line turns red only for a genuine limit: speed over the set site
// limit, or gradient beyond the set climb or descent limit. Nothing else is ever red.
// hudLines() is pure; mountDriveHud() writes the lines to the page only when their text changes (no frames of its own).
// Limits are settings, not facts about any vehicle: the defaults are illustrative and editable.

export const DEFAULT_LIMITS = Object.freeze({ speedKmh: 20, gradientPct: 15 });
const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// Heading in whole degrees, 0-359, from a world yaw (0 = north, clockwise positive).
export function headingDeg(yaw) {
  const d = Math.round(((yaw * 180) / Math.PI) % 360);
  return ((d % 360) + 360) % 360;
}
export const compass = deg => POINTS[Math.round(deg / 45) % 8];
// Gradient along the heading, in per cent, from the body pitch (nose up positive).
export const gradientPct = pitch => Math.tan(pitch || 0) * 100;

// { speed m/s (signed), pitch rad, yaw rad } and limits -> [{ key, text, limit }].
export function hudLines(state, limits = DEFAULT_LIMITS) {
  const kmh = Math.abs(state.speed || 0) * 3.6;
  const g = gradientPct(state.pitch);
  const deg = headingDeg(state.yaw || 0);
  const shownKmh = Math.round(kmh), shownG = Math.round(g * 10) / 10;
  const gearR = (state.speed || 0) < -0.05 ? ' R' : '';
  const speedOver = Number.isFinite(limits.speedKmh) && kmh > limits.speedKmh;
  const gradeOver = Number.isFinite(limits.gradientPct) && Math.abs(g) > limits.gradientPct;
  return [
    { key: 'speed', text: `SPD ${String(shownKmh).padStart(3)} km/h${gearR}${speedOver ? `  over ${limits.speedKmh}` : ''}`, limit: speedOver },
    { key: 'grade', text: `GRD ${(shownG >= 0 ? '+' : '') + shownG.toFixed(1)} %${gradeOver ? `  beyond ${limits.gradientPct}` : ''}`, limit: gradeOver },
    { key: 'head', text: `HDG ${String(deg).padStart(3, '0')} ${compass(deg)}`, limit: false }
  ];
}

const CSS = `#drive-hud { position: fixed; right: 10px; bottom: 10px; z-index: 4; pointer-events: none;
  font: 11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: 0.04em; color: #d0d4d8; opacity: 0.85;
  border-top: 1px solid rgba(208, 212, 216, 0.5); padding-top: 3px; text-shadow: 0 0 2px rgba(0, 0, 0, 0.9); white-space: pre; }
#drive-hud[hidden] { display: none; }
#drive-hud .lim { color: #ff3b30; }
#drive-caption { position: fixed; left: 50%; bottom: 44px; transform: translateX(-50%); max-width: min(560px, calc(100vw - 32px));
  z-index: 4; pointer-events: none; font: 13px/1.45 system-ui, sans-serif; color: #e8eaec; background: rgba(0, 0, 0, 0.55);
  padding: 6px 10px; border-radius: 4px; text-align: center; }
#drive-caption[hidden] { display: none; }
@media print { #drive-hud, #drive-caption { display: none !important; } }`;

// Mount the HUD and the tour caption strip. update(state) redraws only on a change of shown text.
export function mountDriveHud({ doc = document, limits = DEFAULT_LIMITS } = {}) {
  if (!doc.getElementById('drive-hud-style')) { const s = doc.createElement('style'); s.id = 'drive-hud-style'; s.textContent = CSS; doc.head.append(s); }
  const box = doc.createElement('section'); box.id = 'drive-hud'; box.hidden = true; box.setAttribute('aria-label', 'Drive readout');
  const cap = doc.createElement('div'); cap.id = 'drive-caption'; cap.hidden = true; cap.setAttribute('aria-live', 'polite');
  doc.body.append(box, cap);
  let last = '', lim = { ...limits };
  return {
    box, cap,
    get limits() { return { ...lim }; },
    setLimits(l) { lim = { ...lim, ...l }; last = ''; },
    show(on) { box.hidden = !on; if (!on) cap.hidden = true; },
    update(state) {
      const lines = hudLines(state, lim);
      const key = lines.map(l => (l.limit ? '!' : '') + l.text).join('\n');
      if (key === last) return false;
      last = key;
      box.replaceChildren(...lines.map(l => { const d = doc.createElement('div'); d.textContent = l.text; if (l.limit) d.className = 'lim'; return d; }));
      return true;
    },
    caption(text) { cap.textContent = text || ''; cap.hidden = !text; },
    remove() { box.remove(); cap.remove(); }
  };
}
