// render.js — rich 196x196 status-tile renderer (pure-JS SVG -> base64 data URL).
// Five archetypes: agent | gauge | ring | timestat | repo. No canvas dependency;
// the host renders SVG directly via setBaseDataIcon. Tabler glyphs are bundled
// (glyphs.js) and rasterized inline — nothing is fetched at runtime.

import { GLYPHS } from './glyphs.js';

const SIZE = 196;
const BASE = '#191a1d';   // dark base
const TRACK = '#2a2c30';  // ring/meter track
const TEXT = '#f2f3f5';
const DIM = '#6b7280';

// One CONFIG color map (identity accents).
export const COLORS = {
  green:  '#3ecf6b',
  teal:   '#2dd4bf',
  blue:   '#4c9aff',
  purple: '#a06cff',
  amber:  '#e3b341',
  red:    '#e3434c',
  grey:   '#6b7280',
};
function hex(c) {
  if (typeof c === 'string' && c[0] === '#') return c;
  return COLORS[c] || COLORS.grey;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function svgDoc(body, defs = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">${defs}${body}</svg>`;
}
function toDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
function bg() {
  return `<rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="34" fill="${BASE}"/>`;
}
function text(t, x, y, size, weight, fill, anchor = 'middle', mono = false) {
  const fam = mono ? "'SF Mono',Menlo,monospace" : '-apple-system,Helvetica,Arial,sans-serif';
  return `<text x="${x}" y="${y}" font-family="${fam}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${fill}">${esc(t)}</text>`;
}

// Draw a bundled glyph centered at (cx,cy) at a given pixel box size, in `color`.
function glyph(name, cx, cy, box, color, alpha = 1) {
  const g = GLYPHS[name] || GLYPHS.sparkles;
  const scale = box / 24;
  const tx = cx - box / 2;
  const ty = cy - box / 2;
  const paint = g.mode === 'fill'
    ? `fill="${color}" stroke="none"`
    : `fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
  return `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})" ${paint} opacity="${alpha}">${g.body}</g>`;
}

// Top-right count/check badge.
function badge(content, color) {
  const r = 17, cx = SIZE - 26, cy = 26;
  const w = Math.max(34, 14 + String(content).length * 11);
  const x = SIZE - 10 - w;
  return (
    `<rect x="${x}" y="9" width="${w}" height="34" rx="17" fill="${color}"/>` +
    text(content, x + w / 2, 31, 18, '700', '#10110f')
  );
}
function checkBadge(color) {
  const cx = SIZE - 26, cy = 26;
  return `<circle cx="${cx}" cy="${cy}" r="18" fill="${color}"/>` +
    `<g transform="translate(${cx - 9} ${cy - 9}) scale(0.75)" fill="none" stroke="#10110f" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${GLYPHS.check.body}</g>`;
}
function bottomLabel(label, mono = false) {
  if (!label) return '';
  const t = String(label).length > 16 ? String(label).slice(0, 15) + '…' : String(label);
  return text(t, SIZE / 2, 180, 18, '600', DIM, 'middle', mono);
}

// --- agent: radial glow + hero glyph + optional count/check + label ----------
function renderAgent({ accent, glyph: gname, label, state, count, pulse = 1 }) {
  const a = hex(accent);
  let glyphColor = a, glyphAlpha = 1, showGlow = true, topRight = '';
  if (state === 'idle') { glyphAlpha = 0.32; showGlow = false; }
  else if (state === 'error') { glyphColor = COLORS.red; }
  else if (state === 'running') { glyphAlpha = 0.55 + 0.45 * pulse; }
  if (state === 'done') topRight = checkBadge(COLORS.green);
  else if (count != null && String(count).trim() !== '') topRight = badge(String(count), a);

  const glowColor = state === 'error' ? COLORS.red : a;
  const defs = showGlow
    ? `<radialGradient id="glow" cx="50%" cy="46%" r="62%">` +
      `<stop offset="0%" stop-color="${glowColor}" stop-opacity="${(0.42 * (state === 'running' ? (0.6 + 0.4 * pulse) : 1)).toFixed(3)}"/>` +
      `<stop offset="60%" stop-color="${glowColor}" stop-opacity="0.06"/>` +
      `<stop offset="100%" stop-color="${glowColor}" stop-opacity="0"/></radialGradient>`
    : '';
  const body = [
    bg(),
    showGlow ? `<rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="34" fill="url(#glow)"/>` : '',
    glyph(gname || 'sparkles', SIZE / 2, 92, 84, glyphColor, glyphAlpha),
    topRight,
    bottomLabel(label),
  ].join('');
  return toDataUrl(svgDoc(body, defs));
}

// --- gauge: glyph + big % + bottom meter bar ---------------------------------
function gaugeColor(pct, override) {
  if (override) return hex(override);
  if (pct > 50) return COLORS.green;
  if (pct >= 20) return COLORS.amber;
  return COLORS.red;
}
function renderGauge({ accent, glyph: gname, value, color, label }) {
  const pct = Math.max(0, Math.min(100, parseInt(String(value), 10) || 0));
  const a = gaugeColor(pct, color);
  const barW = Math.round((SIZE - 28) * (pct / 100));
  const body = [
    bg(),
    glyph(gname || 'activity', SIZE / 2, 58, 44, hex(accent), 0.9),
    text(`${pct}%`, SIZE / 2, 132, 54, '700', TEXT),
    `<rect x="14" y="160" width="${SIZE - 28}" height="10" rx="5" fill="${TRACK}"/>`,
    `<rect x="14" y="160" width="${barW}" height="10" rx="5" fill="${a}"/>`,
    label ? text(String(label), SIZE / 2, 186, 15, '600', DIM) : '',
  ].join('');
  return toDataUrl(svgDoc(body));
}

// --- ring: progress ring + done/total centered -------------------------------
function renderRing({ accent, done, total, value, label }) {
  const a = hex(accent);
  let pct, center;
  if (total != null && Number(total) > 0) {
    pct = Math.max(0, Math.min(1, Number(done || 0) / Number(total)));
    center = `${done || 0}/${total}`;
  } else {
    pct = Math.max(0, Math.min(100, parseInt(String(value), 10) || 0)) / 100;
    center = `${Math.round(pct * 100)}%`;
  }
  const cx = SIZE / 2, cy = 88, r = 58, C = 2 * Math.PI * r;
  const dash = (pct * C).toFixed(2);
  const body = [
    bg(),
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${TRACK}" stroke-width="14"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${a}" stroke-width="14" stroke-linecap="round" ` +
      `stroke-dasharray="${dash} ${(C - pct * C).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`,
    text(center, cx, cy + 12, 38, '700', TEXT),
    bottomLabel(label),
  ].join('');
  return toDataUrl(svgDoc(body));
}

// --- timestat: glyph + big short value + state label -------------------------
const STATE_COLOR = { running: COLORS.blue, done: COLORS.green, error: COLORS.red, idle: DIM };
function renderTimestat({ accent, glyph: gname, value, state, label }) {
  const a = state && STATE_COLOR[state] ? STATE_COLOR[state] : hex(accent);
  const body = [
    bg(),
    glyph(gname || 'player-play-filled', SIZE / 2, 56, 40, a, 0.95),
    text(String(value || '—'), SIZE / 2, 128, 52, '700', TEXT),
    text(String(label || state || ''), SIZE / 2, 168, 18, '600', DIM),
  ].join('');
  return toDataUrl(svgDoc(body));
}

// --- repo: quiet/dim grey glyph + mono label ---------------------------------
function renderRepo({ glyph: gname, label }) {
  const body = [
    bg(),
    glyph(gname || 'git-branch', SIZE / 2, 84, 64, DIM, 0.5),
    label ? text(String(label), SIZE / 2, 168, 16, '600', DIM, 'middle', true) : '',
  ].join('');
  return toDataUrl(svgDoc(body));
}

// Dim neutral fallback (missing/locked source).
export function renderMissing(label) {
  const body = [bg(), text('—', SIZE / 2, 110, 72, '700', DIM), label ? bottomLabel(label) : ''].join('');
  return toDataUrl(svgDoc(body));
}

const RENDERERS = {
  agent: renderAgent,
  gauge: renderGauge,
  ring: renderRing,
  timestat: renderTimestat,
  repo: renderRepo,
};

// Dispatch. `style` picks the archetype; `data` carries merged PI + file fields.
export function render(style, data) {
  const fn = RENDERERS[style] || renderAgent;
  return fn(data || {});
}
