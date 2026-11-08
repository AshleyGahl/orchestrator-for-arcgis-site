// disclaimer.js — the viewer's disclaimer (manifest "disclaimer"): defaults, checks, the text turned into paragraphs
// and links (no HTML ever comes from the manifest), and whether someone has already accepted this wording.
// Pure functions: storage and the clock are passed in. The dialog itself is in disclaimerDialog.js.

/** transition: how the disclaimer comes onto the screen. [id, label] */
export const DISCLAIMER_TRANSITIONS = [['left', 'Slide in from the left'], ['top', 'Drop in from the top'], ['center', 'Appear in the middle']];
/** remember: how long an acceptance lasts in that browser. [id, label] */
/** speed: how quickly it comes on screen; instant: no animation. [id, label] */
export const DISCLAIMER_SPEEDS = [['slow', 'Slow'], ['medium', 'Medium'], ['fast', 'Fast'], ['instant', 'Instant (no animation)']];
export const DISCLAIMER_REMEMBER = [['never', 'Every visit'], ['session', 'Until the browser is closed'], ['days', 'For a number of days']];
/** textSize: how large the title and text are (the button keeps its size). [id, label] */
export const DISCLAIMER_TEXT_SIZES = [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['xlarge', 'Extra large']];
export const TITLE_MAX = 120;
export const TEXT_MAX = 5000;
export const ACCEPT_LABEL_MAX = 40;
export const REMEMBER_DAYS_MAX = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The standard wording a new disclaimer starts with: general, for any organisation, edited per project. */
export const STANDARD_DISCLAIMER_TEXT = [
  'This map viewer is published for **general information only**. Please read these terms before you use it. In these terms, "we" and "us" mean the organisation that publishes this viewer.',
  '> **Not for emergencies.** In an emergency, phone the emergency services. Do not use this viewer for emergency response or navigation.',
  '## At a glance\n| What you see | How to treat it | The official source |\n|---|---|---|\n| Property boundaries, erf or parcel numbers | Approximate | The approved survey diagrams and the title deeds |\n| Zoning and land use | A guide | The approved zoning scheme and its register |\n| Property values | For reference | The official valuation roll |\n| Pipes, cables and other services | Indicative only | The service provider, confirmed on site |\n| Distances, areas and coordinates | Estimates | A professional land surveyor |',
  '## 1. Information only\nThe maps, data and results shown here are a guide. They are not:\n- an official record or a legal document\n- a certificate or a plan approval\n- a replacement for advice from a qualified professional or a written answer from us.',
  '## 2. No guarantee of accuracy\nWe take reasonable care to keep the data accurate and current, but it is compiled from many sources, at different dates and scales, and may contain errors, gaps or delays. No guarantee is given that it is accurate, complete, current or fit for any particular purpose.',
  '## 3. Boundaries, positions and measurements\nProperty boundaries, erf or parcel numbers, zoning, servitudes and other lines are approximate and may be shifted against the aerial imagery. They are not a substitute for a land survey, the approved survey diagrams, the title deeds or the approved zoning scheme. Distances, areas and coordinates measured in this viewer are **estimates only**.',
  '## 4. Valuations, zoning and other official information\nWhere property values, zoning or land-use information is shown, the official valuation roll, the zoning scheme register and our formal decisions take precedence over anything in this viewer.',
  '## 5. Services and infrastructure\nThe position of pipes, cables and other services is indicative only. **Never rely on this viewer to locate underground services before you dig or build:**\n- contact us and the relevant service providers\n- confirm positions on site.',
  '## 6. Not for emergencies or navigation\nDo not use this viewer for emergency response, navigation or any decision where an error could put people or property at risk.',
  '## 7. Limitation of liability\nTo the fullest extent allowed by law, we, our officials and our suppliers are not liable for any loss, damage, cost or claim, direct or indirect, that arises from using, or being unable to use, this viewer or its data, or from any decision made on the strength of it. **You use it at your own risk.**',
  '## 8. Third-party content\nBasemaps, imagery and some layers come from third parties (including Esri and its data partners) under their own terms and copyright. We do not control and are not responsible for them. Links to other websites are provided for convenience and do not mean we endorse their content.',
  '## 9. Availability and changes\nThe viewer and its data may change, be withdrawn or be unavailable at any time without notice. Downloads, where offered, are provided as they are, without support.',
  '## 10. Copyright and use of the data\nOur data in this viewer remains our property.\n| You may | You may not, without our written permission |\n|---|---|\n| View it and print it for personal and non-commercial reference | Resell it, or copy it in bulk |',
  '## 11. Personal information\nAny personal information is handled in line with the applicable data protection law, including the Protection of Personal Information Act 4 of 2013 (POPIA). Use personal information you see here only for a lawful purpose. Your acceptance of these terms is kept only in your own browser; it is not sent to us.',
  '## 12. Governing law\nThese terms are governed by the laws of the Republic of South Africa.',
  '> To report an error in the data, or for official information, please contact us.',
  '**By continuing you confirm that you have read, understood and accept these terms.**'
].join('\n\n');

/** The same terms as plain paragraphs, without formatting (no headings, tables, lists or notes). */
export const STANDARD_DISCLAIMER_PLAIN = [
  'This map viewer is published for general information only. Please read these terms before you use it. In these terms, "we" and "us" mean the organisation that publishes this viewer.',
  '1. Information only\nThe maps, data and results shown here are a guide. They are not an official record, a legal document, a certificate or a plan approval, and they do not replace advice from a qualified professional or a written answer from us.',
  '2. No guarantee of accuracy\nWe take reasonable care to keep the data accurate and current, but it is compiled from many sources, at different dates and scales, and may contain errors, gaps or delays. No guarantee is given that it is accurate, complete, current or fit for any particular purpose.',
  '3. Boundaries, positions and measurements\nProperty boundaries, erf or parcel numbers, zoning, servitudes and other lines are approximate and may be shifted against the aerial imagery. They are not a substitute for a land survey, the approved survey diagrams, the title deeds or the approved zoning scheme. Distances, areas and coordinates measured in this viewer are estimates only.',
  '4. Valuations, zoning and other official information\nWhere property values, zoning or land-use information is shown, the official valuation roll, the zoning scheme register and our formal decisions take precedence over anything in this viewer.',
  '5. Services and infrastructure\nThe position of pipes, cables and other services is indicative only. Never rely on this viewer to locate underground services before you dig or build: contact us and the relevant service providers, and confirm positions on site.',
  '6. Not for emergencies or navigation\nDo not use this viewer for emergency response, navigation or any decision where an error could put people or property at risk. In an emergency, phone the emergency services.',
  '7. Limitation of liability\nTo the fullest extent allowed by law, we, our officials and our suppliers are not liable for any loss, damage, cost or claim, direct or indirect, that arises from using, or being unable to use, this viewer or its data, or from any decision made on the strength of it. You use it at your own risk.',
  '8. Third-party content\nBasemaps, imagery and some layers come from third parties (including Esri and its data partners) under their own terms and copyright. We do not control and are not responsible for them. Links to other websites are provided for convenience and do not mean we endorse their content.',
  '9. Availability and changes\nThe viewer and its data may change, be withdrawn or be unavailable at any time without notice. Downloads, where offered, are provided as they are, without support.',
  '10. Copyright and use of the data\nOur data in this viewer remains our property. You may view and print it for personal and non-commercial reference. Do not resell it, or copy it in bulk, without our written permission.',
  '11. Personal information\nAny personal information is handled in line with the applicable data protection law, including the Protection of Personal Information Act 4 of 2013 (POPIA). Use personal information you see here only for a lawful purpose. Your acceptance of these terms is kept only in your own browser; it is not sent to us.',
  '12. Governing law\nThese terms are governed by the laws of the Republic of South Africa.',
  'To report an error in the data, or for official information, please contact us.',
  'By continuing you confirm that you have read, understood and accept these terms.'
].join('\n\n');

/** The standard wordings the editor offers: [id, button label, text]. The first is the default. */
export const STANDARD_WORDINGS = [
  ['formatted', 'Formatted: headings, tables and notes', STANDARD_DISCLAIMER_TEXT],
  ['plain', 'Plain paragraphs', STANDARD_DISCLAIMER_PLAIN]
];

export const defaultDisclaimer = () => ({
  enabled: false, title: 'Disclaimer', text: STANDARD_DISCLAIMER_TEXT, acceptLabel: 'I agree', textSize: 'medium', transition: 'center', speed: 'medium', remember: 'session', rememberDays: 30
});

export const isTransition = v => DISCLAIMER_TRANSITIONS.some(([id]) => id === v);
export const isRemember = v => DISCLAIMER_REMEMBER.some(([id]) => id === v);
export const isSpeed = v => DISCLAIMER_SPEEDS.some(([id]) => id === v);
export const isTextSize = v => DISCLAIMER_TEXT_SIZES.some(([id]) => id === v);

/** What's wrong with a disclaimer block (sentences without a "Disclaimer:" prefix). */
export function disclaimerProblems(d) {
  if (d == null || typeof d !== 'object' || Array.isArray(d)) return ['must be an object.'];
  const out = [];
  if (typeof d.enabled !== 'boolean') out.push('"enabled" must be true or false.');
  for (const k of ['title', 'text', 'acceptLabel']) if (typeof d[k] !== 'string') out.push(`"${k}" must be text.`);
  if (typeof d.title === 'string' && d.title.length > TITLE_MAX) out.push(`the title is longer than ${TITLE_MAX} characters.`);
  if (typeof d.text === 'string' && d.text.length > TEXT_MAX) out.push(`the text is longer than ${TEXT_MAX} characters.`);
  if (typeof d.acceptLabel === 'string' && d.acceptLabel.length > ACCEPT_LABEL_MAX) out.push(`the button label is longer than ${ACCEPT_LABEL_MAX} characters.`);
  if (d.enabled === true) {
    if (typeof d.text === 'string' && !d.text.trim()) out.push('it is switched on but has no text.');
    if (typeof d.acceptLabel === 'string' && !d.acceptLabel.trim()) out.push('the button needs a label.');
  }
  if (!isTextSize(d.textSize)) out.push(`"textSize" must be one of ${DISCLAIMER_TEXT_SIZES.map(([id]) => id).join(', ')}.`);
  if (!isTransition(d.transition)) out.push(`"transition" must be one of ${DISCLAIMER_TRANSITIONS.map(([id]) => id).join(', ')}.`);
  if (!isSpeed(d.speed)) out.push(`"speed" must be one of ${DISCLAIMER_SPEEDS.map(([id]) => id).join(', ')}.`);
  if (!isRemember(d.remember)) out.push(`"remember" must be one of ${DISCLAIMER_REMEMBER.map(([id]) => id).join(', ')}.`);
  if (!Number.isInteger(d.rememberDays) || d.rememberDays < 1 || d.rememberDays > REMEMBER_DAYS_MAX) out.push(`"rememberDays" must be a whole number from 1 to ${REMEMBER_DAYS_MAX}.`);
  return out;
}

/** True when the viewer shows a disclaimer. */
export const showsDisclaimer = d => d?.enabled === true && typeof d.text === 'string' && d.text.trim() !== '';

const URL_RE = /https:\/\/[^\s<>"']+/g;
const TRAILING = /[.,;:!?)\]}'"]+$/;
const BOLD_RE = /\*\*(.+?)\*\*/g;
const HEADING = /^#{1,3}\s+(.+)$/;
const BULLET = /^[-*•]\s+(.+)$/;
const NOTE = /^>\s?(.*)$/;
const ROW = /^\|.*\|$/;
const HEADER_RULE = /^\|(:?-{3,}:?\|)+$/;        // |---|:---:| (spaces taken out first)

/** One line's parts: **bold** and https:// links. [{ text, bold?, href? }] */
function inlineParts(line) {
  const parts = [];
  const plain = (s, bold) => {
    let at = 0;
    for (const m of s.matchAll(URL_RE)) {
      const href = m[0].replace(TRAILING, '');
      if (m.index > at) parts.push({ text: s.slice(at, m.index), ...(bold && { bold }) });
      parts.push({ text: href, href, ...(bold && { bold }) });
      at = m.index + href.length;
    }
    if (at < s.length) parts.push({ text: s.slice(at), ...(bold && { bold }) });
  };
  let at = 0;
  for (const m of line.matchAll(BOLD_RE)) {
    plain(line.slice(at, m.index), false);
    plain(m[1], true);
    at = m.index + m[0].length;
  }
  plain(line.slice(at), false);
  return parts;
}

const cells = line => line.slice(1, -1).split('|').map(c => inlineParts(c.trim()));

/**
 * The text as blocks, from a small plain-text format (no HTML, so nothing to sanitise). Line by line:
 *   ## Heading        { type: 'heading', parts }        (#, ## or ###)
 *   - item / * item   { type: 'list', items: [parts] }  (lines in a row make one list)
 *   | a | b |         { type: 'table', head, rows }     (a |---|---| line under the first row makes it the header)
 *   > note            { type: 'note', parts }           (a highlighted box; lines in a row make one note)
 *   anything else     { type: 'paragraph', parts }      (a line break stays; a blank line starts a new block)
 * parts: [{ text, bold?, href? } | { br: true }], from **bold** and https:// addresses.
 */
export function disclaimerBlocks(text) {
  const blocks = [];
  let cur = null;
  const open = type => { if (cur?.type !== type) blocks.push(cur = type === 'list' ? { type, items: [] } : type === 'table' ? { type, head: null, rows: [] } : { type, parts: [] }); return cur; };
  const addLine = (b, parts) => { if (b.parts.length && parts.length) b.parts.push({ br: true }); b.parts.push(...parts); };
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    let m;
    if (!line) cur = null;
    else if ((m = HEADING.exec(line))) { blocks.push({ type: 'heading', parts: inlineParts(m[1]) }); cur = null; }
    else if ((m = BULLET.exec(line))) open('list').items.push(inlineParts(m[1]));
    else if (ROW.test(line)) {
      const t = open('table');
      if (!HEADER_RULE.test(line.replace(/\s/g, ''))) t.rows.push(cells(line));
      else if (!t.head && t.rows.length === 1) t.head = t.rows.pop();
    }
    else if ((m = NOTE.exec(line))) addLine(open('note'), inlineParts(m[1]));
    else addLine(open('paragraph'), inlineParts(line));
  }
  for (const t of blocks) if (t.type === 'table') {
    const cols = Math.max(t.head?.length ?? 0, ...t.rows.map(r => r.length));
    for (const r of [t.head, ...t.rows]) while (r && r.length < cols) r.push([]);
  }
  return blocks.filter(b => b.type === 'table' ? b.head || b.rows.length : b.type === 'list' || b.parts.length);
}

/** A short fingerprint of the wording people agree to: change the title, text or button and everyone is asked again. */
export function disclaimerHash(d) {
  const s = JSON.stringify([d?.title ?? '', d?.text ?? '', d?.acceptLabel ?? '']);
  let h = 0x811c9dc5;                                // FNV-1a, 32 bits
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The storage key for one viewer's acceptance. */
export const acceptanceKey = viewerId => `gis-viewer-disclaimer:${viewerId}`;

/** Which store the acceptance goes in: null (never kept), 'session' or 'local'. */
export const acceptanceStore = d => (d?.remember === 'session' ? 'session' : d?.remember === 'days' ? 'local' : null);

/** The value to keep once someone accepts. */
export const acceptanceRecord = (d, now) => JSON.stringify({ hash: disclaimerHash(d), at: now });

/** True when a kept value (or null) shows this wording was accepted and hasn't run out. */
export function isAccepted(d, stored, now) {
  if (!acceptanceStore(d) || typeof stored !== 'string') return false;
  let rec;
  try { rec = JSON.parse(stored); } catch { return false; }
  if (rec?.hash !== disclaimerHash(d) || typeof rec.at !== 'number') return false;
  if (d.remember === 'days') return now >= rec.at && now - rec.at < d.rememberDays * DAY_MS;
  return true;
}
