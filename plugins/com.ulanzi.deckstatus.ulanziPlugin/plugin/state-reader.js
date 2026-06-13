// state-reader.js — resolve a bound "source" to a file under STATE_DIR and read
// its current value. Pure Node, no deps. Every read is best-effort: on any
// error (missing / locked / partial file) it returns { missing: true } and the
// caller just skips that render cycle. This module never writes except reset().

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const pexec = promisify(execFile);
const DEFAULT_STATE_DIR = path.join(os.homedir(), 'dev/deck/scripts/deck_state');

// Expand a leading ~ and trim whitespace. Empty -> ''.
export function expandPath(p) {
  let s = String(p || '').trim();
  if (!s) return '';
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

// Expand a leading ~ and trim whitespace. Empty -> default.
export function resolveStateDir(settings) {
  const dir = expandPath(settings && settings.stateDir);
  return dir || DEFAULT_STATE_DIR;
}

// Fallback project for the Antigravity tile when nothing else is configured.
export const DEFAULT_PROJECT = '~/dev/commander/prd';

// Read the project path from deck_state/antigravity_project.txt (one line).
// This is the reliable config channel — no dependency on the deck UI saving
// settings. Returns '' if the file is missing/empty.
export async function readProjectConfig(stateDir) {
  try {
    const txt = await fs.readFile(path.join(stateDir, 'antigravity_project.txt'), 'utf8');
    return txt.trim();
  } catch {
    return '';
  }
}

// Persist the project path to the config file. The Ulanzi PI funnels the value
// it sends into here, so the config file (which the tile always reads) becomes
// the single source of truth and survives restarts even if the host drops the
// action setting. Best-effort; never throws.
export async function writeProjectConfig(stateDir, projectPath) {
  const p = String(projectPath || '').trim();
  if (!p) return false;
  try {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, 'antigravity_project.txt'), p + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

// Human "time since" — short and tile-friendly.
export function formatAge(sec) {
  const s = Math.max(0, Math.floor(sec));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(s / 3600);
  if (h < 24) return `${h}h`;
  const d = Math.floor(s / 86400);
  return `${d}d`;
}

// Read the latest commit of a git project. Best-effort: returns { missing:true }
// if the path isn't a git repo, git is unavailable, or anything throws.
// Returns { missing:false, hash, ageSec, ageText } on success.
export async function readProjectCommit(projectPath) {
  const empty = { missing: true, hash: '', ageSec: 0, ageText: '' };
  const p = expandPath(projectPath);
  if (!p) return empty;
  try {
    // %h = short hash, %ct = committer date (unix seconds)
    const { stdout } = await pexec('git', ['-C', p, 'log', '-1', '--format=%h%n%ct'], {
      timeout: 4000,
      windowsHide: true,
    });
    const lines = stdout.trim().split('\n');
    const hash = (lines[0] || '').trim();
    const ct = parseInt((lines[1] || '').trim(), 10);
    if (!hash || !Number.isFinite(ct)) return empty;
    const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - ct);
    return { missing: false, hash, ageSec, ageText: formatAge(ageSec) };
  } catch {
    return empty;
  }
}

// Turn a bound "source" into an absolute file path + kind.
//   - "coding_antigravity"        -> tile_coding_antigravity.json|.txt   (tile name)
//   - "antigravity_count.txt"     -> antigravity_count.txt               (direct path)
//   - "sub/dir/foo.json"          -> sub/dir/foo.json                    (direct path)
// Returns { jsonPath, txtPath } candidates to try in order (some may be null).
function candidatePaths(stateDir, source) {
  const src = String(source || '').trim();
  if (!src) return { jsonPath: null, txtPath: null };

  const looksLikePath = /[\\/]/.test(src) || /\.(json|txt)$/i.test(src);
  if (looksLikePath) {
    const abs = path.resolve(stateDir, src);
    if (/\.json$/i.test(src)) return { jsonPath: abs, txtPath: null };
    return { jsonPath: null, txtPath: abs };
  }
  // bare tile name -> prefer the richer .json, fall back to .txt
  return {
    jsonPath: path.join(stateDir, `tile_${src}.json`),
    txtPath: path.join(stateDir, `tile_${src}.txt`),
  };
}

// A .txt file whose name ends in count.txt (e.g. antigravity_count.txt) is a
// resettable integer counter.
function isCounterPath(p) {
  return !!p && /count\.txt$/i.test(path.basename(p));
}

const KNOWN_COLORS = new Set(['green', 'amber', 'yellow', 'red', 'blue', 'grey', 'gray']);

function normalizeColor(c) {
  const v = String(c || '').trim().toLowerCase();
  if (v === 'yellow') return 'amber';
  if (v === 'gray') return 'grey';
  return KNOWN_COLORS.has(v) ? (v === 'gray' ? 'grey' : v) : '';
}

async function readFileSafe(p) {
  if (!p) return null;
  try {
    const txt = await fs.readFile(p, 'utf8');
    return txt;
  } catch {
    return null;
  }
}

// Read the bound source. Always resolves; never throws.
// Returns: {
//   missing: bool,         // file not found / unreadable
//   value: string,         // text to show big
//   color: string,         // normalized accent color ('' = default grey)
//   state: string,         // optional state word from json
//   label: string,         // optional small label from json
//   isCounter: bool,       // resolved file is a *count.txt
//   counterPath: string,   // absolute path to reset, when isCounter
// }
export async function readSource(stateDir, source) {
  const empty = { missing: true, value: '', color: '', state: '', label: '', isCounter: false, counterPath: '' };
  try {
    const { jsonPath, txtPath } = candidatePaths(stateDir, source);

    // Try JSON first (richer payload).
    const jsonRaw = await readFileSafe(jsonPath);
    if (jsonRaw != null) {
      let obj;
      try { obj = JSON.parse(jsonRaw); } catch { obj = null; }
      if (obj && typeof obj === 'object') {
        return {
          missing: false,
          value: obj.value != null ? String(obj.value) : '',
          color: normalizeColor(obj.color),
          state: obj.state != null ? String(obj.state) : '',
          label: obj.label != null ? String(obj.label) : '',
          isCounter: false,
          counterPath: '',
        };
      }
      // partial/garbage json -> treat as a skip this cycle
      return empty;
    }

    // Fall back to .txt (plain value or integer counter).
    const txtRaw = await readFileSafe(txtPath);
    if (txtRaw != null) {
      const value = txtRaw.trim();
      const counter = isCounterPath(txtPath);
      return {
        missing: false,
        value,
        color: '',
        state: '',
        label: '',
        isCounter: counter,
        counterPath: counter ? txtPath : '',
      };
    }

    return empty;
  } catch {
    return empty;
  }
}

// Reset a counter file to "0". Best-effort; logs nothing, never throws.
export async function resetCounter(counterPath) {
  if (!counterPath) return false;
  try {
    await fs.writeFile(counterPath, '0\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}
