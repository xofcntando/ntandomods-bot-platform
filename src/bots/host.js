// ── Bot child SDK — the runtime contract for every template ──────
// A bot process is forked with BOT_SPEC (JSON) in its env. It uses this SDK
// to: report ready, serve HTTP on its assigned port (127.0.0.1), stream
// stats heartbeats over IPC, and call back into the platform.
'use strict';

const httpLib = require('http');
const processRef = process;

const HEARTBEAT_MS = 10 * 1000;
const CALL_TIMEOUT_MS = 15 * 1000;

// ── spec ─────────────────────────────────────────────────────────
let spec = null;
function loadSpec() {
  if (spec) return spec;
  const defaults = {
    id: 'standalone', slug: 'standalone', name: 'Standalone', ownerId: null,
    template: 'custom', env: {}, port: 0, memoryLimitMb: 0, autoRestart: true,
    platform: { baseUrl: 'http://localhost:3000', internalToken: '' },
  };
  try {
    spec = { ...defaults, ...JSON.parse(processRef.env.BOT_SPEC || '{}') };
  } catch (err) {
    spec = defaults;
  }
  spec.env = { ...(spec.env || {}) };
  return spec;
}

// ── structured logging (stdout → supervisor log ring + file) ─────
function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  processRef.stdout.write(`[${ts()}] ${line}\n`);
}
function logError(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : (a && a.stack) || JSON.stringify(a))).join(' ');
  processRef.stderr.write(`[${ts()}] ${line}\n`);
}
function ts() { return new Date().toISOString(); }

// ── stats collection (heartbeat payload) ─────────────────────────
let lastCpu = processRef.cpuUsage();
let lastCpuAt = Date.now();
function collectStats(extra = {}) {
  const now = Date.now();
  const cur = processRef.cpuUsage();
  const elapsed = (now - lastCpuAt) / 1000;
  const cpuPercent = elapsed > 0 ? ((cur.user + cur.system - lastCpu.user - lastCpu.system) / 1000 / elapsed) * 100 : 0;
  lastCpu = cur;
  lastCpuAt = now;
  const mem = processRef.memoryUsage();
  return {
    pid: processRef.pid,
    uptimeSec: Math.floor(processRef.uptime()),
    rssMb: +(mem.rss / 1048576).toFixed(1),
    heapMb: +(mem.heapUsed / 1048576).toFixed(1),
    cpuPercent: +cpuPercent.toFixed(1),
    ...extra,
  };
}

// ── platform calls over IPC (supervisor brokers) ─────────────────
const pendingCalls = new Map(); // id → {resolve, reject, timer}
let callSeq = 0;

function platformCall(action, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++callSeq;
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error(`platform call "${action}" timed out`));
    }, CALL_TIMEOUT_MS);
    pendingCalls.set(id, { resolve, reject, timer });
    try {
      processRef.send({ type: 'request', id, action, payload });
    } catch (err) {
      pendingCalls.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

function _installIpc() {
  processRef.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'response' && pendingCalls.has(msg.id)) {
      const p = pendingCalls.get(msg.id);
      pendingCalls.delete(msg.id);
      clearTimeout(p.timer);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || 'platform call failed'));
    } else if (msg.type === 'shutdown') {
      gracefulExit(0);
    }
  });
}

// ── HTTP server on the assigned port (localhost only) ────────────
let httpServer = null;

function http(handler) {
  const s = loadSpec();
  if (!s.port) return null; // no port → no HTTP surface
  const server = httpLib.createServer((req, res) => {
    Promise.resolve(handler(req, res, urlParts(req))).catch((err) => {
      logError('http handler error:', err && err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      } else {
        try { res.end(); } catch (_) {}
      }
    });
  });
  server.listen(s.port, '127.0.0.1', () => log(`http on 127.0.0.1:${s.port}`));
  httpServer = server;
  return server;
}

function urlParts(req) {
  const u = new URL(req.url, `http://127.0.0.1:${loadSpec().port || 80}`);
  const parts = u.pathname.split('/').filter(Boolean);
  return {
    path: u.pathname,
    parts,
    query: Object.fromEntries(u.searchParams.entries()),
    method: req.method,
  };
}

// ── body reader (small JSON payloads) ────────────────────────────
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (err) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ── lifecycle ────────────────────────────────────────────────────
let heartbeatTimer = null;

function ready(extra = {}) {
  _installIpc();
  const stats = collectStats(extra);
  try { processRef.send({ type: 'ready', stats }); } catch (_) {}
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    try { processRef.send({ type: 'stats', stats: collectStats() }); } catch (_) {}
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();
  processRef.on('disconnect', () => gracefulExit(0));
  processRef.on('uncaughtException', (err) => {
    logError('uncaught exception:', err);
    try { processRef.send({ type: 'fatal', error: err && err.message }); } catch (_) {}
    processRef.exit(1);
  });
}

function reportMetrics(extra) {
  try { processRef.send({ type: 'stats', stats: collectStats(extra) }); } catch (_) {}
}

function gracefulExit(code) {
  clearInterval(heartbeatTimer);
  const finish = () => processRef.exit(code);
  if (httpServer) {
    httpServer.close(() => finish());
    httpServer.closeAllConnections?.();
    setTimeout(finish, 1500).unref();
  } else {
    finish();
  }
}

module.exports = {
  loadSpec, log, logError, collectStats, platformCall,
  http, urlParts, readBody, sendJson, ready, reportMetrics, gracefulExit,
};
