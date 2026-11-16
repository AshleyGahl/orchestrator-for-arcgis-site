// labelTool.js — the Label orientation tool (Tools panel). People pick a street line and some house numbers on the
// map, choose how the numbers turn (parallel, perpendicular, reversed, custom) and see them turned at once. On a
// feature service layer with a number field for the angle, Save writes the angles back; the layer's own labelling
// then shows them. Any other layer gets the turned numbers drawn over the map for the session only.
// Saving is guarded: only signed-in members of the editors' group (saveGroupId) may save; with no group set, nobody may.
// The group is about people only (the layer needn't be shared with it); the service's own edit permissions still apply.
// The angle maths is in labelAngles.js; queries, hiding and saving go through map.js.
import * as map from './map.js';
import * as api from './api.js';
import * as auth from './auth.js';
import { signInForm } from './authUi.js';
import { el, fill } from './utils.js';
import { fieldType } from './editing.js';
import { LABEL_MODES, segmentAngles, nearestSegment, longestSegment, labelAngle, readsUpsideDown, isAngleField, angleForField, saveAccess } from './labelAngles.js';

const STREET_RGB = [245, 158, 11];      // amber: the chosen street
const RAY_RGB = [244, 63, 94];          // rose: its direction
const MAX_STREETS = 300;                // most streets listed from the current view
const MAX_POINTS = 500;                 // most house numbers one box may pick
const LABEL_TYPES = new Set(['string', 'integer', 'small-integer', 'big-integer', 'double', 'single']);

const deg = a => `${(Math.round(a * 10) / 10).toFixed(1)}°`;
const findField = (fields, name) => (name ? fields.find(f => f.name.toLowerCase() === name.toLowerCase()) ?? null : null);
const attr = (g, name) => {
  const a = g?.attributes ?? {};
  if (!name) return undefined;
  return name in a ? a[name] : a[Object.keys(a).find(k => k.toLowerCase() === name.toLowerCase())];
};
const guessField = (fields, pattern) => (fields.find(f => fieldType(f.type) === 'string' && pattern.test(f.name)) ?? fields.find(f => fieldType(f.type) === 'string'))?.name ?? '';
/** Angles are worked out on a plane; degrees of longitude shrink away from the equator. */
const planar = sr => (sr?.isGeographic ? ([x, y]) => [x * Math.cos(y * Math.PI / 180), y] : ([x, y]) => [x, y]);

/**
 * Mount the tool into a Tools panel slot.
 * @param cfg  widgets.toolConfig['label-orientation']: starting layers, fields, editors' group, mode and upright rule
 * @param ctx  { portalUrl }: the portal the editors' group belongs to (the web map's portal)
 * @returns { destroy() }
 */
export function createLabelTool(node, cfg = {}, ctx = {}) {
  const SDK = map.getSDK(), view = map.getView();
  const overlay = new SDK.GraphicsLayer({ listMode: 'hide', title: 'Label orientation' });
  view.map.add(overlay);

  const s = {
    streetKey: '', pointKey: '', streetInfo: null, pointInfo: null,
    streetLabelField: cfg.streetLabelField || '', labelField: cfg.labelField || '', angleField: cfg.angleField || '',
    streets: [], street: null, points: new Map(), results: [],
    mode: LABEL_MODES.some(([m]) => m === cfg.mode) ? cfg.mode : 'PARALLEL', custom: 0, autoFlip: cfg.autoFlip !== false,
    pick: 'street', drawing: false, busy: false, msg: '', msgKind: 'muted'
  };
  const refs = {};
  // Who may save: { status: 'checking' | 'member' | 'no-group' | 'signed-out' | 'not-member' | 'error', user, group, error }
  let access = { status: 'checking' };
  let accessRun = 0;
  const groupId = String(cfg.saveGroupId ?? '').trim();
  const radioName = `lo-mode-${Math.random().toString(36).slice(2, 8)}`;

  const say = (msg, kind = 'muted') => { s.msg = msg; s.msgKind = kind; if (refs.msg) { refs.msg.className = kind; refs.msg.textContent = msg; } };

  /* ---------------- Layers and fields ---------------- */
  async function setStreetLayer(key) {
    s.streetKey = key; s.streetInfo = null; s.street = null; s.streets = [];
    render();
    if (!key) return;
    try {
      const info = await map.labelLayerInfo(key);
      if (s.streetKey !== key) return;
      if (info.geometryType !== 'polyline') { s.streetKey = ''; say(`${info.title} has ${info.geometryType ?? 'unknown'} features. Choose a line layer for the streets.`, 'err'); render(); return; }
      s.streetInfo = info;
      if (!findField(info.fields, s.streetLabelField)) s.streetLabelField = guessField(info.fields, /name|street|road/i);
      render();
      listStreets();
    } catch (e) { if (s.streetKey === key) { s.streetKey = ''; say(`The street layer couldn't be read: ${e.message}`, 'err'); render(); } }
  }

  async function setPointLayer(key) {
    const old = s.pointKey;
    s.pointKey = key; s.pointInfo = null; s.points.clear();
    if (old) map.setHidden(old, []);
    update(); render();
    if (!key) return;
    try {
      const info = await map.labelLayerInfo(key);
      if (s.pointKey !== key) return;
      if (info.geometryType !== 'point') { s.pointKey = ''; say(`${info.title} has ${info.geometryType ?? 'unknown'} features. Choose a point layer for the house numbers.`, 'err'); render(); return; }
      s.pointInfo = info;
      if (!findField(info.fields, s.labelField)) s.labelField = guessField(info.fields, /house|number|num|addr|label|no$/i);
      const angle = findField(info.fields, s.angleField);
      if (!angle || !isAngleField(angle)) s.angleField = info.fields.find(f => isAngleField(f) && /angle|rot/i.test(f.name))?.name ?? (angle ? s.angleField : '');
      render();
    } catch (e) { if (s.pointKey === key) { s.pointKey = ''; say(`The house number layer couldn't be read: ${e.message}`, 'err'); render(); } }
  }

  /** The street list: streets in the part of the map people can see, by name. */
  async function listStreets() {
    if (!s.streetInfo) return;
    const key = s.streetKey;
    try {
      const feats = await map.queryLayerInView(key, { max: MAX_STREETS });
      if (s.streetKey !== key) return;
      const oid = s.streetInfo.objectIdField;
      const named = feats.filter(g => g.geometry?.paths?.length).map(g => ({ graphic: g, name: String(attr(g, s.streetLabelField) ?? '').trim() || `Street ${attr(g, oid)}` }));
      const counts = named.reduce((m, x) => m.set(x.name, (m.get(x.name) ?? 0) + 1), new Map());
      s.streets = named.map(x => ({ ...x, label: counts.get(x.name) > 1 ? `${x.name} (${attr(x.graphic, oid)})` : x.name }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
      if (feats.length >= MAX_STREETS) say(`Listing the first ${MAX_STREETS} streets in view. Zoom in to list the rest.`);
    } catch (e) { s.streets = []; say(`Streets couldn't be listed: ${e.message}`, 'err'); }
    render();
  }

  /* ---------------- Street and house numbers ---------------- */
  function setStreet(graphic, near = null) {
    const g = graphic.geometry;
    const P = planar(g.spatialReference);
    const paths = g.paths.map(path => path.map(v => P(v)));
    const ref = near ? nearestSegment(paths, P([near.x, near.y])) : longestSegment(paths);
    if (!ref) { say('That street has no length.', 'err'); return; }
    const ge = SDK.geometryEngine;
    const sr = g.spatialReference;
    let length = null;
    try { length = sr?.isWebMercator || sr?.isWGS84 ? ge.geodesicLength(g, 'meters') : ge.planarLength(g, 'meters'); } catch { /* unknown units */ }
    s.street = {
      graphic, paths, P, length,
      title: String(attr(graphic, s.streetLabelField) ?? '').trim() || `Street ${attr(graphic, s.streetInfo.objectIdField)}`,
      raw: [g.paths[ref.path][ref.index], g.paths[ref.path][ref.index + 1]],
      angles: segmentAngles(ref.p1, ref.p2)
    };
    s.pick = 'points';
    say(s.pointInfo ? 'Now click house numbers to add or remove them, or draw a box around several.' : 'Choose the house number layer next.');
    update(); render();
  }

  function togglePoints(features, { onlyAdd = false } = {}) {
    const oid = s.pointInfo.objectIdField;
    for (const g of features) {
      const id = attr(g, oid);
      if (id == null || g.geometry?.type !== 'point') continue;
      if (s.points.has(id) && !onlyAdd) s.points.delete(id);
      else s.points.set(id, g);
    }
    update(); render();
  }

  async function onClick(e) {
    if (s.drawing || s.busy) return;
    e.stopPropagation();
    const isStreet = s.pick === 'street';
    const key = isStreet ? s.streetKey : s.pointKey;
    if (!key || !(isStreet ? s.streetInfo : s.pointInfo)) { say(`Choose the ${isStreet ? 'street' : 'house number'} layer first.`, 'err'); return; }
    try {
      const feats = await map.queryLayerAt(key, e.mapPoint, { max: isStreet ? 10 : 5 });
      if (!feats.length) { say(isStreet ? 'No street there. Click on a street line.' : 'No house number there.'); return; }
      if (isStreet) {
        const P = planar(e.mapPoint.spatialReference);
        const dist = g => nearestSegment(g.geometry.paths.map(p => p.map(v => P(v))), P([e.mapPoint.x, e.mapPoint.y]))?.distance ?? Infinity;
        setStreet(feats.reduce((a, b) => (dist(b) < dist(a) ? b : a)), e.mapPoint);
      } else {
        togglePoints(feats.slice(0, 1));
        say('');
      }
    } catch (err) { say(`That didn't work: ${err.message}`, 'err'); }
  }

  async function drawBox() {
    if (!s.pointInfo) { say('Choose the house number layer first.', 'err'); return; }
    s.drawing = true;
    say('Drag a rectangle around the house numbers…');
    let shape = null;
    try { shape = await map.drawShape('rectangle'); }
    finally { map.cancelShape(); setTimeout(() => { s.drawing = false; }, 300); }   // the click that ends the box isn't a pick
    if (!shape) { say('Cancelled.'); return; }
    try {
      const feats = await map.queryLayerAt(s.pointKey, shape, { max: MAX_POINTS });
      togglePoints(feats, { onlyAdd: true });
      say(`${feats.length} house number${feats.length === 1 ? '' : 's'} in the box${feats.length >= MAX_POINTS ? ` (the first ${MAX_POINTS})` : ''}.`);
    } catch (e) { say(`The house numbers couldn't be read: ${e.message}`, 'err'); }
  }

  function clearPoints() {
    s.points.clear();
    update(); render();
  }

  /* ---------------- Angles and the map overlay ---------------- */
  const needsStreet = () => !['HORIZONTAL', 'CUSTOM'].includes(s.mode);

  function compute() {
    if (!s.pointInfo || (needsStreet() && !s.street)) return [];
    const oid = s.pointInfo.objectIdField;
    return [...s.points.values()].map(g => {
      let parallel = 0, side = 'left';
      if (s.street) {
        const seg = nearestSegment(s.street.paths, s.street.P([g.geometry.x, g.geometry.y]));
        if (seg) { parallel = segmentAngles(seg.p1, seg.p2).parallel; side = seg.side; }
      }
      const { angle, flipped } = labelAngle({ mode: s.mode, parallel, side, custom: s.custom, autoFlip: s.autoFlip });
      const text = attr(g, s.labelField);
      return { graphic: g, objectId: attr(g, oid), text: text == null || text === '' ? '?' : String(text), angle, flipped };
    });
  }

  function drawOverlay() {
    overlay.removeAll();
    const sr = view.spatialReference;
    if (s.street) {
      overlay.add(new SDK.Graphic({ geometry: s.street.graphic.geometry, symbol: { type: 'simple-line', color: [...STREET_RGB, 0.85], width: 6, cap: 'round', join: 'round' } }));
      const [a, b] = s.street.raw;
      overlay.add(new SDK.Graphic({
        geometry: { type: 'polyline', paths: [[[a[0], a[1]], [b[0], b[1]]]], spatialReference: sr },
        symbol: { type: 'simple-line', color: [...RAY_RGB, 1], width: 2.5, style: 'dash' }
      }));
      overlay.add(new SDK.Graphic({
        geometry: { type: 'point', x: b[0], y: b[1], spatialReference: sr },
        symbol: { type: 'simple-marker', style: 'triangle', size: 12, angle: s.street.angles.azimuth, color: [...RAY_RGB, 1], outline: { color: [255, 255, 255, 1], width: 1 } }
      }));
    }
    const drawn = new Set(s.results.map(r => r.objectId));
    for (const g of s.points.values()) {
      if (drawn.has(attr(g, s.pointInfo?.objectIdField))) continue;
      overlay.add(new SDK.Graphic({ geometry: g.geometry, symbol: { type: 'simple-marker', size: 14, color: [...RAY_RGB, 0.12], outline: { color: [...RAY_RGB, 0.9], width: 1.25 } } }));
    }
    for (const r of s.results) {
      overlay.add(new SDK.Graphic({
        geometry: r.graphic.geometry,
        symbol: { type: 'text', text: r.text, angle: r.angle, color: [28, 43, 48, 1], haloColor: [255, 255, 255, 1], haloSize: 1.5, font: { size: 11, weight: 'bold' } }
      }));
    }
  }

  /** Recompute after any change, redraw the map, and refresh the live parts of the panel. */
  function update() {
    s.results = compute();
    drawOverlay();
    if (s.pointKey) map.setHidden(s.pointKey, s.results.map(r => r.objectId));
    if (refs.metrics) fill(refs.metrics, metrics());
    if (refs.save) fill(refs.save, saveSection());
    if (refs.flipNote) refs.flipNote.hidden = !(s.autoFlip && s.mode.startsWith('PERP_'));
    setDial();
  }

  /* ---------------- Panel ---------------- */
  const select = (label, value, options, onPick, extra = {}) => el('label', { class: 'field' }, label,
    el('select', { onchange: e => onPick(e.target.value), ...extra },
      options.map(([v, l]) => el('option', { value: v, selected: v === value }, l))));

  function metrics() {
    if (!s.street) return el('p', { class: 'muted' }, 'Pick a street to see its angles.');
    const { azimuth, cartesian, parallel } = s.street.angles;
    const flips = s.results.filter(r => r.flipped).length;
    const upright = !s.autoFlip ? 'Off'
      : s.results.length ? `${flips} of ${s.results.length} turned to read upright`
      : readsUpsideDown(parallel) ? 'Parallel text would be turned' : 'Not needed along this segment';
    const length = s.street.length == null ? '–' : s.street.length >= 1000 ? `${(s.street.length / 1000).toFixed(2)} km` : `${Math.round(s.street.length)} m`;
    return el('dl', { class: 'lo-metrics' },
      el('dt', {}, 'Street'), el('dd', {}, s.street.title),
      el('dt', {}, 'Bearing (azimuth)'), el('dd', {}, deg(azimuth)),
      el('dt', {}, 'Cartesian angle'), el('dd', {}, deg(cartesian)),
      el('dt', {}, 'Street length'), el('dd', {}, length),
      el('dt', {}, 'Upright'), el('dd', {}, upright));
  }

  function saveSection() {
    if (!s.pointInfo) return null;
    const n = s.results.length;
    const clear = el('button', { type: 'button', class: 'btn', disabled: !s.points.size, onclick: clearPoints }, 'Clear');
    if (!s.pointInfo.editable) {
      return [el('p', { class: 'tool-note' }, `Turned numbers are drawn on the map for this session only: ${s.pointInfo.why}.`), el('div', { class: 'lo-actions' }, clear)];
    }
    if (access.status !== 'member') return [accessNote(), el('div', { class: 'lo-actions' }, clear)];
    const f = findField(s.pointInfo.fields, s.angleField);
    const angleFields = s.pointInfo.fields.filter(isAngleField);
    const note = !angleFields.length
      ? el('p', { class: 'err' }, 'This layer has no number field that can hold an angle (Double, Single, Integer or Small integer). Add one to the layer to save angles; until then the turned numbers are only drawn on the map.')
      : !f ? el('p', { class: 'muted' }, 'Choose the field that holds the angle.') : null;
    return [
      angleFields.length ? select('Angle field (degrees clockwise, 0 = horizontal)', s.angleField, [['', 'Choose a field…'], ...angleFields.map(x => [x.name, `${x.alias || x.name} (${fieldType(x.type)})`])], v => { s.angleField = v; update(); }) : null,
      note,
      el('div', { class: 'lo-actions' },
        el('button', {
          type: 'button', class: 'btn primary', disabled: !f || !n || s.busy, onclick: save
        }, s.busy ? 'Saving…' : n ? `Save ${n} angle${n === 1 ? '' : 's'}` : 'Save angles'),
        clear),
      el('p', { class: 'tool-note' }, 'Saving changes the layer\'s data for everyone. After saving, the numbers show with the layer\'s own labelling, which must use this field to turn them.')
    ];
  }

  /** Why this person can't save (yet), with a sign-in form when signing in would help. */
  function accessNote() {
    const group = access.group ? `"${access.group}"` : "the editors' group";
    const session = ' The turned numbers are drawn on the map for this session only.';
    switch (access.status) {
      case 'checking': return el('p', { class: 'muted' }, 'Checking whether you may save angles…');
      case 'no-group': return el('p', { class: 'tool-note' }, "Saving angles is switched off for this viewer: no editors' group is set up. The turned numbers are drawn on the map for this session only.");
      case 'signed-out':
        refs.signIn ??= signInForm({ target: auth.portalTarget(ctx.portalUrl), message: `Only members of ${group} may save angles. Sign in to check.`, onSignedIn: () => checkAccess() });
        return [el('p', { class: 'tool-note' }, `Saving angles is for members of ${group}; sign in if you are one.${session}`), refs.signIn];
      case 'not-member': return el('p', { class: 'tool-note' }, `You're signed in as ${access.user}, who isn't a member of ${group}, so you can't save angles.${session}`);
      default: return el('p', { class: 'err' }, `Couldn't check whether you may save angles: ${access.error}.${session}`);
    }
  }

  /** Ask the portal who is signed in and whether they're in the editors' group. Returns the answer. */
  async function checkAccess() {
    const run = ++accessRun;
    let next;
    if (!groupId || !ctx.portalUrl) next = { status: 'no-group' };
    else {
      try {
        // Signed out, the portal answers "400: Not logged in." (COM_0019) rather than an empty user.
        const self = await api.getSelf(ctx.portalUrl).catch(e => { if (e instanceof auth.AuthRequiredError || /COM_0019|not logged in/i.test(e.message)) return null; throw e; });
        const { reason } = saveAccess(self, groupId);
        const title = (self?.groups ?? []).find(g => String(g.id).toLowerCase() === groupId.toLowerCase())?.title
          ?? await api.getGroup(ctx.portalUrl, groupId).then(g => g.title).catch(() => null);
        next = { status: reason, user: self?.username ?? null, group: title };
      } catch (e) { next = { status: 'error', error: e.message }; }
    }
    if (run !== accessRun) return access;           // a newer check started meanwhile
    if (next.status !== 'signed-out') refs.signIn = null;
    access = next;
    update();
    return access;
  }

  async function save() {
    const f = findField(s.pointInfo.fields, s.angleField);
    if (!f || !s.results.length) return;
    s.busy = true; update();
    // Check membership again at the moment of saving: a sign-out or a removal from the group counts at once.
    if ((await checkAccess()).status !== 'member') { s.busy = false; say('Nothing was saved: you may not save angles.', 'err'); update(); return; }
    s.busy = true; update();
    try {
      const values = s.results.map(r => ({ objectId: r.objectId, value: angleForField(r.angle, f.type) }));
      const { saved, failed } = await map.saveFieldValues(s.pointKey, f.name, values);
      const stillFailing = new Set(failed.map(x => x.objectId));
      for (const id of [...s.points.keys()]) if (!stillFailing.has(id)) s.points.delete(id);
      if (failed.length) say(`Saved ${saved}; ${failed.length} refused: ${failed[0].message}. Those stay selected.`, 'err');
      else say(`Saved ${saved} angle${saved === 1 ? '' : 's'} to ${f.alias || f.name}.`);
    } catch (e) { say(`Nothing was saved: ${e.message}`, 'err'); }
    s.busy = false;
    update(); render();
  }

  /** The compass dial: shows the text direction; click or drag on it to set a custom angle. */
  function dial() {
    const wrap = el('span', { class: 'lo-dial', role: 'img', 'aria-label': 'Text direction' });
    wrap.innerHTML = '<svg viewBox="0 0 80 80" width="80" height="80" aria-hidden="true">'
      + '<circle cx="40" cy="40" r="36" fill="none" stroke="currentColor" stroke-opacity=".35"/>'
      + '<text x="40" y="12" text-anchor="middle" font-size="8" fill="currentColor">N</text>'
      + '<g class="lo-needle"><line x1="14" y1="40" x2="64" y2="40" stroke="var(--accent)" stroke-width="2.5"/>'
      + '<path d="M66 40 58 35 58 45Z" fill="var(--accent)"/>'
      + '<text x="38" y="35" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">123</text></g></svg>';
    const svg = wrap.firstElementChild;
    const setFrom = e => {
      const r = svg.getBoundingClientRect();
      const a = Math.atan2(e.clientY - r.top - r.height / 2, e.clientX - r.left - r.width / 2) * 180 / Math.PI;
      s.custom = Math.round(((a % 360) + 360) % 360);
      s.mode = 'CUSTOM';
      if (refs.slider) refs.slider.value = s.custom;
      refs.radios?.forEach(x => { x.checked = x.value === 'CUSTOM'; });
      update();
    };
    svg.addEventListener('pointerdown', e => { svg.setPointerCapture(e.pointerId); setFrom(e); });
    svg.addEventListener('pointermove', e => { if (svg.hasPointerCapture(e.pointerId)) setFrom(e); });
    refs.needle = svg.querySelector('.lo-needle');
    return wrap;
  }

  function setDial() {
    const a = s.mode === 'CUSTOM' ? s.custom
      : s.results[0]?.angle ?? (s.street ? labelAngle({ mode: s.mode, parallel: s.street.angles.parallel, autoFlip: s.autoFlip }).angle : 0);
    refs.needle?.setAttribute('transform', `rotate(${a} 40 40)`);
    if (refs.angleOut) refs.angleOut.textContent = deg(a);
  }

  function render() {
    const layers = map.labelLayers();
    const lines = layers.filter(l => !l.geometryType || l.geometryType === 'polyline');
    const points = layers.filter(l => !l.geometryType || l.geometryType === 'point');
    const opts = list => [['', 'Choose a layer…'], ...list.map(l => [l.key, l.title])];
    const sFields = (s.streetInfo?.fields ?? []).filter(f => LABEL_TYPES.has(fieldType(f.type)));
    const pFields = (s.pointInfo?.fields ?? []).filter(f => LABEL_TYPES.has(fieldType(f.type)));
    const fieldOpts = list => [['', '(none)'], ...list.map(f => [f.name, f.alias || f.name])];

    refs.radios = LABEL_MODES.map(([id]) => el('input', {
      type: 'radio', name: radioName, value: id, checked: s.mode === id,
      onchange: () => { s.mode = id; update(); }
    }));
    refs.slider = el('input', {
      type: 'range', min: 0, max: 359, step: 1, value: s.custom, 'aria-label': 'Custom angle',
      oninput: e => { s.custom = Number(e.target.value); if (s.mode !== 'CUSTOM') { s.mode = 'CUSTOM'; refs.radios.forEach(x => { x.checked = x.value === 'CUSTOM'; }); } update(); }
    });
    refs.angleOut = el('output', { class: 'lo-angle' });
    refs.metrics = el('div', {}, metrics());
    refs.save = el('div', { class: 'lo-save' }, saveSection());
    refs.msg = el('p', { class: s.msgKind, 'aria-live': 'polite' }, s.msg);

    fill(node,
      el('p', { class: 'tool-help' }, 'Pick a street, then the house numbers along it, and choose how the numbers turn.'),
      el('div', { class: 'lo-section' },
        select('Street layer (lines)', s.streetKey, opts(lines), setStreetLayer),
        s.streetInfo ? select('Street name field', s.streetLabelField, fieldOpts(sFields), v => { s.streetLabelField = v; listStreets(); }) : null,
        select('House number layer (points)', s.pointKey, opts(points), setPointLayer),
        s.pointInfo ? select('House number field', s.labelField, fieldOpts(pFields), v => { s.labelField = v; update(); }) : null),
      el('div', { class: 'lo-section' },
        s.streetInfo ? el('div', { class: 'add-row' },
          select('Street', s.street ? String(s.streets.findIndex(x => x.graphic === s.street.graphic)) : '',
            [['', s.streets.length ? 'Choose a street in view…' : 'No streets in view'], ...s.streets.map((x, i) => [String(i), x.label])],
            v => { if (v !== '') setStreet(s.streets[Number(v)].graphic); }),
          el('button', { type: 'button', class: 'btn', title: 'List the streets in the part of the map you can see', onclick: listStreets }, 'Refresh')) : null,
        el('div', { class: 'seg', role: 'group', 'aria-label': 'What a map click picks' },
          el('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(s.pick === 'street'), onclick: () => { s.pick = 'street'; say('Click a street line on the map.'); render(); } }, 'Pick a street'),
          el('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(s.pick === 'points'), onclick: () => { s.pick = 'points'; say('Click house numbers to add or remove them.'); render(); } }, 'Pick numbers'),
          el('button', { type: 'button', class: 'seg-btn', onclick: drawBox }, 'Box')),
        el('p', { class: 'muted' }, `${s.points.size} house number${s.points.size === 1 ? '' : 's'} selected.`),
        refs.metrics),
      el('fieldset', { class: 'lo-section lo-modes' },
        el('legend', {}, 'Orientation'),
        LABEL_MODES.map(([id, label], i) => el('label', { class: 'check-row' }, refs.radios[i], label)),
        el('div', { class: 'lo-custom' }, dial(), el('div', { class: 'lo-slider' }, refs.slider, refs.angleOut)),
        el('label', { class: 'check-row' },
          el('input', { type: 'checkbox', checked: s.autoFlip, onchange: e => { s.autoFlip = e.target.checked; update(); } }),
          'Keep numbers upright (turn any that would read upside down)'),
        refs.flipNote = el('p', { class: 'tool-note', hidden: !(s.autoFlip && s.mode.startsWith('PERP_')) },
          'Upright perpendicular numbers can only read one way, so "away" and "toward" look the same. Switch "Keep numbers upright" off to make each side read away from (or toward) the street.')),
      refs.save,
      refs.msg);
    setDial();
  }

  const clickHandle = view.on('click', onClick);
  const stopWatchingAuth = auth.onChange(() => checkAccess());
  render();
  const keys = new Set(map.labelLayers().map(l => l.key));
  if (cfg.streetLayer && keys.has(cfg.streetLayer)) setStreetLayer(cfg.streetLayer);
  if (cfg.pointLayer && keys.has(cfg.pointLayer)) setPointLayer(cfg.pointLayer);
  if (!s.msg) say('Choose the layers, then click a street on the map.');
  checkAccess();

  return {
    destroy() {
      clickHandle.remove();
      stopWatchingAuth();
      accessRun++;
      if (s.drawing) map.cancelShape();
      if (s.pointKey) map.setHidden(s.pointKey, []);
      overlay.removeAll();
      view.map?.remove(overlay);
      overlay.destroy();
    }
  };
}
