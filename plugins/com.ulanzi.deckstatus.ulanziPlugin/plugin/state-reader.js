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

// --- Commander dashboard API -------------------------------------------------
export const COMMANDER_API_DEFAULT = 'http://127.0.0.1:8001';

// Base URL from deck_state/commander_api.txt (one line) or the default.
export async function readCommanderApi(stateDir) {
  try {
    const txt = await fs.readFile(path.join(stateDir, 'commander_api.txt'), 'utf8');
    return txt.trim() || COMMANDER_API_DEFAULT;
  } catch {
    return COMMANDER_API_DEFAULT;
  }
}

// Per-deck-key dashboard config: deck_state/commander_keys.json
//   { "0_0": "http://127.0.0.1:8001" }  — legacy URL string
//   { "0_0": { "apiBase": "http://...", "projectRepo": "owner/repo" } }
// Lets one key watch the local dashboard and another a REMOTE machine.
export async function readCommanderKeyMap(stateDir) {
  try {
    const obj = JSON.parse(await fs.readFile(path.join(stateDir, 'commander_keys.json'), 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function parseCommanderKeyEntry(entry) {
  if (!entry) return { apiBase: '', projectRepo: '' };
  if (typeof entry === 'string') return { apiBase: entry.trim(), projectRepo: '' };
  if (typeof entry === 'object') {
    return {
      apiBase: String(entry.apiBase || '').trim(),
      projectRepo: String(entry.projectRepo || '').trim(),
    };
  }
  return { apiBase: '', projectRepo: '' };
}

export async function readCommanderKeyEntry(stateDir, keyId) {
  const map = await readCommanderKeyMap(stateDir);
  return parseCommanderKeyEntry(map[keyId]);
}

async function writeCommanderKeyEntry(stateDir, keyId, patch) {
  if (!keyId) return false;
  try {
    await fs.mkdir(stateDir, { recursive: true });
    const map = await readCommanderKeyMap(stateDir);
    const cur = parseCommanderKeyEntry(map[keyId]);
    const next = {
      apiBase: patch.apiBase != null ? String(patch.apiBase || '').trim() : cur.apiBase,
      projectRepo: patch.projectRepo != null ? String(patch.projectRepo || '').trim() : cur.projectRepo,
    };
    if (!next.apiBase && !next.projectRepo) {
      delete map[keyId];
    } else if (next.apiBase && !next.projectRepo) {
      map[keyId] = next.apiBase; // keep legacy string form when only URL is set
    } else {
      map[keyId] = next;
    }
    await fs.writeFile(path.join(stateDir, 'commander_keys.json'), JSON.stringify(map, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

// Persist one key's URL (merge), so the Ulanzi PI edit sticks per-key.
export async function writeCommanderKey(stateDir, keyId, base) {
  const b = String(base || '').trim();
  if (!keyId || !b) return false;
  return writeCommanderKeyEntry(stateDir, keyId, { apiBase: b });
}

export async function writeCommanderProjectRepo(stateDir, keyId, projectRepo) {
  const repo = String(projectRepo || '').trim();
  if (!keyId || !repo) return false;
  return writeCommanderKeyEntry(stateDir, keyId, { projectRepo: repo });
}

// GET JSON, best-effort. Returns null on any error / non-200 / timeout.
async function fetchJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// /api/home -> project list for tap-to-cycle tracking (URL-only PI).
export async function readCommanderProjects(base) {
  const d = await fetchJson(`${base}/api/home`);
  if (!d || !Array.isArray(d.projects)) return { offline: true, projects: [] };
  const projects = d.projects
    .map((p) => ({
      name: String(p.name || ''),
      slug: String(p.slug || ''),
      repo: String(p.repo || ''),
      status: String(p.status || 'idle'),
    }))
    .filter((p) => p.repo)
    .sort((a, b) => a.slug.localeCompare(b.slug));
  return { offline: false, projects };
}

// /api/sprint-progress?repo=&project= — nav-pill source; both params required
// so Commander filters live/persisted tiers per project (repo alone is ignored).
export async function readSprintProgress(base, repo) {
  const q = encodeURIComponent(String(repo || ''));
  const d = await fetchJson(`${base}/api/sprint-progress?repo=${q}&project=${q}`);
  if (!d) return { offline: true, hasSprint: false, done: 0, total: 0, sprint: 0, runState: '' };
  return {
    offline: false,
    hasSprint: !!d.has_sprint,
    sprint: d.sprint ?? 0,
    done: d.done ?? 0,
    total: d.total ?? 0,
    runState: String(d.run_state || 'running'),
  };
}

// /api/agents -> { offline, agents: [...] }. Commander agents that are CURRENTLY
// relevant only: working now, or seen in the last AGENT_FRESH_SEC. The endpoint
// returns the full historical table, so without this filter you'd cycle dozens
// of long-dead agents. Sorted working-first, then most-recently-seen.
const AGENT_FRESH_SEC = 15 * 60;

export async function readCommanderAgents(base) {
  const d = await fetchJson(`${base}/api/agents`);
  if (!Array.isArray(d)) return { offline: true, agents: [] };
  const now = Date.now();
  const agents = d
    .filter((a) => String(a.working_dir || '').toLowerCase().includes('commander'))
    .map((a) => {
      const parts = String(a.name || '').split('·');
      const issue = (parts.find((p) => /^issue-\d+/.test(p)) || '').replace('issue-', '#');
      // last_seen is naive UTC (no tz) -> append Z.
      const t = Date.parse(String(a.last_seen || '') + 'Z');
      const ageSec = Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 1000)) : Infinity;
      return {
        role: parts[0] || 'agent',
        issue,
        status: String(a.status || ''),
        lastTool: String(a.last_tool || ''),
        name: String(a.name || ''),
        ageSec,
      };
    })
    .filter((a) => a.status === 'working' || a.ageSec < AGENT_FRESH_SEC)
    .sort((x, y) => {
      const wx = x.status === 'working' ? 0 : 1;
      const wy = y.status === 'working' ? 0 : 1;
      return wx - wy || x.ageSec - y.ageSec; // working first, then freshest
    });
  return { offline: false, agents };
}

// Claude Code session files written by cc-hook.sh: deck_state/cc_sessions/<id>.json
// = {state,cwd,label,ts,startedAt,turnStartedAt}. Stale working/waiting and old
// done/idle files are deleted on read.
const SESSION_FRESH_SEC = 20 * 60;    // beyond this, delete working/waiting zombies
const DONE_VISIBLE_SEC = 30 * 60;     // done sessions visible in cycle, then deleted
const IDLE_REAP_SEC = 2 * 60 * 60;   // SessionStart idle with no prompt
const SESSION_REAP_SEC = 6 * 60 * 60; // beyond this, delete any file

// Live claude processes keyed by cwd -> process start (unix sec). Used for real
// iTerm uptime (not just hook session startedAt) and to keep long turns visible.
let liveProcCache = { at: 0, byCwd: new Map() };
const LIVE_PROC_CACHE_MS = 5000;

// macOS ps uses etime ([[dd-]hh:]mm:ss), not GNU etimes.
function parsePsEtime(raw) {
  const t = String(raw || '').trim();
  if (!t) return NaN;
  let days = 0;
  let clock = t;
  if (t.includes('-')) {
    const [d, rest] = t.split('-');
    days = parseInt(d, 10) || 0;
    clock = rest;
  }
  const parts = clock.split(':').map((x) => parseInt(x, 10));
  let h = 0; let m = 0; let s = 0;
  if (parts.length === 3) [h, m, s] = parts;
  else if (parts.length === 2) [m, s] = parts;
  else if (parts.length === 1) [s] = parts;
  return days * 86400 + h * 3600 + m * 60 + s;
}

export async function getLiveClaudeByCwd() {
  const now = Date.now();
  if (now - liveProcCache.at < LIVE_PROC_CACHE_MS) return liveProcCache.byCwd;
  const byCwd = new Map();
  const nowSec = Math.floor(now / 1000);
  try {
    const { stdout } = await pexec('pgrep', ['-x', 'claude'], { timeout: 3000 });
    for (const line of String(stdout).trim().split('\n')) {
      const pid = line.trim();
      if (!pid) continue;
      try {
        const { stdout: lsofOut } = await pexec('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { timeout: 3000 });
        const cwd = String(lsofOut).split('\n').find((l) => l.startsWith('n'))?.slice(1);
        if (!cwd) continue;
        const { stdout: etimeOut } = await pexec('ps', ['-p', pid, '-o', 'etime='], { timeout: 3000 });
        const elapsed = parsePsEtime(etimeOut);
        const processStartedAt = Number.isFinite(elapsed) ? nowSec - elapsed : nowSec;
        const prev = byCwd.get(cwd);
        if (!prev || processStartedAt < prev.processStartedAt) {
          byCwd.set(cwd, { processStartedAt, pid });
        }
      } catch { /* process exited */ }
    }
  } catch { /* no claude running */ }
  liveProcCache = { at: now, byCwd };
  return byCwd;
}

function sessionShouldReap(obj, age, liveByCwd) {
  const state = String(obj.state || '');
  const label = String(obj.label || '');
  const cwd = String(obj.cwd || '');
  const live = liveByCwd?.has(cwd);
  if (!label && !cwd) return true;
  if (age > SESSION_REAP_SEC) return true;
  if ((state === 'working' || state === 'waiting') && age > SESSION_FRESH_SEC) {
    if (live) return false; // long turn: process still running at this cwd
    return true;
  }
  if (state === 'done' && age > DONE_VISIBLE_SEC) return true;
  if (state === 'idle' && age > IDLE_REAP_SEC && !live) return true;
  return false;
}

function parseSessionEntry(id, obj, now, liveByCwd) {
  const ts = Number(obj.ts) || 0;
  const age = now - ts;
  const state = String(obj.state || '');
  const cwd = String(obj.cwd || '');
  const liveInfo = liveByCwd?.get(cwd);
  const live = !!liveInfo;
  const processStartedAt = liveInfo?.processStartedAt || 0;
  return {
    id,
    state,
    cwd,
    label: String(obj.label || ''),
    ts,
    startedAt: Number(obj.startedAt) || ts,
    turnStartedAt: Number(obj.turnStartedAt) || 0,
    processStartedAt,
    ageSec: age,
    live,
    stale: (state === 'working' || state === 'waiting') && age > SESSION_FRESH_SEC && !live,
  };
}

const SESSION_ACTIVE_RANK = { working: 0, live: 1, waiting: 2, done: 3 };

// Full per-session list (newest first). Each: {id,state,cwd,label,ts,startedAt,
// turnStartedAt,ageSec,live,stale}. Stale working/waiting and old done/idle files are
// deleted on read. Generic over a sessions subdir so Claude (cc_sessions) and
// Cursor (cursor_sessions) share the exact same logic.
export async function readSessionList(stateDir, subdir = 'cc_sessions') {
  const dir = path.join(stateDir, subdir);
  let files;
  try { files = await fs.readdir(dir); } catch { return []; }
  const now = Math.floor(Date.now() / 1000);
  const liveByCwd = subdir === 'cc_sessions' ? await getLiveClaudeByCwd() : new Map();
  const list = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(dir, f);
    let obj;
    try { obj = JSON.parse(await fs.readFile(full, 'utf8')); } catch { continue; }
    const ts = Number(obj.ts) || 0;
    const age = now - ts;
    if (sessionShouldReap(obj, age, liveByCwd)) { fs.unlink(full).catch(() => {}); continue; }
    list.push(parseSessionEntry(f.replace(/\.json$/, ''), obj, now, liveByCwd));
  }
  list.sort((a, b) => a.ageSec - b.ageSec); // newest (smallest age) first
  return list;
}

// Cycle/mapped tiles: sessions worth showing right now.
// Includes idle when a live claude process is still at that cwd (iTerm tab open).
export async function readActiveSessionList(stateDir, subdir = 'cc_sessions') {
  const all = await readSessionList(stateDir, subdir);
  const list = all
    .filter((s) => {
      if (!s.label && !s.cwd) return false;
      if (['working', 'waiting', 'done'].includes(s.state)) return true;
      if (s.state === 'idle' && s.live) return true;
      return false;
    })
    .sort((a, b) => {
      const rank = (s) => {
        if (s.state === 'working') return SESSION_ACTIVE_RANK.working;
        if (s.state === 'waiting') return SESSION_ACTIVE_RANK.waiting;
        if (s.state === 'idle' && s.live) return SESSION_ACTIVE_RANK.live;
        return SESSION_ACTIVE_RANK.done;
      };
      return rank(a) - rank(b) || a.ageSec - b.ageSec;
    });
  return { list, anyFiles: all.length > 0 && list.length === 0 };
}

export function sessionDurationSec(sess, now) {
  const n = now ?? Math.floor(Date.now() / 1000);
  if (!sess) return 0;
  // Live iTerm tab — show real process uptime, not hook file timestamps.
  if (sess.live && sess.processStartedAt) {
    return Math.max(0, n - sess.processStartedAt);
  }
  if (sess.state === 'working') {
    const t = Number(sess.turnStartedAt) || Number(sess.ts) || 0;
    return t ? Math.max(0, n - t) : sess.ageSec;
  }
  return sess.ageSec;
}

export function sessionDurationText(sess, now) {
  const sec = sessionDurationSec(sess, now);
  if (sess?.state === 'done') return `done ${formatAge(sec)}`;
  return formatAge(sec);
}

// Tile line 1: project slug under ~/dev, or "-" when cwd is outside dev (plain iTerm).
export function sessionDisplayProject(sess) {
  const cwd = String(sess?.cwd || '').replace(/\/$/, '');
  if (!cwd) return '-';
  const parts = cwd.split('/').filter(Boolean);
  const devIdx = parts.lastIndexOf('dev');
  if (devIdx >= 0 && parts[devIdx + 1]) return parts[devIdx + 1];
  return '-';
}

export function sessionRole(sess) {
  const cwd = String(sess?.cwd || '').replace(/\/$/, '');
  const parts = cwd.split('/').filter(Boolean);
  return String(sess?.label || '') || parts[parts.length - 1] || 'session';
}

export const readClaudeSessionList = (stateDir) => readSessionList(stateDir, 'cc_sessions');

// Per-deck-key project/session map: deck_state/cc_keys.json = {"0_0":"coder",...}.
// Lets you assign keys to sessions without the (flaky) Ulanzi config panel.
export async function readKeyMap(stateDir) {
  try {
    const obj = JSON.parse(await fs.readFile(path.join(stateDir, 'cc_keys.json'), 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

// --- GitHub API rate-limit usage ---------------------------------------------
// Uses the gh CLI (handles auth via keychain). The host runs with a stripped
// PATH, so try `gh` then common Homebrew/local locations. /rate_limit does NOT
// count against the limit, so polling is free.
const GH_CANDIDATES = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];

async function ghApi(endpoint) {
  for (const bin of GH_CANDIDATES) {
    try {
      const { stdout } = await pexec(bin, ['api', endpoint], { timeout: 5000, windowsHide: true });
      return stdout;
    } catch (e) {
      if (e && e.code === 'ENOENT') continue; // not at this path, try next
      return null;                            // found but failed (auth/network)
    }
  }
  return null; // gh not found anywhere
}

// Returns { offline, used, limit, remaining, pct, resetMins } for the REST core.
export async function readGithubRate() {
  const out = await ghApi('/rate_limit');
  if (!out) return { offline: true };
  let core;
  try { core = JSON.parse(out).resources?.core; } catch { return { offline: true }; }
  if (!core) return { offline: true };
  const limit = core.limit || 1;
  const used = core.used != null ? core.used : limit - (core.remaining || 0);
  const pct = Math.round((used / limit) * 100);
  const resetMins = Math.max(0, Math.ceil((core.reset - Date.now() / 1000) / 60));
  return { offline: false, used, limit, remaining: core.remaining ?? limit - used, pct, resetMins };
}

// --- Cursor live AI activity (ai-code-tracking.db) ---------------------------
// Reads Cursor's AI-code tracking DB via the sqlite3 CLI (read-only). Counts
// AI-accepted ('composer') snippets recently and today. createdAt is epoch ms.
const CURSOR_AI_DB = path.join(os.homedir(), '.cursor/ai-tracking/ai-code-tracking.db');
const CURSOR_RECENT_MS = 15 * 60 * 1000; // "generating now" window
const SQLITE_CANDIDATES = ['sqlite3', '/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3'];

async function sqlite(dbPath, query) {
  for (const bin of SQLITE_CANDIDATES) {
    try {
      const { stdout } = await pexec(bin, ['-readonly', dbPath, query], { timeout: 4000, windowsHide: true });
      return stdout;
    } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      return null; // locked / bad db
    }
  }
  return null;
}

// Returns { offline, recent, today } — composer (AI) snippet counts.
export async function readCursorAiActivity() {
  const now = Date.now();
  const recentFrom = now - CURSOR_RECENT_MS;
  const midnight = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const q =
    `SELECT (SELECT COUNT(*) FROM ai_code_hashes WHERE source='composer' AND createdAt>=${recentFrom}),` +
    `(SELECT COUNT(*) FROM ai_code_hashes WHERE source='composer' AND createdAt>=${midnight});`;
  const out = await sqlite(CURSOR_AI_DB, q);
  if (out == null) return { offline: true, recent: 0, today: 0 };
  const [recent, today] = out.trim().split('|').map((n) => parseInt(n, 10) || 0);
  return { offline: false, recent, today };
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
//   - "my_tile"                   -> tile_my_tile.json|.txt               (tile name)
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

const KNOWN_COLORS = new Set(['green', 'teal', 'blue', 'purple', 'amber', 'yellow', 'red', 'grey', 'gray']);

function normalizeColor(c) {
  const v = String(c || '').trim().toLowerCase();
  if (v === 'yellow') return 'amber';
  if (v === 'gray') return 'grey';
  return KNOWN_COLORS.has(v) ? v : '';
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
          accent: normalizeColor(obj.accent),
          state: obj.state != null ? String(obj.state) : '',
          label: obj.label != null ? String(obj.label) : '',
          count: obj.count != null ? String(obj.count) : '',
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
        accent: '',
        state: '',
        label: '',
        count: counter ? value : '',
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
