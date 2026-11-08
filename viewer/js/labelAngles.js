// labelAngles.js — the Label orientation tool's geometry: street segment angles, label angle modes, the
// upright (auto-flip) rule, which side of a street a point is on, and which fields can hold an angle.
// Pure: no DOM, no SDK. Coordinates are map units with y pointing up (any projected or Web Mercator system).
// Angles given to labels are clockwise degrees from normal horizontal text, the way TextSymbol.angle and a
// renderer's rotation (geographic) read them.
import { fieldType } from './editing.js';

export const LABEL_MODES = [
  ['HORIZONTAL', 'Horizontal'],
  ['PARALLEL', 'Parallel to the street'],
  ['PERP_AWAY', 'Perpendicular, reading away from the street'],
  ['PERP_TOWARD', 'Perpendicular, reading toward the street'],
  ['REVERSED', 'Reversed parallel'],
  ['CUSTOM', 'Custom angle']
];
export const isLabelMode = id => LABEL_MODES.some(([m]) => m === id);

/** Field types that can hold an angle (SDK or REST spelling). */
export const ANGLE_FIELD_TYPES = ['double', 'single', 'integer', 'small-integer'];
export const isAngleField = f => ANGLE_FIELD_TYPES.includes(fieldType(f?.type)) && f?.editable !== false;
const INTEGER_TYPES = new Set(['integer', 'small-integer']);

export const norm360 = a => ((a % 360) + 360) % 360;
const round = (n, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * Angles of the segment p1 → p2.
 *   cartesian  counter-clockwise from the x axis (east)
 *   azimuth    compass bearing, clockwise from north
 *   parallel   clockwise screen angle that makes text run along the segment
 */
export function segmentAngles(p1, p2) {
  const cartesian = norm360(Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) * 180 / Math.PI);
  return { cartesian, azimuth: norm360(90 - cartesian), parallel: norm360(360 - cartesian) };
}

/** Which side of the segment p1 → p2 a point is on, looking along the segment. A point on the line counts as left. */
export function sideOf(p1, p2, pt) {
  const cross = (p2[0] - p1[0]) * (pt[1] - p1[1]) - (p2[1] - p1[1]) * (pt[0] - p1[0]);
  return cross < 0 ? 'right' : 'left';
}

/**
 * The segment of a polyline nearest to a point (each house number follows the part of the street it faces).
 * @param paths [[[x, y], ...], ...] as in a polyline's paths
 * @returns { p1, p2, path, index, distance, side } or null when the line has no segment
 */
export function nearestSegment(paths, pt) {
  let best = null;
  (paths ?? []).forEach((path, pi) => {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      if (!len2) continue;                                      // repeated vertex
      const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / len2));
      const d = Math.hypot(pt[0] - (a[0] + t * dx), pt[1] - (a[1] + t * dy));
      if (!best || d < best.distance) best = { p1: a, p2: b, path: pi, index: i, distance: d };
    }
  });
  if (best) best.side = sideOf(best.p1, best.p2, pt);
  return best;
}

/** The longest segment of a polyline: the street's reference direction when it's chosen from the list. */
export function longestSegment(paths) {
  let best = null;
  (paths ?? []).forEach((path, pi) => {
    for (let i = 0; i < path.length - 1; i++) {
      const len = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
      if (len && (!best || len > best.length)) best = { p1: path[i], p2: path[i + 1], path: pi, index: i, length: len };
    }
  });
  return best;
}

/** Would text at this angle read upside down? (The upright rule turns it half a circle.) */
export const readsUpsideDown = a => a > 90 && a < 270;

/**
 * The angle for one label.
 * @param mode       one of LABEL_MODES
 * @param parallel   the street segment's parallel angle (segmentAngles().parallel)
 * @param side       'left' | 'right': which side of the segment the label sits on
 * @param custom     the angle for CUSTOM
 * @param autoFlip   keep text upright (not applied to CUSTOM, which is exactly what was asked for)
 * @returns { angle, flipped }
 */
export function labelAngle({ mode, parallel = 0, side = 'left', custom = 0, autoFlip = true }) {
  let a;
  switch (mode) {
    case 'HORIZONTAL': a = 0; break;
    case 'PARALLEL': a = parallel; break;
    case 'REVERSED': a = parallel + 180; break;
    case 'PERP_AWAY': a = side === 'right' ? parallel + 90 : parallel - 90; break;
    case 'PERP_TOWARD': a = side === 'right' ? parallel - 90 : parallel + 90; break;
    case 'CUSTOM': return { angle: round(norm360(Number(custom) || 0)), flipped: false };
    default: throw new Error(`Unknown label mode: ${mode}`);
  }
  a = norm360(a);
  const flipped = autoFlip && readsUpsideDown(a);
  return { angle: round(norm360(flipped ? a + 180 : a)), flipped };
}

/**
 * May this person save angles? Only members of the editors' group may; no group set means nobody may.
 * @param self     the portal's community/self answer (username and groups when signed in), or null
 * @param groupId  widgets.toolConfig['label-orientation'].saveGroupId
 * @returns { allowed, reason: 'member' | 'no-group' | 'signed-out' | 'not-member' }
 */
export function saveAccess(self, groupId) {
  const id = String(groupId ?? '').trim().toLowerCase();
  if (!id) return { allowed: false, reason: 'no-group' };
  if (!self?.username) return { allowed: false, reason: 'signed-out' };
  const member = (self.groups ?? []).some(g => String(g?.id ?? '').toLowerCase() === id);
  return { allowed: member, reason: member ? 'member' : 'not-member' };
}

/** The value to store in an angle field: whole degrees for integer fields, two decimals otherwise, never 360. */
export function angleForField(angle, type) {
  const v = INTEGER_TYPES.has(fieldType(type)) ? Math.round(angle) : round(angle);
  return v >= 360 ? v - 360 : v;
}
