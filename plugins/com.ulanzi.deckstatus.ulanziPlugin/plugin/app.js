// app.js — Deck Status main service.
//
// Five keypad actions:
//   Cursor            — cycle hook sessions (running time + state)
//   Commander Sprint  — running sprint done/total; tap cycles projects
//   Claude (cycle)    — cycle Claude sessions (idle skipped)
//   Antigravity       — latest git commit age for a project path
//   GitHub API Usage  — gh rate-limit gauge
//
// Each active key polls on its own interval. Reads are best-effort — missing
// data renders a dim neutral tile, never crashes.

import UlanziApi from './plugin-common-node/index.js';
import {
  resolveStateDir, readProjectCommit,
  readProjectConfig, writeProjectConfig, DEFAULT_PROJECT,
  readSessionList,
  readActiveSessionList, sessionDurationText,
  sessionRole, sessionDisplayProject,
  readCommanderApi, readCommanderKeyEntry, writeCommanderKey, writeCommanderProjectRepo,
  readRunningSprints, readGithubRate, readCursorAiActivity,
} from './state-reader.js';
import { render as renderStyle, renderMissing, renderTile, renderNeutral } from './render.js';
import { appendFileSync, watch, existsSync } from 'fs';
import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { expandPath } from './state-reader.js';

const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.deckstatus';
const ACTION_ANTIGRAVITY = 'com.ulanzi.ulanzistudio.deckstatus.antigravity';
const PULSE_MS = 700; // running-state glyph pulse cadence
const ACTION_CLAUDECYCLE = 'com.ulanzi.ulanzistudio.deckstatus.claudecycle';
const ACTION_SPRINT = 'com.ulanzi.ulanzistudio.deckstatus.sprint';
const ACTION_GHRATE = 'com.ulanzi.ulanzistudio.deckstatus.ghrate';
const ACTION_CURSORCYCLE = 'com.ulanzi.ulanzistudio.deckstatus.cursorcycle';

const COMMIT_POLL_MS = 30000;   // git age only needs ~minute resolution
const SESSION_POLL_MS = 1500;   // Claude/Cursor hook sessions
const COMMANDER_POLL_MS = 4000; // dashboard API; don't hammer it
const GHRATE_POLL_MS = 60000;   // rate limit is a slow gauge (hourly window)

const CURSOR_ACTIONS = new Set([ACTION_CURSORCYCLE]);
const SPRINT_GLYPHS = ['rocket', 'sparkles', 'calendar', 'code', 'activity', 'clock', 'git-branch'];

const $UD = new UlanziApi();
const INSTANCES = new Map(); // context -> instance

// Disk log: the host swallows stdout, so write our own breadcrumb file we can read.
const DEBUG_LOG = path.join(os.homedir(), 'dev/deck/scripts/deck_state', '_deckstatus.log');
function dbg(msg) {
  try { appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`); } catch {}
}

function log(msg, level = 'info') {
  try { $UD.logMessage(`[deckstatus] ${msg}`, level); } catch {}
  console.log('[deckstatus]', msg);
  dbg(msg);
}

function settingsOf(msg) {
  return (msg && (msg.param || msg.settings)) || {};
}

function actionTypeOf(context) {
  return (($UD.decodeContext(context) || {}).uuid) || '';
}

// Commit age -> a color that fades over the first 30 minutes:
//   0-5m green -> 5-10m green-yellow -> 10-20m yellow -> 20-30m yellow-grey -> grey.
const COLOR_STOPS = [
  [0,  [0x3e, 0xcf, 0x6b]], // green
  [5,  [0xa6, 0xd2, 0x4b]], // green-yellow
  [10, [0xe3, 0xb3, 0x41]], // yellow
  [20, [0xe3, 0xb3, 0x41]], // yellow (hold)
  [30, [0x5a, 0x5a, 0x62]], // grey
];
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function toHex(c) { return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join(''); }
function ageColor(sec) {
  const m = sec / 60;
  if (m <= COLOR_STOPS[0][0]) return toHex(COLOR_STOPS[0][1]);
  for (let i = 1; i < COLOR_STOPS.length; i++) {
    const [m1, c1] = COLOR_STOPS[i];
    if (m <= m1) {
      const [m0, c0] = COLOR_STOPS[i - 1];
      const t = (m - m0) / (m1 - m0);
      return toHex([0, 1, 2].map((k) => lerp(c0[k], c1[k], t)));
    }
  }
  return toHex(COLOR_STOPS[COLOR_STOPS.length - 1][1]); // > 30m -> grey
}

function pulseValue(inst) {
  return (Math.sin((inst.pulsePhase || 0) * 0.9) + 1) / 2;
}

function sprintGlyphForSlug(slug) {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (Math.imul(31, h) + slug.charCodeAt(i)) >>> 0;
  return SPRINT_GLYPHS[h % SPRINT_GLYPHS.length];
}

function sprintAccent(s) {
  if (s.state === 'completed') return 'green';
  if (s.state === 'working') return 'teal';
  return 'grey';
}

function managePulse(inst, on) {
  if (on) {
    if (!inst.pulseTimer) {
      inst.pulseTimer = setInterval(() => {
        inst.pulsePhase = (inst.pulsePhase || 0) + 1;
        inst.lastIcon = '';
        renderInstance(inst);
      }, PULSE_MS);
    }
  } else if (inst.pulseTimer) {
    clearInterval(inst.pulseTimer);
    inst.pulseTimer = null;
  }
}

// --- Antigravity: render via the styled "timestat" tile (prefilled, no config)
function commitIcon(read) {
  if (!read || read.missing) return renderMissing('no repo');
  // accent fades by age (ageColor hex); big age value middle, hash title on top.
  return renderStyle('timestat', {
    accent: ageColor(read.ageSec),
    glyph: 'git-branch',
    value: read.ageText,
    label: read.hash,
  });
}

// Resolve the project: PI setting -> config file -> built-in default.
// The tile always has a project, so it shows the latest commit out of the box.
async function resolveProject(inst) {
  if (inst.projectPath) return inst.projectPath;
  const fromFile = await readProjectConfig(inst.stateDir);
  if (fromFile) return fromFile;
  return DEFAULT_PROJECT;
}

// --- Claude Code session helpers ---------------------------------------------
// Map a session -> agent-style fields: { accent, state(for glyph), word }.
function agentFor(sess) {
  if (!sess || sess.stale) return { accent: 'grey', state: 'idle', word: 'idle' };
  if (sess.state === 'working') return { accent: 'blue', state: 'running', word: 'working' };
  if (sess.state === 'waiting') return { accent: 'amber', state: undefined, word: 'needs you' };
  if (sess.state === 'done') return { accent: 'green', state: 'done', word: 'ready' };
  if (sess.state === 'idle' && sess.live) return { accent: 'blue', state: 'running', word: 'live' };
  if (sess.state === 'idle') return { accent: 'grey', state: 'idle', word: 'idle' };
  return { accent: 'grey', state: 'idle', word: 'idle' };
}

// Slope-safe session tile: accent bar + duration (big) + status (top).
// Host text overlay: line 1 = project (or "-"), line 2 = role.
// Logo top-right — same position as agent/gauge tiles (renderAgent).
function renderSessionTile(sess, { idx = 0, total = 1, glyph = null, pulse = 1 } = {}) {
  const A = agentFor(sess);
  const pos = total > 1 ? ` ${idx + 1}/${total}` : '';
  const project = sessionDisplayProject(sess);
  const role = sessionRole(sess);
  const dur = sessionDurationText(sess);
  const top = `${A.word}${pos}`;
  const text = `${project}\n${role}`;
  return {
    icon: renderTile({
      value: dur, color: A.accent, label: top, glyph, state: A.state, pulse,
    }),
    text,
  };
}

function renderSprintTile(s, { idx = 0, total = 1, glyph = null, pulse = 1 } = {}) {
  const pos = total > 1 ? ` ${idx + 1}/${total}` : '';
  const top = s.sprint ? `S${s.sprint} · ${s.state}${pos}` : `${s.state}${pos}`;
  const value = s.total > 0 ? `${s.done}/${s.total}` : '—';
  const runState = s.state === 'working' ? 'running' : s.state === 'completed' ? 'done' : 'idle';
  return {
    icon: renderTile({
      value,
      color: sprintAccent(s),
      label: top,
      glyph,
      state: runState,
      pulse,
    }),
    text: `${s.slug}\nrunning ${s.runningTime || '0'}`,
  };
}

function tileMissing(label) {
  const t = String(label || '—');
  return { icon: renderNeutral({ value: '—', label: t }), text: t };
}

// One entry per cwd — drops duplicate zombie session files from the cycle list.
function dedupeByCwd(list) {
  const by = new Map();
  for (const s of list) {
    const k = s.cwd || s.label || s.id;
    const prev = by.get(k);
    if (!prev || s.ageSec < prev.ageSec) by.set(k, s);
  }
  return [...by.values()];
}

// Cycling tile: one key scans active sessions in a subdir; tap advances.
async function sessionCycleIcon(inst, subdir, emptyLabel, { skipIdle = false, glyph = null } = {}) {
  const { list: raw, anyFiles } = await readActiveSessionList(inst.stateDir, subdir);
  let list = dedupeByCwd(raw);
  if (skipIdle) list = list.filter((s) => s.state !== 'idle');
  inst.cycleList = list; // for onRun bounds
  if (!list.length) return tileMissing(anyFiles ? 'no active' : emptyLabel);
  const idx = ((inst.cycleIdx || 0) % list.length + list.length) % list.length;
  const sess = list[idx];
  const A = agentFor(sess);
  managePulse(inst, A.state === 'running');
  dbg(`render cycle ${subdir} ctx=${inst.context} idx=${idx}/${list.length} label=${sess.label} ${A.word} dur=${sessionDurationText(sess)}`);
  return renderSessionTile(sess, { idx, total: list.length, glyph, pulse: pulseValue(inst) });
}

// --- Cursor: unified tile (hook sessions + AI snippet fallback) --------------
function rankSession(s) {
  if (s.stale) return 0;
  if (s.state === 'working') return 4;
  if (s.state === 'waiting') return 3;
  if (s.state === 'done') return 2;
  return 1;
}

async function cursorIcon(inst) {
  const list = await readSessionList(inst.stateDir, 'cursor_sessions');
  const active = list.filter((s) => !s.stale);
  const sorted = dedupeByCwd([...(active.length ? active : list)]).sort(
    (a, b) => rankSession(b) - rankSession(a) || a.ageSec - b.ageSec,
  );
  inst.cycleList = sorted;

  if (sorted.length) {
    const idx = ((inst.cycleIdx || 0) % sorted.length + sorted.length) % sorted.length;
    const sess = sorted[idx];
    const A = agentFor(sess);
    managePulse(inst, A.state === 'running');
    dbg(`render cursor ctx=${inst.context} idx=${idx}/${sorted.length} label=${sess.label} ${A.word}`);
    return renderSessionTile(sess, {
      idx, total: sorted.length, glyph: 'brand-cursor', pulse: pulseValue(inst),
    });
  }

  managePulse(inst, false);
  const a = await readCursorAiActivity();
  if (a.offline) return renderMissing('cursor?');
  const gen = a.recent > 0;
  managePulse(inst, gen);
  dbg(`render cursor idle today=${a.today} recent=${a.recent}`);
  return renderStyle('agent', {
    accent: gen ? 'teal' : 'grey', glyph: 'brand-cursor', value: String(a.today),
    label: gen ? `+${a.recent} now` : 'today', state: gen ? 'running' : 'idle',
    pulse: pulseValue(inst),
  });
}

// Per-key dashboard URL: PI setting -> commander_keys.json[keyId] ->
// global commander_api.txt -> default. So one key can watch a remote machine.
async function resolveCommanderBase(inst) {
  if (inst.apiBase) return inst.apiBase;
  const entry = await readCommanderKeyEntry(inst.stateDir, inst.keyId);
  if (entry.apiBase) return entry.apiBase;
  return readCommanderApi(inst.stateDir);
}

function defaultSprintIdx(sprints, persistedRepo) {
  if (persistedRepo) {
    const i = sprints.findIndex((s) => s.repo === persistedRepo);
    if (i >= 0) return i;
  }
  const wi = sprints.findIndex((s) => s.state === 'working');
  return wi >= 0 ? wi : 0;
}

async function initSprintCycleIdx(inst, sprints) {
  if (inst.cycleIdx != null) return;
  const entry = await readCommanderKeyEntry(inst.stateDir, inst.keyId);
  inst.cycleIdx = defaultSprintIdx(sprints, entry.projectRepo);
}

// --- Commander: running sprint cycle (nav-pill API) --------------------------
async function sprintIcon(inst) {
  const base = await resolveCommanderBase(inst);
  const { offline, sprints } = await readRunningSprints(base);
  if (offline) { inst.cycleList = []; return tileMissing('offline'); }

  inst.cycleList = sprints;
  if (!sprints.length) {
    managePulse(inst, false);
    dbg(`render sprint ctx=${inst.context} no running sprints`);
    return tileMissing('no sprint');
  }

  await initSprintCycleIdx(inst, sprints);
  const n = sprints.length;
  const idx = ((inst.cycleIdx || 0) % n + n) % n;
  inst.cycleIdx = idx;
  const s = sprints[idx];
  const glyph = sprintGlyphForSlug(s.slug);
  managePulse(inst, s.state === 'working');
  dbg(`render sprint ctx=${inst.context} idx=${idx}/${n} ${s.slug} S${s.sprint} ${s.done}/${s.total}`);
  return renderSprintTile(s, { idx, total: n, glyph, pulse: pulseValue(inst) });
}

// --- GitHub: REST API rate-limit usage % -------------------------------------
async function ghRateIcon() {
  const r = await readGithubRate();
  if (r.offline) return renderMissing('gh?');
  const color = r.pct >= 85 ? 'red' : r.pct >= 60 ? 'amber' : 'green';
  dbg(`render ghrate ${r.used}/${r.limit} ${r.pct}% reset=${r.resetMins}m`);
  return renderStyle('gauge', {
    glyph: 'brand-github',
    accent: color,
    value: r.pct,
    color,
    label: `rst ${r.resetMins}m`,
    emphasis: true,
  });
}

async function computeIcon(inst) {
  if (inst.type === ACTION_GHRATE) return ghRateIcon();
  if (CURSOR_ACTIONS.has(inst.type)) return cursorIcon(inst);
  if (inst.type === ACTION_SPRINT) return sprintIcon(inst);
  if (inst.type === ACTION_CLAUDECYCLE) {
    return sessionCycleIcon(inst, 'cc_sessions', 'no claude', { skipIdle: true, glyph: 'brand-claude' });
  }
  if (inst.type === ACTION_ANTIGRAVITY) {
    inst.resolvedProject = await resolveProject(inst);
    inst.lastRead = await readProjectCommit(inst.resolvedProject);
    dbg(`render antigravity ctx=${inst.context} project="${inst.resolvedProject}" read=${JSON.stringify(inst.lastRead)}`);
    return commitIcon(inst.lastRead);
  }
  log(`unknown action type ${inst.type}`, 'warn');
  return renderMissing('?');
}

async function renderInstance(inst) {
  if (inst.inflight) return; // debounce: skip if a read is already running
  inst.inflight = true;
  try {
    const out = await computeIcon(inst);
    const icon = out && typeof out === 'object' && out.icon ? out.icon : out;
    const text = out && typeof out === 'object' && out.text ? out.text : '';
    const key = text ? `${icon}|${text}` : icon;
    if (key !== inst.lastIcon) {
      inst.lastIcon = key;
      $UD.setBaseDataIcon(inst.context, icon, text);
      dbg(`push ctx=${inst.context} text="${String(text).replace(/\n/g, ' / ')}"`);
    }
  } catch (e) {
    log(`render error for ${inst.context}: ${e?.message || e}`, 'error');
  } finally {
    inst.inflight = false;
  }
  ensureGitWatch(inst);
  ensureCursorWatch(inst);
  ensureClaudeWatch(inst);
}

// Watch the repo's reflog so a new commit forces an immediate hard refresh —
// an immediate hard refresh — top priority, no waiting for the 30s poll.
function ensureGitWatch(inst) {
  if (inst.type !== ACTION_ANTIGRAVITY || !inst.resolvedProject) return;
  if (inst.watchProject === inst.resolvedProject && inst.watcher) return; // already armed
  closeWatch(inst);
  const base = path.join(expandPath(inst.resolvedProject), '.git');
  const target = existsSync(path.join(base, 'logs', 'HEAD'))
    ? path.join(base, 'logs', 'HEAD')   // reflog: appended on every commit
    : path.join(base, 'HEAD');          // fallback
  try {
    inst.watcher = watch(target, () => {
      if (inst.watchDebounce) clearTimeout(inst.watchDebounce);
      inst.watchDebounce = setTimeout(() => {
        log(`commit detected (${inst.resolvedProject}) -> hard refresh`);
        inst.lastIcon = '';            // force repaint
        renderInstance(inst);
      }, 300);
    });
    inst.watchProject = inst.resolvedProject;
    dbg(`watching ${target}`);
  } catch (e) {
    dbg(`watch failed for ${target}: ${e.message}`); // poll still covers it
  }
}

function closeWatch(inst) {
  if (inst.watcher) { try { inst.watcher.close(); } catch {} inst.watcher = null; }
  if (inst.watchDebounce) { clearTimeout(inst.watchDebounce); inst.watchDebounce = null; }
  inst.watchProject = '';
}

function ensureCursorWatch(inst) {
  if (!CURSOR_ACTIONS.has(inst.type) || !inst.stateDir) return;
  const dir = path.join(inst.stateDir, 'cursor_sessions');
  if (inst.watchCursorDir === dir && inst.cursorWatcher) return;
  closeCursorWatch(inst);
  if (!existsSync(dir)) return;
  try {
    inst.cursorWatcher = watch(dir, () => {
      if (inst.cursorWatchDebounce) clearTimeout(inst.cursorWatchDebounce);
      inst.cursorWatchDebounce = setTimeout(() => {
        inst.lastIcon = '';
        renderInstance(inst);
      }, 300);
    });
    inst.watchCursorDir = dir;
    dbg(`watching ${dir}`);
  } catch (e) {
    dbg(`cursor watch failed for ${dir}: ${e.message}`);
  }
}

function closeCursorWatch(inst) {
  if (inst.cursorWatcher) { try { inst.cursorWatcher.close(); } catch {} inst.cursorWatcher = null; }
  if (inst.cursorWatchDebounce) { clearTimeout(inst.cursorWatchDebounce); inst.cursorWatchDebounce = null; }
  inst.watchCursorDir = '';
}

function ensureClaudeWatch(inst) {
  if (inst.type !== ACTION_CLAUDECYCLE || !inst.stateDir) return;
  const dir = path.join(inst.stateDir, 'cc_sessions');
  if (inst.watchClaudeDir === dir && inst.claudeWatcher) return;
  closeClaudeWatch(inst);
  if (!existsSync(dir)) return;
  try {
    inst.claudeWatcher = watch(dir, () => {
      if (inst.claudeWatchDebounce) clearTimeout(inst.claudeWatchDebounce);
      inst.claudeWatchDebounce = setTimeout(() => {
        inst.lastIcon = '';
        renderInstance(inst);
      }, 300);
    });
    inst.watchClaudeDir = dir;
    dbg(`watching ${dir}`);
  } catch (e) {
    dbg(`claude watch failed for ${dir}: ${e.message}`);
  }
}

function closeClaudeWatch(inst) {
  if (inst.claudeWatcher) { try { inst.claudeWatcher.close(); } catch {} inst.claudeWatcher = null; }
  if (inst.claudeWatchDebounce) { clearTimeout(inst.claudeWatchDebounce); inst.claudeWatchDebounce = null; }
  inst.watchClaudeDir = '';
}

function startPolling(inst) {
  stopPolling(inst);
  inst.timer = setInterval(() => { renderInstance(inst); }, inst.intervalMs);
  renderInstance(inst); // immediate first paint (also arms the git watcher)
}
function stopPolling(inst) {
  closeWatch(inst);
  closeCursorWatch(inst);
  closeClaudeWatch(inst);
  if (inst.pulseTimer) { clearInterval(inst.pulseTimer); inst.pulseTimer = null; }
  if (inst.timer) { clearInterval(inst.timer); inst.timer = null; }
}

// Merge-aware: only overwrite a field when the incoming settings object actually
// carries that key, so an empty onAdd delivery can't wipe a path we already have.
function applySettings(inst, settings) {
  settings = settings || {};
  if (inst.type === ACTION_GHRATE) {
    inst.intervalMs = GHRATE_POLL_MS; // zero-config; gh handles auth
    return;
  }
  if (inst.type === ACTION_SPRINT) {
    inst.intervalMs = COMMANDER_POLL_MS;
    inst.stateDir = resolveStateDir(settings);
    inst.keyId = ($UD.decodeContext(inst.context) || {}).key || '?';
    if ('apiBase' in settings) {
      inst.apiBase = String(settings.apiBase || '').trim();
      if (inst.apiBase) {
        writeCommanderKey(inst.stateDir, inst.keyId, inst.apiBase)
          .then((ok) => dbg(`persisted key ${inst.keyId} -> ${inst.apiBase} (${ok})`));
      }
    }
    return;
  }
  if (inst.type === ACTION_CLAUDECYCLE || CURSOR_ACTIONS.has(inst.type)) {
    inst.intervalMs = SESSION_POLL_MS;
    inst.stateDir = resolveStateDir(settings);
    inst.keyId = ($UD.decodeContext(inst.context) || {}).key || '?';
    return;
  }
  if (inst.type === ACTION_ANTIGRAVITY) {
    inst.intervalMs = COMMIT_POLL_MS;
    if (!inst.stateDir) inst.stateDir = resolveStateDir(settings);
    if ('projectPath' in settings) {
      inst.projectPath = String(settings.projectPath || '').trim();
      if (inst.projectPath) {
        writeProjectConfig(inst.stateDir, inst.projectPath)
          .then((ok) => dbg(`persisted projectPath="${inst.projectPath}" -> ${ok}`));
      }
    }
  }
}

// Key that detects a rebind (changed binding => force repaint).
function bindKey(inst) {
  if (inst.type === ACTION_ANTIGRAVITY) return inst.projectPath || '';
  if (inst.type === ACTION_SPRINT) return `${inst.stateDir}|${inst.apiBase || ''}|sprint`;
  return `${inst.type}|${inst.stateDir || ''}`;
}

function ensureInstance(context, settings) {
  let inst = INSTANCES.get(context);
  if (!inst) {
    inst = {
      context, type: actionTypeOf(context),
      stateDir: '', projectPath: '', intervalMs: SESSION_POLL_MS,
      timer: null, inflight: false, lastIcon: '', lastRead: null, active: true,
    };
    applySettings(inst, settings);
    INSTANCES.set(context, inst);
    log(`add ${context} type=${inst.type} bind="${bindKey(inst)}"`);
    startPolling(inst);
  } else {
    const prev = bindKey(inst);
    applySettings(inst, settings);
    if (bindKey(inst) !== prev) {
      inst.lastIcon = ''; // force repaint on rebind
      renderInstance(inst);
    }
  }
  return inst;
}

$UD.connect(PLUGIN_UUID);

$UD.onConnected(() => log('connected'));
$UD.onError((e) => log(`socket error: ${e?.message || e}`, 'error'));
$UD.onClose(() => log('socket closed', 'warn'));

$UD.onAdd((msg) => {
  dbg(`onAdd ctx=${msg.context} param=${JSON.stringify(msg.param)}`);
  ensureInstance(msg.context, settingsOf(msg));
  // Also pull from the settings store, in case the param channel was empty.
  try { $UD.getSettings(msg.context); } catch {}
});
$UD.onParamFromApp((msg) => {
  dbg(`onParamFromApp ctx=${msg.context} param=${JSON.stringify(msg.param)}`);
  ensureInstance(msg.context, settingsOf(msg));
});
$UD.onParamFromPlugin((msg) => {
  dbg(`onParamFromPlugin ctx=${msg.context} param=${JSON.stringify(msg.param)}`);
  ensureInstance(msg.context, settingsOf(msg));
});
$UD.onDidReceiveSettings((msg) => {
  dbg(`onDidReceiveSettings ctx=${msg.context} settings=${JSON.stringify(msg.settings)}`);
  ensureInstance(msg.context, msg.settings || {});
});

// Tap: cycle lists, open Antigravity, or refresh.
$UD.onRun(async (msg) => {
  const inst = INSTANCES.get(msg.context) || ensureInstance(msg.context, settingsOf(msg));
  if (inst.type === ACTION_SPRINT) {
    const n = (inst.cycleList || []).length || 1;
    inst.cycleIdx = ((inst.cycleIdx || 0) + 1) % n;
    const repo = (inst.cycleList || [])[inst.cycleIdx]?.repo;
    if (repo) {
      writeCommanderProjectRepo(inst.stateDir, inst.keyId, repo)
        .then((ok) => dbg(`persisted project ${inst.keyId} -> ${repo} (${ok})`));
    }
    log(`tap sprint -> idx ${inst.cycleIdx}/${n} ${repo || '?'}`);
  } else if (inst.type === ACTION_CLAUDECYCLE || CURSOR_ACTIONS.has(inst.type)) {
    const n = (inst.cycleList || []).length || 1;
    inst.cycleIdx = ((inst.cycleIdx || 0) + 1) % n;
    log(`tap cycle -> idx ${inst.cycleIdx}/${n}`);
  } else if (inst.type === ACTION_ANTIGRAVITY) {
    log(`tap -> open Antigravity IDE (project=${inst.resolvedProject || '?'})`);
    // Antigravity IDE bundle id; fall back to the app name if the id ever changes.
    execFile('open', ['-b', 'com.google.antigravity-ide'], (err) => {
      if (err) {
        dbg(`open by bundle id failed (${err.message}); trying app name`);
        execFile('open', ['-a', 'Antigravity IDE'], (e2) => { if (e2) dbg(`open Antigravity IDE failed: ${e2.message}`); });
      }
    });
  } else {
    log(`tap refresh ${msg.context}`);
  }
  inst.lastIcon = ''; // force repaint
  renderInstance(inst);
});

$UD.onSetActive((msg) => {
  const inst = INSTANCES.get(msg.context);
  if (!inst) return;
  inst.active = !!msg.active;
  if (inst.active) {
    if (!inst.timer) startPolling(inst);
  } else {
    stopPolling(inst); // settings/context only valid while active — stop work
  }
});

$UD.onClear((msg) => {
  if (!msg.param) return;
  for (const item of msg.param) {
    const inst = INSTANCES.get(item.context);
    if (inst) {
      stopPolling(inst);
      INSTANCES.delete(item.context);
      log(`clear ${item.context}`);
    }
  }
});
