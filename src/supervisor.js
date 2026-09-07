// ── Supervisor: fork bots, watch them, restart them, broker IPC ──
'use strict';

const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const registry = require('./templates/registry');

const HEARTBEAT_TIMEOUT_MS = 60 * 1000;   // running bot silent >60s → kill
const WATCHDOG_INTERVAL_MS = 15 * 1000;   // watchdog sweep cadence
const STABLE_UPTIME_MS = 5 * 60 * 1000;   // uptime after which restartCount resets
const GRACE_PERIOD_MS = 6 * 1000;         // IPC shutdown → SIGKILL deadline
const LOG_RING_SIZE = 500;                // in-memory log ring per bot
const LOG_FILE_MAX_BYTES = 2 * 1024 * 1024; // rotate file when >2MB (halve it)

class Runtime {
  constructor(bot) {
    this.bot = bot;             // current bot record (id, slug, ownerId, env, port…)
    this.proc = null;
    this.status = 'stopped';    // starting | running | crashed | stopped
    this.startedAt = null;
    this.lastStats = null;
    this.lastHeartbeat = 0;
    this.restartCount = 0;
    this.backoffMs = 0;
    this.restartTimer = null;
    this.stopping = false;
    this.logRing = [];
    this.deployId = null;
  }
}

function createSupervisor(store) {
  const runtimes = new Map(); // botId → Runtime

  // ── start a bot ───────────────────────────────────────────────
  async function start(bot, { deployId = null } = {}) {
    const existing = runtimes.get(bot.id);
    if (existing && (existing.status === 'running' || existing.status === 'starting')) {
      return existing; // already up
    }

    const rt = existing || new Runtime(bot);
    rt.bot = bot;
    rt.stopping = false;
    rt.status = 'starting';
    rt.startedAt = Date.now();
    rt.lastHeartbeat = Date.now();
    rt.deployId = deployId;
    if (!existing) runtimes.set(bot.id, rt);

    await store.updateBot(bot.id, { status: 'starting' });

    const spec = {
      id: bot.id, slug: bot.slug, name: bot.name, ownerId: bot.ownerId,
      template: bot.template, env: bot.env || {}, port: bot.port,
      memoryLimitMb: bot.memoryLimitMb, autoRestart: bot.autoRestart,
      platform: { baseUrl: config.baseUrl, internalToken: config.internalToken },
    };

    const tpl = registry.get(bot.template);
    const entry = path.join(config.root, 'src', 'templates', tpl.entry);

    rt.proc = fork(entry, [], {
      env: { ...process.env, BOT_SPEC: JSON.stringify(spec) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      cwd: config.root,
    });

    rt.proc.stdout.on('data', (d) => _appendLog(rt, d.toString()));
    rt.proc.stderr.on('data', (d) => _appendLog(rt, d.toString(), true));
    rt.proc.on('message', (msg) => _onChildMessage(rt, msg));
    rt.proc.on('exit', (code, signal) => _onExit(rt, code, signal));

    _appendLog(rt, `forked pid ${rt.proc.pid} on port ${bot.port} (template ${bot.template})`);
    return rt;
  }

  // ── stop (graceful: IPC → grace → SIGKILL) ────────────────────
  async function stop(botId, { persist = true } = {}) {
    const rt = runtimes.get(botId);
    if (!rt || !rt.proc) return false;
    if (rt.restartTimer) {
      clearTimeout(rt.restartTimer);
      rt.restartTimer = null;
    }
    rt.stopping = true;
    try { rt.proc.send({ type: 'shutdown' }); } catch (_) {}
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { rt.proc.kill('SIGKILL'); } catch (_) {}
        resolve();
      }, GRACE_PERIOD_MS);
      rt.proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
    rt.stopping = false;
    if (persist) await store.updateBot(botId, { status: 'stopped' });
    return true;
  }

  async function restart(bot) {
    await stop(bot.id, { persist: false });
    return start(bot);
  }

  async function remove(botId) {
    await stop(botId, { persist: false });
    runtimes.delete(botId);
  }

  async function shutdownAll() {
    const ids = [...runtimes.keys()];
    await Promise.all(ids.map((id) => stop(id, { persist: true })));
    console.log(`[supervisor] graceful shutdown: ${ids.length} bot(s) marked stopped`);
  }

  // ── describe / stats ──────────────────────────────────────────
  function describe(botId) {
    const rt = runtimes.get(botId);
    if (!rt) return null;
    const d = {
      botId,
      slug: rt.bot.slug,
      status: rt.status,
      pid: rt.proc ? rt.proc.pid : null,
      uptimeSec: rt.startedAt ? Math.floor((Date.now() - rt.startedAt) / 1000) : 0,
      restarts: rt.restartCount,
      nextRestartInMs: rt.restartTimer ? Math.max(0, rt.backoffMs) : null,
      lastHeartbeat: rt.lastHeartbeat ? new Date(rt.lastHeartbeat).toISOString() : null,
      lastStats: rt.lastStats,
    };
    if (rt.lastStats) {
      d.rssMb = rt.lastStats.rssMb;
      d.cpuPercent = rt.lastStats.cpuPercent;
      d.heapMb = rt.lastStats.heapMb;
    }
    return d;
  }

  function platformStats() {
    let running = 0, starting = 0, crashed = 0, stopped = 0, totalRestarts = 0, aggRss = 0;
    for (const rt of runtimes.values()) {
      if (rt.status === 'running') running++;
      else if (rt.status === 'starting') starting++;
      else if (rt.status === 'crashed') crashed++;
      else stopped++;
      totalRestarts += rt.restartCount;
      if (rt.lastStats && rt.status === 'running') aggRss += rt.lastStats.rssMb || 0;
    }
    return {
      botsTotal: runtimes.size,
      running, starting, crashed, stopped,
      totalRestarts,
      aggregateRssMb: +aggRss.toFixed(1),
    };
  }

  function logs(botId, tail = 100) {
    const rt = runtimes.get(botId);
    if (!rt) return [];
    const n = Math.max(1, Math.min(500, Number(tail) || 100));
    // entries are {t, line, err} — surface as plain strings for API + templates
    return rt.logRing.slice(-n).map((e) => (e && e.line !== undefined ? `${e.t} ${e.err ? '[err] ' : ''}${e.line}` : String(e)));
  }

  // ── IPC message handling ──────────────────────────────────────
  function _onChildMessage(rt, msg) {
    if (!msg || typeof msg !== 'object') return;
    rt.lastHeartbeat = Date.now();

    if (msg.type === 'ready') {
      rt.status = 'running';
      rt.lastStats = msg.stats || null;
      _appendLog(rt, `bot ready (pid ${rt.proc && rt.proc.pid})`);
      store.updateBot(rt.bot.id, { status: 'running' }).catch(() => {});
      // stable after 5 minutes → reset crash counter
      if (rt.restartCount > 0 && Date.now() - rt.startedAt > STABLE_UPTIME_MS) {
        rt.restartCount = 0;
        rt.backoffMs = 0;
      }
      if (rt.deployId) {
        _finishDeployment(rt, 'running', `bot is live on port ${rt.bot.port}`);
        rt.deployId = null;
      }
    } else if (msg.type === 'stats') {
      rt.lastStats = msg.stats || null;
      _watchMemory(rt);
    } else if (msg.type === 'fatal') {
      _appendLog(rt, `FATAL: ${msg.error || 'unknown fatal error'}`, true);
    } else if (msg.type === 'request') {
      _onPlatformCall(rt, msg).catch((err) => {
        _trySend(rt.proc, { type: 'response', id: msg.id, ok: false, error: err.message });
      });
    }
  }

  // Bots may call back into the platform — owner-checked allowlist.
  async function _onPlatformCall(rt, msg) {
    const { action, payload } = msg;
    const bot = rt.bot; // the calling bot

    const respond = (result) => _trySend(rt.proc, { type: 'response', id: msg.id, ok: true, result });
    const fail = (error) => _trySend(rt.proc, { type: 'response', id: msg.id, ok: false, error: String(error && error.message || error) });

    try {
      switch (action) {
        case 'getBot': {
          const b = await store.getBot(payload.id || payload.slug);
          if (!b) return fail('bot not found');
          if (b.ownerId !== bot.ownerId) return fail('not your bot');
          return respond(b);
        }
        case 'listBots': {
          const list = await store.listBots({ ownerId: bot.ownerId });
          return respond({ bots: list });
        }
        case 'createBot': {
          const created = await store.createBot({
            name: payload.name,
            ownerId: bot.ownerId, // forced: a bot can only create siblings for its owner
            template: payload.template,
            env: payload.env || {},
            autoRestart: payload.autoRestart !== false,
            memoryLimitMb: payload.memoryLimitMb || 0,
          });
          return respond({ bot: created, liveUrl: _liveUrl(created) });
        }
        case 'startBot': {
          const b = await store.getBot(payload.id || payload.slug);
          if (!b) return fail('bot not found');
          if (b.ownerId !== bot.ownerId) return fail('not your bot');
          const dep = await store.addDeployment({ botId: b.id, ownerId: b.ownerId, trigger: 'bot:' + bot.slug, template: b.template, name: b.name });
          await start(b, { deployId: dep.id });
          return respond({ ok: true, started: describe(b.id), liveUrl: _liveUrl(b) });
        }
        case 'restartBot': {
          const b = await store.getBot(payload.id || payload.slug);
          if (!b) return fail('bot not found');
          if (b.ownerId !== bot.ownerId) return fail('not your bot');
          await restart(b);
          return respond({ ok: true, started: describe(b.id) });
        }
        case 'stopBot': {
          const b = await store.getBot(payload.id || payload.slug);
          if (!b) return fail('bot not found');
          if (b.ownerId !== bot.ownerId) return fail('not your bot');
          await stop(b.id);
          return respond({ ok: true });
        }
        case 'listTemplates': {
          return respond({ templates: registry.list() });
        }
        case 'supervisorStats': {
          return respond({ stats: platformStats() });
        }
        case 'botStatus': {
          const b = await store.getBot(payload.id || payload.slug);
          if (!b) return fail('bot not found');
          if (b.ownerId !== bot.ownerId) return fail('not your bot');
          return respond({ bot: b, runtime: describe(b.id) });
        }
        case 'botLogs': {
          const b = await store.getBot(payload.id || payload.slug);
          if (!b) return fail('bot not found');
          if (b.ownerId !== bot.ownerId) return fail('not your bot');
          return respond({ logs: logs(b.id, payload.tail || 50) });
        }
        case 'addDeployment': {
          const d = await store.addDeployment({
            botId: payload.botId, ownerId: bot.ownerId,
            trigger: payload.trigger || 'bot:' + bot.slug,
            template: payload.template, name: payload.name,
          });
          return respond({ dep: d });
        }
        case 'updateDeployment': {
          const d = await store.getDeployment(payload.id);
          if (!d) return fail('deployment not found');
          if (d.ownerId !== bot.ownerId) return fail('not your deployment');
          const updated = await store.updateDeployment(payload.id, payload);
          return respond(updated);
        }
        case 'reportEvent': {
          _appendLog(rt, `EVENT ${payload.type || 'event'}: ${payload.message || ''}`);
          return respond({ ok: true });
        }
        default:
          return fail(`unknown platform call: ${action}`);
      }
    } catch (err) {
      return fail(err);
    }
  }

  function _liveUrl(bot) {
    if (config.rootDomain) return `https://${bot.slug}.${config.rootDomain}/`;
    return `${config.baseUrl}/live/${bot.slug}/`;
  }

  // ── memory watchdog ───────────────────────────────────────────
  function _watchMemory(rt) {
    const limit = rt.bot.memoryLimitMb || config.memoryLimitMb;
    if (!limit || !rt.lastStats) return;
    const rss = rt.lastStats.rssMb || 0;
    if (rss > limit * 1.05) {
      _appendLog(rt, `memory watchdog: ${rss}MB > ${limit}MB limit — killing bot`, true);
      try { rt.proc.kill('SIGKILL'); } catch (_) {}
    } else if (rss > limit * 0.8) {
      _appendLog(rt, `memory warning: ${rss}MB approaching ${limit}MB limit`, true);
    }
  }

  // ── exit handling + auto-restart with exponential backoff ─────
  function _onExit(rt, code, signal) {
    const wasStopping = rt.stopping;
    rt.proc = null;

    if (wasStopping) {
      rt.status = 'stopped';
      _appendLog(rt, `bot stopped (signal ${signal || 'exit'}, code ${code})`);
      store.updateBot(rt.bot.id, { status: 'stopped' }).catch(() => {});
      if (rt.deployId) {
        _finishDeployment(rt, 'stopped', 'bot stopped');
        rt.deployId = null;
      }
      return;
    }

    rt.status = 'crashed';
    _appendLog(rt, `bot CRASHED (signal ${signal || 'exit'}, code ${code})`, true);
    store.updateBot(rt.bot.id, { status: 'crashed' }).catch(() => {});
    if (rt.deployId) {
      _finishDeployment(rt, 'failed', `bot exited with code ${code}`);
      rt.deployId = null;
    }

    if (!rt.bot.autoRestart) {
      _appendLog(rt, 'auto-restart disabled — leaving bot crashed');
      return;
    }

    rt.restartCount += 1;
    rt.backoffMs = rt.backoffMs ? Math.min(rt.backoffMs * 2, config.backoffMaxMs) : config.backoffBaseMs;
    _appendLog(rt, `auto-restart scheduled in ${rt.backoffMs}ms (attempt ${rt.restartCount})`);
    rt.restartTimer = setTimeout(async () => {
      rt.restartTimer = null;
      try {
        const fresh = await store.getBot(rt.bot.id);
        if (!fresh) return; // bot was deleted meanwhile
        await start(fresh);
      } catch (err) {
        _appendLog(rt, `auto-restart failed: ${err.message}`, true);
      }
    }, rt.backoffMs);
    rt.restartTimer.unref?.();
  }

  function _finishDeployment(rt, status, detail) {
    const id = rt.deployId;
    if (!id) return;
    store.getDeployment(id).then((dep) => {
      if (!dep) return;
      const steps = [...(dep.steps || [])];
      steps.push({ name: 'runtime', status, detail, at: new Date().toISOString() });
      store.updateDeployment(id, { steps, status }).catch(() => {});
    }).catch(() => {});
  }

  // ── logging: in-memory ring + append-to-file with rotation ────
  function _appendLog(rt, text, isError = false) {
    const line = typeof text === 'string' ? text.trimEnd() : JSON.stringify(text);
    if (!line) return;
    const entry = { t: new Date().toISOString(), line: line.slice(0, 2000), err: !!isError };
    rt.logRing.push(entry);
    if (rt.logRing.length > LOG_RING_SIZE) rt.logRing.splice(0, rt.logRing.length - LOG_RING_SIZE);

    try {
      const file = path.join(config.root, config.dataDir, 'logs', `${rt.bot.slug}.log`);
      fs.appendFileSync(file, `[${entry.t}]${entry.err ? ' [err]' : ''} ${entry.line}\n`);
      const st = fs.statSync(file);
      if (st.size > LOG_FILE_MAX_BYTES) {
        // rotation: keep the newest half
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n');
        fs.writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n'));
      }
    } catch (_) { /* log file best-effort */ }
  }

  function _trySend(proc, msg) {
    try { proc.send(msg); } catch (_) {}
  }

  // ── heartbeat watchdog sweep ──────────────────────────────────
  function startWatchdog() {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const rt of runtimes.values()) {
        if (rt.status !== 'running') continue;
        if (now - rt.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
          _appendLog(rt, 'heartbeat watchdog: no stats for 60s — killing bot', true);
          try { rt.proc.kill('SIGKILL'); } catch (_) {}
        }
      }
    }, WATCHDOG_INTERVAL_MS);
    timer.unref();
    return timer;
  }

  return {
    start, stop, restart, remove, shutdownAll,
    describe, platformStats, logs, startWatchdog,
    runtimes,
  };
}

module.exports = { createSupervisor };
