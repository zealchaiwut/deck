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
  readClaudeSessionList, readKeyMap,
  readCommanderApi, readCommanderKeyMap, writeCommanderKey,
  readSprintStatus, readCommanderAgents, readGithubRate,
} from './state-reader.js';
import { renderTile, renderNeutral } from './renderer.js';
import { appendFileSync, watch, existsSync } from 'fs';
import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { expandPath } from './state-reader.js';

const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.deckstatus';
const ACTION_ANTIGRAVITY = 'com.ulanzi.ulanzistudio.deckstatus.antigravity';
const ACTION_CLAUDECODE = 'com.ulanzi.ulanzistudio.deckstatus.claudecode';
const ACTION_CLAUDECYCLE = 'com.ulanzi.ulanzistudio.deckstatus.claudecycle';
const ACTION_SPRINT = 'com.ulanzi.ulanzistudio.deckstatus.sprint';
const ACTION_CMDAGENTS = 'com.ulanzi.ulanzistudio.deckstatus.cmdagents';
const ACTION_GHRATE = 'com.ulanzi.ulanzistudio.deckstatus.ghrate';

const FILE_POLL_MS = 2000;      // deck_state files change often
const COMMIT_POLL_MS = 30000;   // git age only needs ~minute resolution
const SESSION_POLL_MS = 1500;   // Claude Code status should feel responsive
const COMMANDER_POLL_MS = 4000; // dashboard API; don't hammer it
const GHRATE_POLL_MS = 60000;   // rate limit is a slow gauge (hourly window)

const COMMANDER_ACTIONS = new Set([ACTION_SPRINT, ACTION_CMDAGENTS]);

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

// --- Status Tile: decide icon from a file read --------------------------------
function fileIcon(read) {
  if (!read || read.missing) return renderNeutral({ value: '—' });
  const value = String(read.value || '').trim();
  if (value === '' || (read.isCounter && /^0+$/.test(value))) {
    return renderNeutral({ value: read.isCounter ? '0' : '—', label: read.label });
  }
  return renderTile({ value, color: read.color, label: read.label });
}

// --- Antigravity: decide icon from a git read ---------------------------------
function commitIcon(read) {
  if (!read || read.missing) return renderNeutral({ value: '—', label: 'no repo' });
  // Big timer (age) on top, commit hash as the small label below.
  return renderTile({ value: read.ageText, color: ageColor(read.ageSec), label: read.hash });
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
    return renderNeutral({ value: 'CC', label: `map ${inst.keyId}` });
  }
  const sess = pickSession(list, filter);
  const look = sessionLook(sess);
  return renderTile({ value: filter, color: look.color, label: look.word });
}

// Cycling tile: one key scans all sessions; tap advances. Zero config.
async function claudeCycleIcon(inst) {
  const list = await readClaudeSessionList(inst.stateDir);
  inst.cycleList = list; // for onRun bounds
  if (!list.length) return renderNeutral({ value: '—', label: 'no claude' });
  const idx = ((inst.cycleIdx || 0) % list.length + list.length) % list.length;
  const sess = list[idx];
  const look = sessionLook(sess);
  const pos = list.length > 1 ? ` ${idx + 1}/${list.length}` : '';
  dbg(`render claudecycle ctx=${inst.context} idx=${idx}/${list.length} label=${sess.label} ${look.word}`);
  return renderTile({ value: sess.label, color: look.color, label: look.word + pos });
}

// Per-key dashboard URL: PI setting -> commander_keys.json[keyId] ->
// global commander_api.txt -> default. So one key can watch a remote machine.
async function resolveCommanderBase(inst) {
  if (inst.apiBase) return inst.apiBase;
  const km = await readCommanderKeyMap(inst.stateDir);
  if (km[inst.keyId]) return km[inst.keyId];
  return readCommanderApi(inst.stateDir);
}

// --- Commander: sprint progress ----------------------------------------------
async function sprintIcon(inst) {
  const base = await resolveCommanderBase(inst);
  const s = await readSprintStatus(base);
  if (s.offline) return renderNeutral({ value: '—', label: 'offline' });
  if (!s.running.length) return renderNeutral({ value: '·', label: 'no sprint' });
  const sp = s.running[0];                 // surface the first running sprint
  const { closed, total, label } = sp;
  const color = total > 0 && closed >= total ? 'green' : total > 0 ? 'blue' : 'grey';
  dbg(`render sprint ctx=${inst.context} ${label} ${closed}/${total} running=${s.running.length}`);
  const suffix = s.running.length > 1 ? ` +${s.running.length - 1}` : '';
  return renderTile({ value: `${closed}/${total}`, color, label: `s${label}${suffix}` });
}

// --- Commander: agents (coder/tester) ----------------------------------------
function agentLook(a) {
  const st = (a.status || '').toLowerCase();
  if (st === 'working') return { color: 'blue', word: a.lastTool || 'working' };
  if (st.includes('idle') || st.includes('timeout')) return { color: 'grey', word: 'idle' };
  return { color: 'green', word: 'done' };
}

async function cmdAgentsIcon(inst) {
  const base = await resolveCommanderBase(inst);
  const { offline, agents } = await readCommanderAgents(base);
  inst.cycleList = agents; // for onRun bounds
  if (offline) return renderNeutral({ value: '—', label: 'offline' });
  if (!agents.length) return renderNeutral({ value: '·', label: 'no agents' });
  const idx = ((inst.cycleIdx || 0) % agents.length + agents.length) % agents.length;
  const a = agents[idx];
  const look = agentLook(a);
  const pos = agents.length > 1 ? ` ${idx + 1}/${agents.length}` : '';
  const name = a.issue ? `${a.role} ${a.issue}` : a.role;
  dbg(`render cmdagents ctx=${inst.context} idx=${idx}/${agents.length} ${name} ${look.word}`);
  return renderTile({ value: a.role, color: look.color, label: (a.issue || look.word) + pos });
}

// --- GitHub: REST API rate-limit usage % -------------------------------------
async function ghRateIcon() {
  const r = await readGithubRate();
  if (r.offline) return renderNeutral({ value: '—', label: 'gh?' });
  const color = r.pct >= 85 ? 'red' : r.pct >= 60 ? 'amber' : 'green';
  dbg(`render ghrate ${r.used}/${r.limit} ${r.pct}% reset=${r.resetMins}m`);
  return renderTile({ value: `${r.pct}%`, color, label: `rst ${r.resetMins}m` });
}

async function computeIcon(inst) {
  if (inst.type === ACTION_GHRATE) return ghRateIcon();
  if (inst.type === ACTION_SPRINT) return sprintIcon(inst);
  if (inst.type === ACTION_CMDAGENTS) return cmdAgentsIcon(inst);
  if (inst.type === ACTION_CLAUDECODE) return claudeMappedIcon(inst);
  if (inst.type === ACTION_CLAUDECYCLE) return claudeCycleIcon(inst);
  if (inst.type === ACTION_ANTIGRAVITY) {
    inst.resolvedProject = await resolveProject(inst);
    inst.lastRead = await readProjectCommit(inst.resolvedProject);
    dbg(`render antigravity ctx=${inst.context} project="${inst.resolvedProject}" read=${JSON.stringify(inst.lastRead)}`);
    return commitIcon(inst.lastRead);
  }
  inst.lastRead = await readSource(inst.stateDir, inst.source);
  return fileIcon(inst.lastRead);
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
  ensureGitWatch(inst); // (re)arm the commit watcher now that the project is resolved
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

function startPolling(inst) {
  stopPolling(inst);
  inst.timer = setInterval(() => { renderInstance(inst); }, inst.intervalMs);
  renderInstance(inst); // immediate first paint (also arms the git watcher)
}
function stopPolling(inst) {
  closeWatch(inst);
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
  if (inst.type === ACTION_CLAUDECODE || inst.type === ACTION_CLAUDECYCLE) {
    inst.intervalMs = SESSION_POLL_MS;
    inst.stateDir = resolveStateDir(settings);          // where cc_sessions/ lives
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
    inst.intervalMs = FILE_POLL_MS;
    if ('source' in settings) inst.source = String(settings.source || '').trim();
    if ('stateDir' in settings || !inst.stateDir) inst.stateDir = resolveStateDir(settings);
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
    const base = await resolveCommanderBase(inst);
    log(`tap sprint -> open dashboard ${base}`);
    execFile('open', [base], (err) => { if (err) dbg(`open dashboard failed: ${err.message}`); });
  } else if (inst.type === ACTION_CMDAGENTS) {
    const n = (inst.cycleList || []).length || 1;
    inst.cycleIdx = ((inst.cycleIdx || 0) + 1) % n; // advance to next agent
    log(`tap cmdagents -> idx ${inst.cycleIdx}/${n}`);
  } else if (inst.type === ACTION_CLAUDECYCLE) {
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
