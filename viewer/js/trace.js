// trace.js — Attribute Trace: follow a chain of field relationships from a starting feature through other layers
// (reservoir -> zone -> pipes -> connections -> properties; road -> addresses -> properties) to find the features a
// planned job may affect. Pure: no DOM, no SDK, no config, so it runs in Node tests. The engine asks an injected
// adapter for layer fields and attribute queries; map.js supplies the real one, traceWindow.js shows the results.
//
// A trace: { id, title, description, startLayer, resultLabel, confirmsImpact, steps, finalFields }
// A step:  { id, from, sourceField, targetLayer, targetField, filters, optional, caseInsensitive }
//   from        'start' or earlier step ids (one or several: their features are combined). sourceField is read
//               from those features; targetField is matched on targetLayer with IN (...) queries.
//   filters     [{ field, op, value, value2 }] on targetLayer, the attribute search's operators (query.js).
//   optional    no matches here doesn't end the trace (e.g. secondary addresses a road may not have).
// The last step's layer holds the results. Matching attributes shows features are linked by the configured keys;
// it isn't proof of a physical connection or an outage unless the author says so (confirmsImpact).
import { fieldKind, buildCondition, OPERATORS } from './query.js';

export const TRACE_MAX_STEPS = 20;          // hard cap, whatever the manifest says
export const TRACES_MAX = 20;
export const START = 'start';

/** How wide the Attribute trace window opens: half beside the map (on the author's side), or over map and panel. */
export const TRACE_WIDTHS = [['half', 'Half: beside the map'], ['full', 'Full: over the map and the panel'], ['bottom', 'Bottom: docked along the bottom of the map']];
export const isTraceWidth = id => TRACE_WIDTHS.some(([w]) => w === id);

/** [key, label, min, max, default]. The author sets them per project; the engine clamps to min..max. */
export const TRACE_LIMITS = [
  ['maxSteps', 'Most steps in one trace', 1, TRACE_MAX_STEPS, 5],
  ['maxIdsPerStep', 'Most features one step may find', 1, 10000, 5000],
  ['maxFinal', 'Most results', 1, 5000, 2000],
  ['batchSize', 'Values per query', 1, 300, 200],
  ['concurrency', 'Queries at once', 1, 6, 3],
  ['timeoutSeconds', 'Longest a trace may run (seconds)', 5, 300, 60]
];
export const defaultTraceLimits = () => Object.fromEntries(TRACE_LIMITS.map(([k, , , , d]) => [k, d]));

/** Limits clamped to their ranges; missing or bad values take the default. */
export function traceLimits(limits = {}) {
  return Object.fromEntries(TRACE_LIMITS.map(([k, , min, max, d]) => {
    const n = Math.round(Number(limits?.[k]));
    return [k, Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d];
  }));
}

/** Problems with limits as written (for manifest validation; the engine clamps instead). */
export function limitProblems(limits = {}) {
  const errors = [];
  for (const [k, label, min, max] of TRACE_LIMITS) {
    if (limits?.[k] == null) continue;
    const n = Number(limits[k]);
    if (!Number.isInteger(n) || n < min || n > max) errors.push(`${label}: use a whole number from ${min} to ${max}.`);
  }
  return errors;
}

const FIELD_NAME = /^[A-Za-z_][\w.]*$/;
export const sourcesOf = step => [].concat(step?.from ?? START);
const lower = s => String(s ?? '').toLowerCase();
const findField = (fields, name) => fields?.find(f => lower(f.name) === lower(name)) ?? null;
const oidOf = fields => fields?.find(f => /oid/i.test(f.type))?.name ?? null;
const stepName = (step, i) => `Step ${i + 1}`;

/** The layer each step's features come from: { start: startLayer, <stepId>: targetLayer }. */
const layerOfSource = def => new Map([[START, def.startLayer], ...(def.steps ?? []).map(s => [s.id, s.targetLayer])]);

/**
 * Checks a trace before it runs. Without fieldsOf only its shape is checked (manifest validation); with it, that
 * every layer is there and every field exists with a type that can be matched.
 * @param def      a trace
 * @param opts     { limits, fieldsOf?: Map<layerKey, fields[]> }
 * @returns { errors: string[], warnings: string[] }
 */
export function checkTrace(def, { limits, fieldsOf = null } = {}) {
  const errors = [], warnings = [];
  const lim = traceLimits(limits);
  if (!def || typeof def !== 'object') return { errors: ['The trace is empty.'], warnings };
  if (!String(def.title ?? '').trim()) errors.push('Give the trace a title.');
  if (!def.startLayer) errors.push('Choose the layer the trace starts from.');
  const steps = Array.isArray(def.steps) ? def.steps : [];
  if (!steps.length) errors.push('Add at least one step.');
  if (steps.length > lim.maxSteps) errors.push(`The trace has ${steps.length} steps; this project allows at most ${lim.maxSteps}.`);

  const layerOf = layerOfSource(def);
  const fieldsFor = key => fieldsOf?.get(key);
  const seen = new Set([START]);
  if (fieldsOf) for (const key of new Set([def.startLayer, ...steps.map(s => s.targetLayer)].filter(Boolean))) {
    if (!fieldsFor(key)?.length) errors.push(`The layer "${key}" isn't in the map or its fields can't be read.`);
  }

  steps.forEach((step, i) => {
    const name = stepName(step, i);
    if (!step?.id || step.id === START) errors.push(`${name}: it has no id.`);
    else if (seen.has(step.id)) errors.push(`${name}: its id "${step.id}" is used twice.`);
    const from = sourcesOf(step);
    if (!from.length) errors.push(`${name}: choose where its values come from.`);
    if (new Set(from).size !== from.length) errors.push(`${name}: the same source is listed twice.`);
    for (const f of from) if (!seen.has(f)) errors.push(`${name}: it can only take values from the start or an earlier step.`);
    if (step?.id) seen.add(step.id);
    if (!step?.targetLayer) errors.push(`${name}: choose the layer it finds features in.`);
    for (const [k, label] of [['sourceField', 'the field to read'], ['targetField', 'the field to match']]) {
      if (!step?.[k]) errors.push(`${name}: choose ${label}.`);
      else if (!FIELD_NAME.test(step[k])) errors.push(`${name}: "${step[k]}" isn't a valid field name.`);
    }
    for (const c of step?.filters ?? []) {
      if (!FIELD_NAME.test(c?.field ?? '')) errors.push(`${name}: a filter has no valid field.`);
      if (!OPERATORS[c?.op]) errors.push(`${name}: a filter has an unknown operator "${c?.op}".`);
    }
    if (!fieldsOf || !step?.targetLayer || !step.targetField) return;

    // Field checks: the target key, the source key on every layer it's read from, and the filters.
    const targetFields = fieldsFor(step.targetLayer);
    if (!targetFields?.length) return;
    const target = findField(targetFields, step.targetField);
    const targetKind = target && fieldKind(target.type);
    if (!target) errors.push(`${name}: "${step.targetField}" isn't a field of ${step.targetLayer}.`);
    else if (targetKind !== 'text' && targetKind !== 'number') errors.push(`${name}: "${step.targetField}" is a ${target.type} field; keys must be text or numbers.`);
    for (const f of from) {
      const srcLayer = layerOf.get(f);
      const src = findField(fieldsFor(srcLayer), step.sourceField);
      if (!fieldsFor(srcLayer)?.length) continue;
      if (!src) { errors.push(`${name}: "${step.sourceField}" isn't a field of ${srcLayer}.`); continue; }
      const kind = fieldKind(src.type);
      if (kind !== 'text' && kind !== 'number') errors.push(`${name}: "${step.sourceField}" is a ${src.type} field; keys must be text or numbers.`);
      else if (targetKind && kind !== targetKind && (targetKind === 'text' || targetKind === 'number')) {
        warnings.push(`${name}: ${step.sourceField} (${kind}) is matched to ${step.targetField} (${targetKind}); values are converted, and ones that aren't numbers are skipped.`);
      }
    }
    for (const c of step.filters ?? []) {
      const f = findField(targetFields, c.field);
      if (!f) { errors.push(`${name}: the filter field "${c.field}" isn't a field of ${step.targetLayer}.`); continue; }
      try { buildCondition({ field: f.name, kind: fieldKind(f.type), op: c.op, value: c.value, value2: c.value2 }); }
      catch (e) { errors.push(`${name}: filter on ${c.field}: ${e.message}`); }
    }
  });

  if (fieldsOf) for (const f of def.finalFields ?? []) {
    const last = steps.at(-1);
    if (last?.targetLayer && fieldsFor(last.targetLayer)?.length && !findField(fieldsFor(last.targetLayer), f.name)) {
      errors.push(`Results: "${f.name}" isn't a field of ${last.targetLayer}.`);
    }
  }
  return { errors, warnings };
}

/* ---------------- Values and where clauses ---------------- */
const attr = (a, name) => a?.[name] ?? a?.[Object.keys(a ?? {}).find(k => lower(k) === lower(name))];

/**
 * A key value made ready to match a field of the given kind, or null when it can't match anything
 * (empty, blank like the municipality's ' ', or text that isn't a number for a number field).
 */
export function normalizeKey(v, kind, caseInsensitive = false) {
  if (v == null) return null;
  if (kind === 'number') {
    const s = String(v).trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const s = String(v).trim();
  if (s === '') return null;
  return caseInsensitive ? s.toUpperCase() : s;
}

/** A Map key for a normalized value, so 5 and '5' stay apart. */
const valueKey = v => `${typeof v}:${v}`;

const quote = s => `'${String(s).replace(/'/g, "''")}'`;

/** field IN (...) for one batch of normalized values. Text compares upper-cased when caseInsensitive. */
export function keyClause(field, kind, values, caseInsensitive = false) {
  if (!FIELD_NAME.test(field)) throw new Error(`"${field}" isn't a valid field name.`);
  if (!values.length) throw new Error('No values to match.');
  if (kind === 'number') return `${field} IN (${values.map(n => String(Number(n))).join(', ')})`;
  return `${caseInsensitive ? `UPPER(${field})` : field} IN (${values.map(quote).join(', ')})`;
}

/** The step's filters as one clause ('' when it has none), typed by the target layer's fields. */
export function filterClause(filters = [], fields = []) {
  return filters.map(c => {
    const f = findField(fields, c.field);
    if (!f) throw new Error(`"${c.field}" isn't a field of this layer.`);
    return `(${buildCondition({ field: f.name, kind: fieldKind(f.type), op: c.op, value: c.value, value2: c.value2 })})`;
  }).join(' AND ');
}

/** Values split into batches of at most size. */
export const batches = (values, size) => Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, (i + 1) * size));

/* ---------------- The engine ---------------- */
class Stop extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Runs fn over items, at most n at a time; stops starting new ones once signal is aborted. */
async function pool(items, n, fn, signal) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (signal.aborted) return;
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/**
 * Runs a trace one step at a time. Each step reads its source values from the features of the steps it takes
 * from, drops blanks and duplicates, and asks targetLayer for matches in batches (at most limits.concurrency at
 * once, paged while the service says there are more). Values already asked for the same layer, field and filters
 * in this run come from a cache. Only the fields later steps need (and the results' fields) are read; no geometry.
 *
 * @param def      a trace
 * @param start    the starting features' attributes [{ ... }] (read with at least the fields steps take from 'start')
 * @param adapter  { fields(layerKey) -> Promise<[{ name, type, alias? }]>,
 *                   query(layerKey, { where, outFields, offset, num, signal }) -> Promise<{ records: [attributes], more }> }
 * @param opts     { limits, signal, onProgress({ step, index, batchesDone, batches, count }), now }
 * @returns { status, message, steps: [{ id, index, layerKey, status, count, values, skippedValues, cachedValues,
 *            queries, ms, records }], final: { layerKey, oidField, records } | null, warnings, ms }
 *          status: 'done' | 'empty' (a valid trace that found nothing) | 'limit' | 'cancelled' | 'timeout' |
 *                  'invalid' | 'error'
 */
export async function runTrace(def, start, adapter, { limits, signal, onProgress, now = () => Date.now() } = {}) {
  const lim = traceLimits(limits);
  const began = now();
  const steps = def?.steps ?? [];
  const report = { status: 'done', message: '', steps: [], final: null, warnings: [], ms: 0 };
  const finish = (status, message) => Object.assign(report, { status, message, ms: now() - began });

  // Our own controller: the person's Cancel, the time limit and step limits all stop the queries in flight.
  const ac = new AbortController();
  let stopped = null;
  const stop = (status, message) => { if (!stopped) { stopped = new Stop(status, message); ac.abort(stopped); } };
  const onCancel = () => stop('cancelled', 'The trace was cancelled.');
  if (signal?.aborted) return finish('cancelled', 'The trace was cancelled.');
  signal?.addEventListener('abort', onCancel);
  const timer = setTimeout(() => stop('timeout', `The trace took longer than ${lim.timeoutSeconds} seconds and was stopped.`), lim.timeoutSeconds * 1000);

  try {
    // Every layer's fields first: the checks need them, and so do typing values and finding ObjectIDs.
    const fieldsOf = new Map();
    for (const key of new Set([def?.startLayer, ...steps.map(s => s?.targetLayer)].filter(Boolean))) {
      try { fieldsOf.set(key, (await adapter.fields(key)) ?? []); }
      catch (e) { fieldsOf.set(key, []); if (ac.signal.aborted) throw stopped; }
    }
    const { errors, warnings } = checkTrace(def, { limits: lim, fieldsOf });
    report.warnings.push(...warnings);
    if (errors.length) { report.problems = errors; return finish('invalid', errors[0]); }
    if (!start?.length) return finish('invalid', 'Choose a feature to start from.');

    const recordsOf = new Map([[START, start]]);
    const cache = new Map();          // "<layer>|<field>|<ci>|<filters>" -> Map(value -> records)

    for (const [index, step] of steps.entries()) {
      const t0 = now();
      const targetFields = fieldsOf.get(step.targetLayer);
      const target = findField(targetFields, step.targetField);
      const kind = fieldKind(target.type);
      const ci = kind === 'text' && !!step.caseInsensitive;
      const oid = oidOf(targetFields);
      const isLast = index === steps.length - 1;
      const max = isLast ? Math.min(lim.maxFinal, lim.maxIdsPerStep) : lim.maxIdsPerStep;

      // Read only what's needed: the ObjectID, this key, keys later steps read from here, the results' fields.
      const needed = [oid, target.name,
        ...steps.slice(index + 1).filter(s => sourcesOf(s).includes(step.id)).map(s => findField(targetFields, s.sourceField)?.name),
        ...(isLast ? (def.finalFields ?? []).map(f => findField(targetFields, f.name)?.name) : [])];
      const outFields = [...new Set(needed.filter(Boolean))];

      // Source values: from every feature of every source, normalized for the target field, without repeats.
      const values = new Map();
      let skipped = 0;
      for (const from of sourcesOf(step)) {
        for (const rec of recordsOf.get(from) ?? []) {
          const raw = attr(rec, step.sourceField);
          const v = normalizeKey(raw, kind, ci);
          if (v == null) { if (raw != null && String(raw).trim() !== '') skipped++; continue; }
          values.set(valueKey(v), v);
        }
      }
      if (skipped) report.warnings.push(`${stepName(step, index)}: ${skipped} value${skipped === 1 ? '' : 's'} of ${step.sourceField} couldn't be matched to ${step.targetField} (not a number) and ${skipped === 1 ? 'was' : 'were'} skipped.`);

      const filters = filterClause(step.filters, targetFields);
      const sig = `${step.targetLayer}|${target.name}|${ci}|${filters}`;
      const known = cache.get(sig) ?? new Map();
      cache.set(sig, known);
      const todo = [...values.values()].filter(v => !known.has(valueKey(v)));
      const cachedValues = values.size - todo.length;

      // Matches, deduplicated by ObjectID (or by the whole record when the layer has none).
      const found = new Map();
      const recordKey = rec => (oid ? `o:${attr(rec, oid)}` : `r:${JSON.stringify(rec)}`);
      const add = rec => {
        const key = recordKey(rec);
        if (!found.has(key)) found.set(key, rec);
        if (found.size > max) {
          stop('limit', isLast
            ? `${stepName(step, index)} found more than ${max.toLocaleString('en-US')} results, the most this project allows. Narrow the trace with a filter or start from a smaller feature.`
            : `${stepName(step, index)} found more than ${max.toLocaleString('en-US')} features, the most one step may find. Add a filter to the step or start from a smaller feature.`);
        }
      };
      for (const v of values.values()) for (const rec of known.get(valueKey(v)) ?? []) add(rec);

      const stepReport = { id: step.id, index, layerKey: step.targetLayer, status: 'done', count: 0, values: values.size, skippedValues: skipped, cachedValues, queries: 0, ms: 0, records: [] };
      report.steps.push(stepReport);
      const parts = batches(todo, lim.batchSize);
      let batchesDone = 0;
      onProgress?.({ step, index, batchesDone, batches: parts.length, count: found.size });

      await pool(parts, lim.concurrency, async part => {
        const where = [`(${keyClause(target.name, kind, part, ci)})`, filters ? `(${filters})` : ''].filter(Boolean).join(' AND ');
        const got = [];
        const seenHere = new Set();     // a service that ignores the offset sends the same page again: stop there
        for (let offset = 0; ;) {
          if (ac.signal.aborted) return;
          stepReport.queries++;
          let res;
          try { res = await adapter.query(step.targetLayer, { where, outFields, offset, num: max + 1, signal: ac.signal }); }
          catch (e) {
            if (ac.signal.aborted) return;
            stop('error', `${stepName(step, index)}: querying ${step.targetLayer} failed: ${e?.message || 'the service didn\'t answer'}.`);
            return;
          }
          const recs = res?.records ?? [];
          const fresh = recs.filter(rec => !seenHere.has(recordKey(rec)));
          fresh.forEach(rec => seenHere.add(recordKey(rec)));
          got.push(...fresh);
          for (const rec of fresh) { add(rec); if (ac.signal.aborted) return; }
          if (res?.more && recs.length && !fresh.length) {
            report.warnings.push(`${stepName(step, index)}: ${step.targetLayer} sent the same records again when asked for the next page (it may not support paging), so some matches may be missing. Lower "Values per query" to ask for fewer at a time.`);
            break;
          }
          if (!res?.more || !recs.length) break;
          offset += recs.length;
        }
        // Remember every value of this batch, with what it matched ([] when nothing), for later steps.
        const byValue = new Map(part.map(v => [valueKey(v), []]));
        for (const rec of got) byValue.get(valueKey(normalizeKey(attr(rec, target.name), kind, ci)))?.push(rec);
        for (const [k, recs] of byValue) known.set(k, recs);
        onProgress?.({ step, index, batchesDone: ++batchesDone, batches: parts.length, count: found.size });
      }, ac.signal);

      Object.assign(stepReport, { count: Math.min(found.size, max), ms: now() - t0, records: [...found.values()].slice(0, max) });
      if (stopped) { stepReport.status = stopped.status === 'limit' ? 'limit' : 'stopped'; throw stopped; }
      recordsOf.set(step.id, stepReport.records);

      if (!found.size) {
        stepReport.status = 'empty';
        if (!step.optional || isLast) return finish('empty', `Nothing matched at ${stepName(step, index).toLowerCase()}, so the trace ends there with no results.`);
      }
    }

    const last = report.steps.at(-1);
    const lastStep = steps.at(-1);
    report.final = { layerKey: lastStep.targetLayer, oidField: oidOf(fieldsOf.get(lastStep.targetLayer)), records: last.records };
    return finish('done', `${last.count.toLocaleString('en-US')} ${def.resultLabel || 'results'} found.`);
  } catch (e) {
    if (e instanceof Stop) return finish(e.status, e.message);
    return finish('error', e?.message || 'The trace failed.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCancel);
  }
}
