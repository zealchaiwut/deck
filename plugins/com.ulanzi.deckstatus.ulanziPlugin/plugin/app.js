// app.js — Deck Status main service.
//
// Two actions, both Keypad:
//   "Status Tile" — bind a key to a deck_state file (tile name or relative path)
//                   and show its live value/color. Tap a *count.txt to reset it.
//   "Antigravity" — bind a key to a project path; show that git repo's latest
//                   commit short hash + how long since it. Tap to refresh.
//
// Each active key gets its own poll loop. Reads are best-effort: a missing file,
// non-repo path, or partial read just renders a dim neutral tile, never crashes.

import UlanziApi from './plugin-common-node/index.js';
import {
  readSource, resetCounter, resolveStateDir, readProjectCommit,
  readProjectConfig, writeProjectConfig, DEFAULT_PROJECT,
  readClaudeSessionList, readSessionList, readKeyMap,
  readCommanderApi, readCommanderKeyEntry, writeCommanderKey, writeCommanderProjectRepo,
  readCommanderProjects, readSprintProgress, readCommanderAgents, readGithubRate, readCursorAiActivity,
} from './state-reader.js';
import { render as renderStyle, renderMissing } from './render.js';
import { appendFileSync, watch, existsSync } from 'fs';
import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { expandPath } from './state-reader.js';

const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.deckstatus';
const ACTION_STATUSTILE = 'com.ulanzi.ulanzistudio.deckstatus.statustile';
const ACTION_ANTIGRAVITY = 'com.ulanzi.ulanzistudio.deckstatus.antigravity';
const PULSE_MS = 700; // running-state glyph pulse cadence
const ACTION_CLAUDECODE = 'com.ulanzi.ulanzistudio.deckstatus.claudecode';
const ACTION_CLAUDECYCLE = 'com.ulanzi.ulanzistudio.deckstatus.claudecycle';
const ACTION_SPRINT = 'com.ulanzi.ulanzistudio.deckstatus.sprint';
const ACTION_CMDAGENTS = 'com.ulanzi.ulanzistudio.deckstatus.cmdagents';
const ACTION_GHRATE = 'com.ulanzi.ulanzistudio.deckstatus.ghrate';
const ACTION_CURSORCYCLE = 'com.ulanzi.ulanzistudio.deckstatus.cursorcycle';
const ACTION_CURSORAI = 'com.ulanzi.ulanzistudio.deckstatus.cursorai';

const FILE_POLL_MS = 2000;      // deck_state files change often
const COMMIT_POLL_MS = 30000;   // git age only needs ~minute resolution
const SESSION_POLL_MS = 1500;   // Claude Code status should feel responsive
const COMMANDER_POLL_MS = 4000; // dashboard API; don't hammer it
const GHRATE_POLL_MS = 60000;   // rate limit is a slow gauge (hourly window)

const COMMANDER_ACTIONS = new Set([ACTION_SPRINT, ACTION_CMDAGENTS]);
const CURSOR_ACTIONS = new Set([ACTION_CURSORCYCLE, ACTION_CURSORAI]);

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

// --- Status Tile: rich style-based render (agent|gauge|ring|timestat|repo) ----
// Merges PI settings (style/accent/glyph/label/is_counter) with live file data
// (value/color/state/label/count). pulse alpha animates "running" glyphs.
async function statusTileIcon(inst) {
  const read = await readSource(inst.stateDir, inst.source);
  inst.lastRead = read;
  // running styles pulse; (de)arm the 700ms redraw timer accordingly.
  const isRunning = !read.missing && read.state === 'running';
  managePulse(inst, isRunning && (inst.style === 'agent' || inst.style === 'timestat'));

  if (read.missing) return renderMissing(inst.label);

  // count "1/2" -> done/total for the ring style.
  const count = read.count || (inst.isCounter ? read.value : '');
  let done, total;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(count));
  if (m) { done = +m[1]; total = +m[2]; }

  const pulse = (Math.sin((inst.pulsePhase || 0) * 0.9) + 1) / 2; // 0..1
  const data = {
    accent: read.accent || inst.accent || 'grey',
    glyph: inst.glyph,
    label: read.label || inst.label,
    state: read.state,
    count,
    done, total,
    value: read.value,
    color: read.color, // gauge threshold override
    pulse,
  };
  return renderStyle(inst.style || 'agent', data);
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
// Effective state of a session -> { color, word }. Stale sessions read as idle.
function sessionLook(sess) {
  if (!sess) return { color: 'grey', word: 'none' };
  if (sess.stale) return { color: 'grey', word: 'idle' };
  if (sess.state === 'working') return { color: 'blue', word: 'working' };
  if (sess.state === 'waiting') return { color: 'amber', word: 'needs you' };
  if (sess.state === 'done') return { color: 'green', word: 'ready' }; // done = pending next task
  return { color: 'grey', word: 'idle' };
}

// Map a session -> agent-style fields: { accent, state(for glyph), word }.
function agentFor(sess) {
  if (!sess || sess.stale) return { accent: 'grey', state: 'idle', word: 'idle' };
  if (sess.state === 'working') return { accent: 'blue', state: 'running', word: 'working' };
  if (sess.state === 'waiting') return { accent: 'amber', state: undefined, word: 'needs you' };
  if (sess.state === 'done') return { accent: 'green', state: 'done', word: 'ready' };
  return { accent: 'grey', state: 'idle', word: 'idle' };
}

function matchesFilter(sess, filter) {
  const f = filter.toLowerCase();
  return sess.label.toLowerCase().includes(f) || sess.cwd.toLowerCase().includes(f);
}

// Among matches, surface the most "active" one: working > waiting > done > idle.
function pickSession(list, filter) {
  const m = list.filter((s) => matchesFilter(s, filter));
  if (!m.length) return null;
  const rank = (s) => (s.stale ? 0 : s.state === 'working' ? 3 : s.state === 'waiting' ? 2 : s.state === 'done' ? 1 : 0);
  return m.sort((a, b) => rank(b) - rank(a))[0];
}

// Per-key mapped tile: one deck key dedicated to one session/project.
async function claudeMappedIcon(inst) {
  const list = await readClaudeSessionList(inst.stateDir);
  const keyMap = await readKeyMap(inst.stateDir);
  const filter = (keyMap[inst.keyId] || inst.filter || '').trim();
  dbg(`render claudecode ctx=${inst.context} key=${inst.keyId} filter="${filter}" sessions=${list.length}`);
  if (!filter) {
    // Unmapped: show this key's id so you can add it to cc_keys.json.
    return renderMissing(`map ${inst.keyId}`);
  }
  const A = agentFor(pickSession(list, filter));
  return renderStyle('agent', { accent: A.accent, glyph: 'sparkles', value: filter, label: A.word, state: A.state });
}

// Cycling tile: one key scans all sessions in a subdir; tap advances. Zero config.
// Shared by Claude (cc_sessions) and Cursor (cursor_sessions).
async function sessionCycleIcon(inst, subdir, emptyLabel) {
  const list = await readSessionList(inst.stateDir, subdir);
  inst.cycleList = list; // for onRun bounds
  if (!list.length) return renderMissing(emptyLabel);
  const idx = ((inst.cycleIdx || 0) % list.length + list.length) % list.length;
  const sess = list[idx];
  const A = agentFor(sess);
  dbg(`render cycle ${subdir} ctx=${inst.context} idx=${idx}/${list.length} label=${sess.label} ${A.word}`);
  // Status is carried by the background colour (grey idle / blue working /
  // green ready / amber needs-you); the session name is the centered text.
  return renderStyle('agent', { bg: A.accent, value: sess.label, state: A.state });
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
  const sorted = [...(active.length ? active : list)].sort(
    (a, b) => rankSession(b) - rankSession(a) || a.ageSec - b.ageSec,
  );
  inst.cycleList = sorted;

  if (sorted.length) {
    const idx = ((inst.cycleIdx || 0) % sorted.length + sorted.length) % sorted.length;
    const sess = sorted[idx];
    const A = agentFor(sess);
    managePulse(inst, A.state === 'running');
    dbg(`render cursor ctx=${inst.context} idx=${idx}/${sorted.length} label=${sess.label} ${A.word}`);
    return renderStyle('agent', {
      bg: A.accent, glyph: 'pointer', value: sess.label, label: A.word, state: A.state,
    });
  }

  managePulse(inst, false);
  const a = await readCursorAiActivity();
  if (a.offline) return renderMissing('cursor?');
  const gen = a.recent > 0;
  managePulse(inst, gen);
  dbg(`render cursor idle today=${a.today} recent=${a.recent}`);
  return renderStyle('agent', {
    accent: gen ? 'teal' : 'grey', glyph: 'pointer', value: String(a.today),
    label: gen ? `+${a.recent} now` : 'today', state: gen ? 'running' : 'idle',
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

function defaultProjectIdx(projects, persistedRepo) {
  if (persistedRepo) {
    const i = projects.findIndex((p) => p.repo === persistedRepo);
    if (i >= 0) return i;
  }
  const ri = projects.findIndex((p) => p.status === 'running');
  return ri >= 0 ? ri : 0;
}

async function initSprintProjectIdx(inst, projects) {
  if (inst.cycleIdx != null) return;
  const entry = await readCommanderKeyEntry(inst.stateDir, inst.keyId);
  inst.cycleIdx = defaultProjectIdx(projects, entry.projectRepo);
}

// --- Commander: sprint progress (nav-pill API, per-project) ------------------
async function sprintIcon(inst) {
  const base = await resolveCommanderBase(inst);
  const home = await readCommanderProjects(base);
  if (home.offline) { inst.cycleList = []; return renderMissing('offline'); }
  if (!home.projects.length) { inst.cycleList = []; return renderMissing('no projects'); }

  inst.cycleList = home.projects;
  await initSprintProjectIdx(inst, home.projects);
  const n = home.projects.length;
  const idx = ((inst.cycleIdx || 0) % n + n) % n;
  inst.cycleIdx = idx;
  const proj = home.projects[idx];
  const pos = n > 1 ? ` ${idx + 1}/${n}` : '';

  const prog = await readSprintProgress(base, proj.repo);
  if (prog.offline) { inst.cycleList = []; return renderMissing('offline'); }
  if (!prog.hasSprint) {
    dbg(`render sprint ctx=${inst.context} ${proj.slug} no sprint`);
    return renderStyle('fill', { accent: 'grey', pct: 0, value: '—', label: `${proj.slug}${pos}` });
  }

  const { done, total, sprint, runState } = prog;
  const complete = total > 0 && done >= total;
  const pct = total > 0 ? done / total : 0;
  const accent = complete ? 'green' : runState === 'finished' ? 'green' : 'teal';
  const tileLabel = `${proj.slug} · S${sprint}${pos}`;
  dbg(`render sprint ctx=${inst.context} idx=${idx}/${n} ${proj.slug} S${sprint} ${done}/${total}`);
  return renderStyle('fill', { accent, pct, value: `${done}/${total}`, label: tileLabel });
}

// --- Commander: agents (coder/tester) ----------------------------------------
function agentLook(a) {
  const st = (a.status || '').toLowerCase();
  if (st === 'working') return { accent: 'blue', state: 'running', word: a.lastTool || 'working' };
  if (st.includes('idle') || st.includes('timeout')) return { accent: 'grey', state: 'idle', word: 'idle' };
  return { accent: 'green', state: 'done', word: 'done' };
}

async function cmdAgentsIcon(inst) {
  const base = await resolveCommanderBase(inst);
  const { offline, agents } = await readCommanderAgents(base);
  inst.cycleList = agents; // for onRun bounds
  if (offline) return renderMissing('offline');
  if (!agents.length) return renderMissing('no agents');
  const idx = ((inst.cycleIdx || 0) % agents.length + agents.length) % agents.length;
  const a = agents[idx];
  const look = agentLook(a);
  const pos = agents.length > 1 ? ` ${idx + 1}/${agents.length}` : '';
  dbg(`render cmdagents ctx=${inst.context} idx=${idx}/${agents.length} ${a.role} ${a.issue} ${look.word}`);
  // value = role, title (top) = issue# (or status word) + position. glyph = code.
  return renderStyle('agent', { accent: look.accent, glyph: 'code', value: a.role, label: (a.issue || look.word) + pos, state: look.state });
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
  if (inst.type === ACTION_CMDAGENTS) return cmdAgentsIcon(inst);
  if (inst.type === ACTION_CLAUDECODE) return claudeMappedIcon(inst);
  if (inst.type === ACTION_CLAUDECYCLE) return sessionCycleIcon(inst, 'cc_sessions', 'no claude');
  if (inst.type === ACTION_ANTIGRAVITY) {
    inst.resolvedProject = await resolveProject(inst);
    inst.lastRead = await readProjectCommit(inst.resolvedProject);
    dbg(`render antigravity ctx=${inst.context} project="${inst.resolvedProject}" read=${JSON.stringify(inst.lastRead)}`);
    return commitIcon(inst.lastRead);
  }
  // Status Tile (and any unspecified action) -> rich style renderer.
  return statusTileIcon(inst);
}

async function renderInstance(inst) {
  if (inst.inflight) return; // debounce: skip if a read is already running
  inst.inflight = true;
  try {
    const dataUrl = await computeIcon(inst);
    if (dataUrl !== inst.lastIcon) {
      inst.lastIcon = dataUrl;
      $UD.setBaseDataIcon(inst.context, dataUrl, '');
    }
  } catch (e) {
    log(`render error for ${inst.context}: ${e?.message || e}`, 'error');
  } finally {
    inst.inflight = false;
  }
  ensureGitWatch(inst);
  ensureCursorWatch(inst);
}

// Watch the repo's reflog so a new commit (e.g. from the post-commit hook) forces
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

function startPolling(inst) {
  stopPolling(inst);
  inst.timer = setInterval(() => { renderInstance(inst); }, inst.intervalMs);
  renderInstance(inst); // immediate first paint (also arms the git watcher)
}
function stopPolling(inst) {
  closeWatch(inst);
  closeCursorWatch(inst);
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
  if (COMMANDER_ACTIONS.has(inst.type)) {
    inst.intervalMs = COMMANDER_POLL_MS;
    inst.stateDir = resolveStateDir(settings);
    inst.keyId = ($UD.decodeContext(inst.context) || {}).key || '?';
    // A URL set in the Ulanzi PI persists PER KEY (commander_keys.json), so one
    // key can point at localhost and another at a remote machine.
    if ('apiBase' in settings) {
      inst.apiBase = String(settings.apiBase || '').trim();
      if (inst.apiBase) {
        writeCommanderKey(inst.stateDir, inst.keyId, inst.apiBase)
          .then((ok) => dbg(`persisted key ${inst.keyId} -> ${inst.apiBase} (${ok})`));
      }
    }
    return; // base resolved per render via resolveCommanderBase
  }
  if (inst.type === ACTION_CLAUDECODE || inst.type === ACTION_CLAUDECYCLE || CURSOR_ACTIONS.has(inst.type)) {
    inst.intervalMs = SESSION_POLL_MS;
    inst.stateDir = resolveStateDir(settings);          // where cc_sessions/ / cursor_sessions/ live
    inst.keyId = ($UD.decodeContext(inst.context) || {}).key || '?'; // for cc_keys.json
    if ('filter' in settings) inst.filter = String(settings.filter || '').trim(); // optional PI override
    return;
  }
  if (inst.type === ACTION_ANTIGRAVITY) {
    inst.intervalMs = COMMIT_POLL_MS;
    if (!inst.stateDir) inst.stateDir = resolveStateDir(settings); // for the config file
    if ('projectPath' in settings) {
      inst.projectPath = String(settings.projectPath || '').trim();
      // Funnel a path the PI sent into the config file -> authoritative & persistent.
      if (inst.projectPath) {
        writeProjectConfig(inst.stateDir, inst.projectPath)
          .then((ok) => dbg(`persisted projectPath="${inst.projectPath}" -> ${ok}`));
      }
    }
  } else {
    // Status Tile: source + style archetype + identity fields.
    inst.intervalMs = FILE_POLL_MS;
    if ('source' in settings) inst.source = String(settings.source || '').trim();
    if ('stateDir' in settings || !inst.stateDir) inst.stateDir = resolveStateDir(settings);
    if ('style' in settings) inst.style = String(settings.style || 'agent').trim() || 'agent';
    if (!inst.style) inst.style = 'agent';
    if ('accent' in settings) inst.accent = String(settings.accent || 'grey').trim() || 'grey';
    if ('glyph' in settings) inst.glyph = String(settings.glyph || '').trim();
    if ('label' in settings) inst.label = String(settings.label || '').trim();
    if ('is_counter' in settings) {
      const v = settings.is_counter;
      inst.isCounter = v === true || v === 'true' || v === 'on';
    }
    if ('state_dir' in settings) inst.stateDir = resolveStateDir({ stateDir: settings.state_dir });
  }
}

// Key that detects a rebind (changed binding => force repaint).
function bindKey(inst) {
  return inst.type === ACTION_ANTIGRAVITY ? inst.projectPath : `${inst.stateDir}|${inst.source}`;
}

function ensureInstance(context, settings) {
  let inst = INSTANCES.get(context);
  if (!inst) {
    inst = {
      context, type: actionTypeOf(context),
      source: '', stateDir: '', projectPath: '', intervalMs: FILE_POLL_MS,
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

// Tap behavior:
//   Antigravity   -> launch/focus the Antigravity app, then refresh the commit.
//   Status Tile   -> reset an antigravity-counter file if bound to one, else refresh.
$UD.onRun(async (msg) => {
  const inst = INSTANCES.get(msg.context) || ensureInstance(msg.context, settingsOf(msg));
  if (inst.type === ACTION_SPRINT) {
    const n = (inst.cycleList || []).length || 1;
    inst.cycleIdx = ((inst.cycleIdx || 0) + 1) % n; // advance to next project
    const repo = (inst.cycleList || [])[inst.cycleIdx]?.repo;
    if (repo) {
      writeCommanderProjectRepo(inst.stateDir, inst.keyId, repo)
        .then((ok) => dbg(`persisted project ${inst.keyId} -> ${repo} (${ok})`));
    }
    log(`tap sprint -> project idx ${inst.cycleIdx}/${n} ${repo || '?'}`);
  } else if (inst.type === ACTION_CMDAGENTS) {
    const n = (inst.cycleList || []).length || 1;
    inst.cycleIdx = ((inst.cycleIdx || 0) + 1) % n; // advance to next agent
    log(`tap cmdagents -> idx ${inst.cycleIdx}/${n}`);
  } else if (inst.type === ACTION_CLAUDECYCLE || CURSOR_ACTIONS.has(inst.type)) {
    const n = (inst.cycleList || []).length || 1;
    inst.cycleIdx = ((inst.cycleIdx || 0) + 1) % n; // advance to next session
    log(`tap cycle -> idx ${inst.cycleIdx}/${n}`);
  } else if (inst.type === ACTION_CLAUDECODE) {
    log(`tap claudecode key=${inst.keyId} -> refresh`);
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
    const read = inst.lastRead;
    if (read && read.isCounter && read.counterPath) {
      const ok = await resetCounter(read.counterPath);
      log(`tap reset counter ${read.counterPath} -> ${ok ? 'ok' : 'failed'}`);
    } else {
      log(`tap refresh ${msg.context}`);
    }
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
