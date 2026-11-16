// sceneView.js — the 3D scene (the only other module besides map.js that creates an SDK view). Its SDK modules are
// loaded the first time the scene opens, so the 2D viewer never pays for them. Nothing comes over from the 2D map:
// each scene layer is a new FeatureLayer from the layer's REST URL, drawn with its height (scene.js) — polygons
// extruded, points as an upright cylinder or cone, lines as a wall, or flat on the ground when a layer has no height —
// on Esri's world elevation and a keyless basemap. At half width the scene and the 2D map move together (startSync).
// At full width, Sun and shadows (the SDK's Daylight widget, loaded when first used) moves the sun and casts shadows.
// Clicking features in the scene does nothing for now.
import * as map from './map.js';
import { heightExpression, sceneGeometry, hasHeight } from './scene.js';
import { hexToRgb } from './utils.js';

const MODULES = { SceneView: 'esri/views/SceneView', Map: 'esri/Map', FeatureLayer: 'esri/layers/FeatureLayer' };
const BASEMAP = 'topo-vector';      // one of the SDK's built-in basemaps from public ArcGIS Online items: no API key
const GROUND = 'world-elevation';
const OPEN_TILT = 55;               // degrees from straight down when the scene opens
const FLAT_ENOUGH = 80;             // above this tilt the scale at the centre means little, so 2D follows the centre only
const EDGES = [28, 43, 48, 0.35];   // thin dark outline on extruded polygons, so neighbours stay apart
const FLAT_FILL = 0.45;             // flat polygons are see-through, so the basemap and terrain show under them

let SDK = null;
let view = null;
let ready = null;
let built = { key: null, problems: [] };
let syncHandles = [];
let daylight = null;                // the Daylight widget while Sun and shadows is open
let sunSeq = 0;                     // a newer open or close of Sun and shadows makes an older, still-loading one give up
let startedSun = false;             // the first Sun and shadows of the session starts at today, now

const isWebGLError = e => /webgl|context|gpu/i.test(`${e?.name ?? ''} ${e?.message ?? ''}`);

/** Create the scene once, in the container the scene window gives it. */
function init(container) {
  ready ??= (async () => {
    const names = Object.keys(MODULES);
    const mods = await map.loadSdkModules(Object.values(MODULES));
    SDK = Object.fromEntries(names.map((n, i) => [n, mods[i]]));
    view = new SDK.SceneView({
      container,
      map: new SDK.Map({ basemap: BASEMAP, ground: GROUND }),
      qualityProfile: 'medium',
      popupEnabled: false                     // no feature clicks in 3D for now
    });
    await view.when();
    return view;
  })().catch(e => {
    view?.destroy();
    view = null;
    ready = null;
    throw new Error(isWebGLError(e)
      ? 'This browser can\'t show 3D here: it needs WebGL (a graphics card the browser is allowed to use).'
      : `The scene didn't start: ${e.message}`);
  });
  return ready;
}

/** A layer with no height: drawn on the ground, like a 2D map draped over the terrain. */
function flatRenderer(geometry, color) {
  const [r, g, b] = hexToRgb(color);
  const symbol = geometry === 'polygon'
    ? { type: 'polygon-3d', symbolLayers: [{ type: 'fill', material: { color: [r, g, b, FLAT_FILL] }, outline: { color: [r, g, b, 1], size: 1.5 } }] }
    : geometry === 'point'
      ? { type: 'point-3d', symbolLayers: [{ type: 'icon', resource: { primitive: 'circle' }, size: 9, material: { color }, outline: { color: [255, 255, 255, 1], size: 1 } }] }
      : { type: 'line-3d', symbolLayers: [{ type: 'line', size: 2, material: { color } }] };
  return { type: 'simple', symbol };
}

/** The symbol and height for one layer. Plain objects: the SDK turns them into renderers and 3D symbols. */
function rendererFor(geometry, l, objectIdField, color) {
  if (!hasHeight(l)) return flatRenderer(geometry, color);
  const height = { type: 'size', valueExpression: heightExpression(l, objectIdField), valueExpressionTitle: 'Height (m)', valueUnit: 'meters' };
  if (geometry === 'polygon') {
    return {
      type: 'simple',
      symbol: { type: 'polygon-3d', symbolLayers: [{ type: 'extrude', material: { color }, edges: { type: 'solid', color: EDGES, size: 0.5 } }] },
      visualVariables: [height]
    };
  }
  if (geometry === 'point') {
    return {
      type: 'simple',
      symbol: { type: 'point-3d', symbolLayers: [{ type: 'object', resource: { primitive: l.pointShape }, material: { color }, width: l.thickness, depth: l.thickness, height: 1, anchor: 'bottom' }] },
      visualVariables: [{ ...height, axis: 'height' }, { type: 'size', axis: 'width-and-depth', useSymbolValue: true }]
    };
  }
  return {
    type: 'simple',
    symbol: { type: 'line-3d', symbolLayers: [{ type: 'path', profile: 'quad', width: l.thickness, height: 1, anchor: 'bottom', cap: 'butt', join: 'miter', material: { color } }] },
    visualVariables: [{ ...height, axis: 'height' }, { type: 'size', axis: 'width', useSymbolValue: true }]
  };
}

/** One scene layer, loaded and styled; throws with a short reason people can act on. */
async function makeLayer(l, accent) {
  if (!l.url) throw new Error('it isn\'t in this map, or isn\'t a service layer');
  const fl = new SDK.FeatureLayer({ url: l.url, popupEnabled: false, minScale: l.minScale || 0, outFields: [] });
  try {
    await fl.load();
    if (l.title) fl.title = l.title;
    const geometry = sceneGeometry(fl.geometryType);
    if (!geometry) throw new Error('it has no points, lines or polygons');
    let heightField = '';
    if (l.heightMode === 'field') {
      heightField = fl.fields.find(f => f.name.toLowerCase() === l.heightField.toLowerCase())?.name ?? '';
      if (!heightField) throw new Error(`it has no field called ${l.heightField}`);
    }
    fl.outFields = [fl.objectIdField, heightField].filter(Boolean);     // only what the height needs
    fl.elevationInfo = { mode: geometry === 'polygon' || !hasHeight(l) ? 'on-the-ground' : 'relative-to-ground' };
    fl.renderer = rendererFor(geometry, { ...l, heightField }, fl.objectIdField, l.color || accent);
    return fl;
  } catch (e) {
    fl.destroy();
    throw map.isAuthError(e) ? new Error('it needs a sign-in') : e;
  }
}

/** Rebuild the scene's layers when their settings changed since the last time. */
async function applyLayers(layers, accent) {
  const key = JSON.stringify({ layers, accent });
  if (key === built.key) return built.problems;
  for (const l of view.map.layers.toArray()) l.destroy();
  view.map.layers.removeAll();
  const settled = await Promise.allSettled(layers.map(l => makeLayer(l, accent)));
  const problems = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') view.map.add(r.value);
    else problems.push(`${layers[i].title || layers[i].layerKey} (${r.reason?.message ?? 'it didn\'t load'})`);
  });
  built = { key, problems };
  return problems;
}

/**
 * Show the scene in a container, looking at what the 2D map shows, tilted.
 * @param layers  [{ ...manifest scene layer, url, title }]  (url from map.layerUrl, null when the layer isn't there;
 *                 title '' = the layer's own)
 * @param accent  colour for layers without their own
 * @param sync    true at half width: the scene and the 2D map move together (while the layers load, too)
 * @returns { problems: ["<title> (<reason>)"] }  layers that couldn't be drawn
 */
export async function show(container, layers, { accent, sync = false }) {
  await init(container);
  await new Promise(r => requestAnimationFrame(r));     // the 2D map's padding (half width) has taken effect
  const mv = map.getView();
  if (mv?.center) {
    const at = { center: mv.center, scale: mv.scale };
    await view.goTo({ ...at, tilt: OPEN_TILT, heading: 0 }, { animate: false }).catch(() => {});
    await view.goTo(at, { animate: false }).catch(() => {});     // once tilted, match the 2D scale at the centre
  }
  if (sync) startSync(); else stopSync();
  return { problems: await applyLayers(layers, accent) };
}

/** The 2D map moves to where the scene is looking (Back to 2D, and the 3D-led half of startSync). */
export function follow2D() {
  const mv = map.getView();
  if (!view?.center || !mv) return;
  const target = view.camera.tilt > FLAT_ENOUGH ? { center: view.center } : { center: view.center, scale: view.scale };
  mv.goTo(target, { animate: false }).catch(() => {});
}

/** The scene moves to where the 2D map is looking, keeping its own tilt and heading. */
function follow3D() {
  const mv = map.getView();
  if (!view || !mv?.center) return;
  view.goTo({ center: mv.center, scale: mv.scale }, { animate: false }).catch(() => {});
}

/**
 * Half width: panning or zooming either view moves the other. Whichever view people are moving leads (it is
 * interacting or animating); the other follows without animating, so it never becomes the leader itself and the two
 * can't chase each other. 2D stays north-up and flat; the scene keeps its own tilt and heading.
 */
export function startSync() {
  stopSync();
  const mv = map.getView();
  const { reactiveUtils } = map.getSDK();
  if (!view || !mv || !reactiveUtils) return;
  let leader = null;
  let frame = 0;
  const follow = () => { frame = 0; if (leader === mv) follow3D(); else if (leader === view) follow2D(); };
  for (const v of [mv, view]) {
    syncHandles.push(
      reactiveUtils.watch(() => v.interacting || Boolean(v.animation), busy => { if (busy) leader = v; }),
      reactiveUtils.watch(() => v.viewpoint, () => { if (leader === v && !frame) frame = requestAnimationFrame(follow); }));
  }
  syncHandles.push({ remove: () => { if (frame) cancelAnimationFrame(frame); } });
}

export function stopSync() {
  for (const h of syncHandles) h.remove();
  syncHandles = [];
}

/** Where the sun starts: now during the working day, otherwise today at 14:00, so the scene isn't opened in the dark. */
function sunStart() {
  const d = new Date();
  if (d.getHours() < 8 || d.getHours() >= 17) d.setHours(14, 0, 0, 0);
  return d;
}

/**
 * Sun and shadows: the sun's position follows a date and time (today, see sunStart) and shadows are cast.
 * The SDK's Daylight widget gives the date, time, play and shadow controls; it's loaded the first time it's opened.
 */
export async function startSun(container) {
  stopSun();
  const mine = ++sunSeq;
  await ready;                                          // the scene may still be starting
  const [Daylight] = await map.loadSdkModules(['esri/widgets/Daylight']);
  if (mine !== sunSeq || !view) return;                 // closed again while it loaded
  const lighting = view.environment.lighting;
  if (lighting?.type !== 'sun' || !startedSun) {
    // Times are shown in the viewer's own time zone (the SDK would guess one from the longitude: UTC+1 for this area).
    view.environment.lighting = { type: 'sun', date: sunStart(), displayUTCOffset: -new Date().getTimezoneOffset() / 60, directShadowsEnabled: true };
    startedSun = true;
  } else lighting.directShadowsEnabled = true;
  const node = document.createElement('div');           // the SDK empties its container on destroy
  container.replaceChildren(node);
  daylight = new Daylight({ view, container: node, dateOrSeason: 'date', visibleElements: { timezone: true, datePicker: true, playButtons: true, shadowsToggle: true, sunLightingToggle: false } });
}

/** Closing Sun and shadows keeps the sun where it is but stops casting shadows (they cost frame rate). */
export function stopSun() {
  sunSeq++;
  if (!daylight) return;
  try { daylight.destroy(); } catch { /* already gone */ }
  daylight = null;
  const lighting = view?.environment.lighting;
  if (lighting && 'directShadowsEnabled' in lighting) lighting.directShadowsEnabled = false;
}

/** A new manifest: build the layers again on the next show(). */
export function reset() { stopSync(); stopSun(); built = { key: null, problems: [] }; }
