// renderer.js — draw a 196x196 status tile as an SVG, returned as a base64
// data URL ready for $UD.setBaseDataIcon(context, dataUrl, ''). Pure JS: the
// host renders SVG directly, so no canvas/PNG dependency is needed.

const SIZE = 196; // UlanziDeck key canvas is 196x196.

// Accent color map. 'grey' is the neutral default.
const COLORS = {
  green: '#3ecf6b',
  amber: '#e3b341',
  red:   '#e3434c',
  blue:  '#4c9aff',
  grey:  '#4a4a52',
};
const BG = '#1f1f23';
const TEXT = '#ffffff';
const DIM_TEXT = '#6b6b73';
const SHADOW = 'rgba(0,0,0,0.85)';

function accent(color) {
  if (typeof color === 'string' && color[0] === '#') return color; // raw hex
  return COLORS[color] || COLORS.grey;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function svgDoc(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">${body}</svg>`;
}

function toDataUrl(svg) {
  const b64 = Buffer.from(svg).toString('base64');
  return `data:image/svg+xml;base64,${b64}`;
}

function text(t, x, y, size, weight, fill, anchor = 'middle') {
  return `<text x="${x}" y="${y}" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${fill}">${escapeXml(t)}</text>`;
}

function textShadow(t, x, y, size, weight, fill) {
  return text(t, x + 1.5, y + 1.5, size, weight, SHADOW) + text(t, x, y, size, weight, fill);
}

// Pick a value font size that keeps long strings on the tile.
function valueFontSize(value) {
  const len = String(value).length;
  if (len <= 2) return 96;
  if (len === 3) return 74;
  if (len === 4) return 58;
  if (len <= 6) return 44;
  return 32;
}

// Render an active tile: accent strip on top, big value, optional small label.
// Deck sits at a slope -> the bottom of each tile is hidden. So the label (the
// "second line") goes at the TOP, just under the accent bar, and the big value
// stays at one fixed center position across every tile.
const LABEL_Y = 46;    // top, under the accent bar
const VALUE_Y = 128;   // constant middle baseline for all tiles
const LABEL_SIZE = 24; // top line ("idle 3/3", "ready", ...)

export function renderTile({ value, color, label }) {
  const a = accent(color);
  const fs = valueFontSize(value);
  const hasLabel = label && String(label).trim();

  const body = [
    `<rect x="0" y="0" width="${SIZE}" height="${SIZE}" fill="${BG}"/>`,
    // accent bar across the top
    `<rect x="0" y="0" width="${SIZE}" height="18" fill="${a}"/>`,
    hasLabel ? textShadow(truncate(String(label), 18), SIZE / 2, LABEL_Y, LABEL_SIZE, '600', '#cfcfd6') : '',
    textShadow(String(value), SIZE / 2, VALUE_Y, fs, '700', TEXT),
  ].join('');

  return toDataUrl(svgDoc(body));
}

// Render a dim neutral tile for missing / empty / zero values.
export function renderNeutral({ value = '—', label = '' } = {}) {
  const hasLabel = label && String(label).trim();
  const body = [
    `<rect x="0" y="0" width="${SIZE}" height="${SIZE}" fill="${BG}"/>`,
    `<rect x="0" y="0" width="${SIZE}" height="18" fill="${COLORS.grey}"/>`,
    hasLabel ? text(truncate(String(label), 18), SIZE / 2, LABEL_Y, LABEL_SIZE, '600', DIM_TEXT) : '',
    textShadow(String(value), SIZE / 2, VALUE_Y, valueFontSize(value), '700', DIM_TEXT),
  ].join('');
  return toDataUrl(svgDoc(body));
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
