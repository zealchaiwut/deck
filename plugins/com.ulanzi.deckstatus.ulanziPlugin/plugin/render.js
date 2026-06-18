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

// Title at the TOP (the deck slopes up, so the bottom edge is hidden).
function topLabel(label, x = SIZE / 2, anchor = 'middle', mono = false) {
  if (!label) return '';
  const t = String(label).length > 16 ? String(label).slice(0, 15) + '…' : String(label);
  return text(t, x, 32, 18, '600', DIM, anchor, mono);
}
// Pick a font size so the centered value fits the tile width.
function fitSize(s) {
  const n = String(s).length;
  if (n <= 2) return 90;
  if (n === 3) return 74;
  if (n <= 5) return 54;
  if (n <= 8) return 38;
  return 30;
}

// Size for a single centered word/phrase.
function wordSize(s) {
  const n = String(s).length;
  if (n <= 4) return 60;
  if (n <= 8) return 42;
  return 32;
}

// --- agent: radial glow; value in the MIDDLE, glyph (logo) TOP-RIGHT, title top
// `sub` renders a second centered line below `value` (e.g. "needs you" / "1/4").
function renderAgent({ accent, glyph: gname, label, state, count, value, sub, pulse = 1 }) {
  const a = hex(accent);
  let glyphColor = a, glyphAlpha = 1, showGlow = true;
  if (state === 'idle') { glyphAlpha = 0.32; showGlow = false; }
  else if (state === 'error') { glyphColor = COLORS.red; }
  else if (state === 'done') { glyphColor = COLORS.green; }
  else if (state === 'running') { glyphAlpha = 0.55 + 0.45 * pulse; }

  const main = (count != null && String(count).trim() !== '') ? String(count)
    : (value != null && String(value).trim() !== '') ? String(value)
    : (state || '—');
  const mainColor = state === 'error' ? COLORS.red : TEXT;
  const glowColor = state === 'error' ? COLORS.red : a;
  const defs = showGlow
    ? `<radialGradient id="glow" cx="50%" cy="50%" r="65%">` +
      `<stop offset="0%" stop-color="${glowColor}" stop-opacity="${(0.34 * (state === 'running' ? (0.6 + 0.4 * pulse) : 1)).toFixed(3)}"/>` +
      `<stop offset="62%" stop-color="${glowColor}" stop-opacity="0.05"/>` +
      `<stop offset="100%" stop-color="${glowColor}" stop-opacity="0"/></radialGradient>`
    : '';
  const hasSub = sub != null && String(sub).trim() !== '';
  const middle = hasSub
    ? text(main, SIZE / 2, 110, wordSize(main), '700', mainColor) +      // line 1 (status word)
      text(String(sub), SIZE / 2, 152, 34, '700', hex(accent))           // line 2 (e.g. "1/4")
    : text(main, SIZE / 2, 122, fitSize(main), '700', mainColor);        // single big value
  const body = [
    bg(),
    showGlow ? `<rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="34" fill="url(#glow)"/>` : '',
    topLabel(label, 16, 'start'),                          // title top-left
    glyph(gname || 'sparkles', SIZE - 34, 36, 44, glyphColor, glyphAlpha), // logo top-right
    middle,
  ].join('');
  return toDataUrl(svgDoc(body, defs));
}

// --- gauge: glyph + big % + meter bar (kept high for the slope) --------------
function gaugeColor(pct, override) {
  if (override) return hex(override);
  if (pct > 50) return COLORS.green;
  if (pct >= 20) return COLORS.amber;
  return COLORS.red;
}
function renderGauge({ accent, glyph: gname, value, color, label, emphasis }) {
  const pct = Math.max(0, Math.min(100, parseInt(String(value), 10) || 0));
  const a = gaugeColor(pct, color);
  const barW = Math.round((SIZE - 28) * (pct / 100));
  const valueStr = `${pct}%`;
  const glyphEl = emphasis
    ? glyph(gname || 'brand-github', SIZE - 34, 36, 48, a, 1)
    : glyph(gname || 'activity', SIZE / 2, 70, 38, hex(accent), 0.9);
  const valueEl = emphasis
    ? text(valueStr, SIZE / 2, 128, fitSize(valueStr), '700', TEXT)
    : text(valueStr, SIZE / 2, 128, 52, '700', TEXT);
  const body = [
    bg(),
    topLabel(label),
    glyphEl,
    valueEl,
    `<rect x="14" y="146" width="${SIZE - 28}" height="10" rx="5" fill="${TRACK}"/>`,
    `<rect x="14" y="146" width="${barW}" height="10" rx="5" fill="${a}"/>`,
  ].join('');
  return toDataUrl(svgDoc(body));
}

// --- ring: progress ring + done/total centered -------------------------------
function renderRing({ accent, done, total, value, label }) {
  const a = hex(accent);
  let pct, center;
  if (total != null && Number.isFinite(Number(total))) {
    const t = Number(total);
    pct = t > 0 ? Math.max(0, Math.min(1, Number(done || 0) / t)) : 0;
    center = `${done || 0}/${t}`;
  } else {
    pct = Math.max(0, Math.min(100, parseInt(String(value), 10) || 0)) / 100;
    center = `${Math.round(pct * 100)}%`;
  }
  const cx = SIZE / 2, cy = 100, r = 56, C = 2 * Math.PI * r;
  const dash = (pct * C).toFixed(2);
  const body = [
    bg(),
    topLabel(label),
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${TRACK}" stroke-width="14"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${a}" stroke-width="14" stroke-linecap="round" ` +
      `stroke-dasharray="${dash} ${(C - pct * C).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`,
    text(center, cx, cy + 12, 38, '700', TEXT),
  ].join('');
  return toDataUrl(svgDoc(body));
}

// --- timestat: glyph + big short value + title (top) -------------------------
const STATE_COLOR = { running: COLORS.blue, done: COLORS.green, error: COLORS.red, idle: DIM };
function renderTimestat({ accent, glyph: gname, value, state, label }) {
  const a = state && STATE_COLOR[state] ? STATE_COLOR[state] : hex(accent);
  const body = [
    bg(),
    topLabel(label || state),
    glyph(gname || 'player-play-filled', SIZE / 2, 72, 40, a, 0.95),
    text(String(value || '—'), SIZE / 2, 134, fitSize(value || '—'), '700', TEXT),
  ].join('');
  return toDataUrl(svgDoc(body));
}

// Sprint tile: three stacked lines (project / sprint / done).
function sprintLineSize(s) {
  const n = String(s).length;
  if (n > 12) return 28;
  if (n > 9) return 32;
  return 36;
}

// --- fill: background fills bottom-up by pct (progress-bar-as-tile).
// Default: small top label + big centered value (legacy).
// Sprint layout (slug set): line 1 project, line 2 sprint, line 3 done/total.
function renderFill({ accent, pct, value, label, slug, sprint, pos }) {
  const a = hex(accent);
  const p = Math.max(0, Math.min(1, Number(pct) || 0));
  const fillH = Math.round(SIZE * p);
  const y = SIZE - fillH;
  const defs = `<clipPath id="rc"><rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="34"/></clipPath>`;
  const fillRect = `<g clip-path="url(#rc)"><rect x="0" y="${y}" width="${SIZE}" height="${fillH}" fill="${a}" fill-opacity="0.9"/></g>`;

  if (slug) {
    const slugText = String(slug);
    const slugSize = sprintLineSize(slugText);
    const doneText = String(value != null ? value : '—');
    const doneSize = Math.round(fitSize(doneText) * 0.8);
    const sprintText = sprint ? `S${sprint}${pos ? ` · ${String(pos).trim()}` : ''}` : '—';
    const body = [
      bg(),
      fillRect,
      text(slugText, SIZE / 2, 64, slugSize, '700', TEXT),
      text(sprintText, SIZE / 2, 102, 22, '600', DIM),
      text(doneText, SIZE / 2, 142, doneSize, '700', TEXT),
    ].join('');
    return toDataUrl(svgDoc(body, defs));
  }

  const body = [
    bg(),
    fillRect,
    topLabel(label),
    text(String(value != null ? value : '—'), SIZE / 2, SIZE / 2 + 14, fitSize(value), '700', TEXT),
  ].join('');
  return toDataUrl(svgDoc(body, defs));
}

// --- repo: quiet/dim grey glyph + mono title (top) ---------------------------
function renderRepo({ glyph: gname, label }) {
  const body = [
    bg(),
    topLabel(label, SIZE / 2, 'middle', true),
    glyph(gname || 'git-branch', SIZE / 2, 100, 64, DIM, 0.5),
  ].join('');
  return toDataUrl(svgDoc(body));
}

// Dim neutral fallback (missing/locked source).
export function renderMissing(label) {
  const body = [bg(), topLabel(label), text('—', SIZE / 2, 122, 72, '700', DIM)].join('');
  return toDataUrl(svgDoc(body));
}

const RENDERERS = {
  agent: renderAgent,
  gauge: renderGauge,
  ring: renderRing,
  fill: renderFill,
  timestat: renderTimestat,
  repo: renderRepo,
};

// Dispatch. `style` picks the archetype; `data` carries merged PI + file fields.
export function render(style, data) {
  const fn = RENDERERS[style] || renderAgent;
  return fn(data || {});
}

// --- Session tiles: accent bar + big value (Claude/Cursor session keys) ------
const SESSION_BG = '#1f1f23';
const SESSION_TEXT = '#ffffff';
const SESSION_DIM = '#6b6b73';
const SESSION_SHADOW = 'rgba(0,0,0,0.85)';
const SESSION_ACCENT = {
  green: '#3ecf6b',
  amber: '#e3b341',
  red: '#e3434c',
  blue: '#4c9aff',
  grey: '#4a4a52',
};
const SESSION_LABEL_Y = 46;
const SESSION_VALUE_Y = 128;
const SESSION_LABEL_SIZE = 24;

function sessionAccent(color) {
  if (typeof color === 'string' && color[0] === '#') return color;
  return SESSION_ACCENT[color] || SESSION_ACCENT.grey;
}

function sessionValueFontSize(value) {
  const len = String(value).length;
  if (len <= 2) return 96;
  if (len === 3) return 74;
  if (len === 4) return 58;
  if (len <= 6) return 44;
  return 32;
}

function sessionText(t, x, y, size, weight, fill, anchor = 'middle') {
  return `<text x="${x}" y="${y}" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${fill}">${esc(t)}</text>`;
}

function sessionTextShadow(t, x, y, size, weight, fill) {
  return sessionText(t, x + 1.5, y + 1.5, size, weight, SESSION_SHADOW) + sessionText(t, x, y, size, weight, fill);
}

function sessionTruncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function renderTile({ value, color, label }) {
  const a = sessionAccent(color);
  const fs = sessionValueFontSize(value);
  const hasLabel = label && String(label).trim();
  const body = [
    `<rect x="0" y="0" width="${SIZE}" height="${SIZE}" fill="${SESSION_BG}"/>`,
    `<rect x="0" y="0" width="${SIZE}" height="18" fill="${a}"/>`,
    hasLabel ? sessionTextShadow(sessionTruncate(String(label), 18), SIZE / 2, SESSION_LABEL_Y, SESSION_LABEL_SIZE, '600', '#cfcfd6') : '',
    sessionTextShadow(String(value), SIZE / 2, SESSION_VALUE_Y, fs, '700', SESSION_TEXT),
  ].join('');
  return toDataUrl(svgDoc(body));
}

export function renderNeutral({ value = '—', label = '' } = {}) {
  const hasLabel = label && String(label).trim();
  const body = [
    `<rect x="0" y="0" width="${SIZE}" height="${SIZE}" fill="${SESSION_BG}"/>`,
    `<rect x="0" y="0" width="${SIZE}" height="18" fill="${SESSION_ACCENT.grey}"/>`,
    hasLabel ? sessionText(sessionTruncate(String(label), 18), SIZE / 2, SESSION_LABEL_Y, SESSION_LABEL_SIZE, '600', SESSION_DIM) : '',
    sessionTextShadow(String(value), SIZE / 2, SESSION_VALUE_Y, sessionValueFontSize(value), '700', SESSION_DIM),
  ].join('');
  return toDataUrl(svgDoc(body));
}
