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

// /api/sprint-status -> { offline, running: [{label,closed,total,wallSecs}] }
export async function readSprintStatus(base) {
  const d = await fetchJson(`${base}/api/sprint-status`);
  if (!d) return { offline: true, running: [] };
  const running = (d.running_sprints || []).map((s) => ({
    label: String(s.sprint_label || '').replace(/^sprint-/, ''),
    closed: s.progress?.closed ?? 0,
    total: s.progress?.total ?? 0,
    wallSecs: s.wall_clock_secs || 0,
  }));
  return { offline: false, running };
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

// /api/sprint-progress?repo= — same source of truth as the dashboard nav pill.
export async function readSprintProgress(base, repo) {
  const q = encodeURIComponent(String(repo || ''));
  const d = await fetchJson(`${base}/api/sprint-progress?repo=${q}`);
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

// Aggregate Claude Code session files written by cc-hook.sh into one summary.
// Each file is deck_state/cc_sessions/<id>.json = {state,cwd,label,ts}.
//   working/waiting count only when fresh (a crashed session leaves a stale
//   "working" file; we don't let it pin the light on). Very old files are
//   deleted. Returns { working, waiting, total, waitingLabel, workingLabel }.
const SESSION_FRESH_SEC = 20 * 60;   // beyond this, a working/waiting entry is treated as dead
const SESSION_REAP_SEC = 6 * 60 * 60; // beyond this, delete the file entirely

// Full per-session list (newest first). Each: {id,state,cwd,label,ageSec,stale}.
// stale = older than SESSION_FRESH_SEC (treat working/waiting as idle). Files
// older than SESSION_REAP_SEC are deleted.
// Generic over a sessions subdir so Claude (cc_sessions) and Cursor
// (cursor_sessions) share the exact same logic.
export async function readSessionList(stateDir, subdir = 'cc_sessions') {
  const dir = path.join(stateDir, subdir);
  let files;
  try { files = await fs.readdir(dir); } catch { return []; }
  const now = Math.floor(Date.now() / 1000);
  const list = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(dir, f);
    let obj;
    try { obj = JSON.parse(await fs.readFile(full, 'utf8')); } catch { continue; }
    const ts = Number(obj.ts) || 0;
    const age = now - ts;
    if (age > SESSION_REAP_SEC) { fs.unlink(full).catch(() => {}); continue; }
    list.push({
      id: f.replace(/\.json$/, ''),
      state: String(obj.state || ''),
      cwd: String(obj.cwd || ''),
      label: String(obj.label || ''),
      ageSec: age,
      stale: age > SESSION_FRESH_SEC,
    });
  }
  list.sort((a, b) => a.ageSec - b.ageSec); // newest (smallest age) first
  return list;
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

export async function readClaudeSessions(stateDir) {
  const out = { working: 0, waiting: 0, total: 0, waitingLabel: '', workingLabel: '' };
  const dir = path.join(stateDir, 'cc_sessions');
  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return out; // no sessions yet
  }
  const now = Math.floor(Date.now() / 1000);
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(dir, f);
    let obj;
    try {
      obj = JSON.parse(await fs.readFile(full, 'utf8'));
    } catch {
      continue; // partial/locked file — skip this cycle
    }
    const ts = Number(obj.ts) || 0;
    const age = now - ts;
    if (age > SESSION_REAP_SEC) { fs.unlink(full).catch(() => {}); continue; }
    out.total++;
    if (age > SESSION_FRESH_SEC) continue; // stale: treat as idle, don't count busy
    if (obj.state === 'working') { out.working++; out.workingLabel = obj.label || ''; }
    else if (obj.state === 'waiting') { out.waiting++; out.waitingLabel = obj.label || ''; }
  }
  return out;
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
