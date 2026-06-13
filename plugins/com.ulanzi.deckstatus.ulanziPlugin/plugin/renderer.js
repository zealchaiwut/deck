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
export function renderTile({ value, color, label }) {
  const a = accent(color);
  const fs = valueFontSize(value);
  const hasLabel = label && String(label).trim();
  const valueY = hasLabel ? 118 : 128;

  const body = [
    `<rect x="0" y="0" width="${SIZE}" height="${SIZE}" fill="${BG}"/>`,
    // accent bar across the top
    `<rect x="0" y="0" width="${SIZE}" height="18" fill="${a}"/>`,
    // accent dot bottom-center as a subtle state cue
    `<circle cx="${SIZE / 2}" cy="${SIZE - 14}" r="5" fill="${a}"/>`,
    textShadow(String(value), SIZE / 2, valueY, fs, '700', TEXT),
    hasLabel ? textShadow(truncate(String(label), 18), SIZE / 2, 168, 22, '600', '#cfcfd6') : '',
  ].join('');

  return toDataUrl(svgDoc(body));
}

// Render a dim neutral tile for missing / empty / zero values.
export function renderNeutral({ value = '—', label = '' } = {}) {
  const hasLabel = label && String(label).trim();
  const body = [
    `<rect x="0" y="0" width="${SIZE}" height="${SIZE}" fill="${BG}"/>`,
    `<rect x="0" y="0" width="${SIZE}" height="18" fill="${COLORS.grey}"/>`,
    textShadow(String(value), SIZE / 2, hasLabel ? 116 : 126, valueFontSize(value), '700', DIM_TEXT),
    hasLabel ? text(truncate(String(label), 18), SIZE / 2, 166, 22, '600', DIM_TEXT) : '',
  ].join('');
  return toDataUrl(svgDoc(body));
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
