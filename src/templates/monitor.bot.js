// ── monitor.bot.js — 📡 Site Monitor template ───────────────────
// Checks HTTP(S) targets on an interval, tracks history/availability,
// raises alerts through the platform, and serves a status page.
'use strict';

const http = require('http');
const https = require('https');
const host = require('../bots/host');

const spec = host.loadSpec();
const E = spec.env;

const TARGETS = String(E.TARGETS || 'https://example.com')
  .split(',').map((s) => s.trim()).filter(Boolean);
const INTERVAL_SEC = Math.max(10, Number(E.CHECK_INTERVAL_SEC) || 30);
const TIMEOUT_MS = Math.max(1000, Number(E.TIMEOUT_MS) || 5000);
const HISTORY_SIZE = Math.min(500, Math.max(10, Number(E.HISTORY_SIZE) || 50));

// state: per-target rolling history of {ok, ms, status, at}
const state = new Map();
for (const t of TARGETS) {
  state.set(t, { history: [], consecutiveDowns: 0, downSince: null, ups: 0, downs: 0, lastMs: null });
}

function checkOne(url) {
  return new Promise((resolve) => {
    const started = Date.now();
    const lib = String(url).toLowerCase().startsWith('https:') ? https : http;
    const req = lib.get(url, { timeout: TIMEOUT_MS }, (res) => {
      res.resume(); // drain
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, ms: Date.now() - started, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: Date.now() - started, status: 0, error: 'timeout' }); });
    req.on('error', (err) => resolve({ ok: false, ms: Date.now() - started, status: 0, error: err.code || err.message }));
  });
}

async function checkAll() {
  const results = await Promise.all(TARGETS.map(async (url) => {
    const r = await checkOne(url);
    const s = state.get(url);
    s.history.push({ ...r, at: new Date().toISOString() });
    if (s.history.length > HISTORY_SIZE) s.history.splice(0, s.history.length - HISTORY_SIZE);
    s.lastMs = r.ms;

    if (r.ok) {
      s.ups++;
      s.consecutiveDowns = 0;
      s.downSince = null;
    } else {
      s.downs++;
      s.consecutiveDowns++;
      if (!s.downSince) s.downSince = new Date().toISOString();
    }
    return { url, ...r };
  }));

  const upCount = results.filter((r) => r.ok).length;

  // alert when ALL targets have been down 3 checks in a row
  const allDown = upCount === 0 && [...state.values()].every((s) => s.consecutiveDowns >= 3);
  if (allDown) {
    host.log(`ALERT: all ${TARGETS.length} target(s) down for 3+ consecutive checks`);
    host.platformCall('reportEvent', { type: 'alert', message: `all targets down: ${TARGETS.join(', ')}` }).catch(() => {});
  }

  host.reportMetrics({ targetsTotal: TARGETS.length, targetsUp: upCount, avgMs: Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length) });
  return results;
}

function summary() {
  const rows = TARGETS.map((url) => {
    const s = state.get(url);
    const total = s.ups + s.downs;
    return {
      url,
      up: s.consecutiveDowns === 0,
      status: s.history.length ? s.history[s.history.length - 1].status : null,
      lastMs: s.lastMs,
      availability: total ? +((s.ups / total) * 100).toFixed(1) : null,
      consecutiveDowns: s.consecutiveDowns,
      downSince: s.downSince,
      history: s.history.slice(-10),
    };
  });
  return { bot: spec.slug, checkedAt: new Date().toISOString(), targets: rows };
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function statusPage() {
  const s = summary();
  const rows = s.targets.map((t) => `
    <tr class="${t.up ? 'up' : 'down'}">
      <td><a href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.url)}</a></td>
      <td>${t.up ? '✅ UP' : '⛔ DOWN'}</td>
      <td>${t.status || '—'}</td>
      <td>${t.lastMs != null ? t.lastMs + 'ms' : '—'}</td>
      <td>${t.availability != null ? t.availability + '%' : '—'}</td>
    </tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(spec.name)} — status</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;background:#0b0e14;color:#e6edf3;margin:0;padding:40px}
  h1{font-size:1.4rem} a{color:#22d3ee}
  table{border-collapse:collapse;width:100%;max-width:860px;margin-top:16px}
  th,td{padding:10px 12px;border-bottom:1px solid #1f2630;text-align:left;font-size:.9rem}
  th{color:#8b949e;text-transform:uppercase;font-size:.72rem;letter-spacing:.08em}
  tr.up td:first-child{border-left:3px solid #34d399}
  tr.down td:first-child{border-left:3px solid #f87171}
  footer{margin-top:24px;color:#8b949e;font-size:.8rem}
</style></head><body>
<h1>📡 ${esc(spec.name)}</h1>
<p>Live status page served by bot <code>${esc(spec.slug)}</code> · ${TARGETS.length} target(s) · checked every ${INTERVAL_SEC}s</p>
<table><thead><tr><th>Target</th><th>State</th><th>Status</th><th>Latency</th><th>Availability</th></tr></thead>
<tbody>${rows}</tbody></table>
<footer>Data: <a href="api">/api</a> · refreshed ${esc(s.checkedAt)}</footer>
</body></html>`;
}

host.http((req, res, u) => {
  if (u.path === '/' || u.path === '') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(statusPage());
    return;
  }
  if (u.path === '/api' || u.path === '/api/') return host.sendJson(res, 200, summary());
  if (u.path === '/api/trigger') {
    checkAll()
      .then((r) => host.sendJson(res, 202, { ok: true, checked: r.length }))
      .catch((err) => host.sendJson(res, 500, { error: err.message }));
    return;
  }
  host.sendJson(res, 404, { error: 'not found', endpoints: ['/', '/api', '/api/trigger'] });
});

// boot: first check, then interval
(async () => {
  try { await checkAll(); } catch (err) { host.logError('initial check failed:', err.message); }
  host.ready({ targets: TARGETS.length, intervalSec: INTERVAL_SEC });
  setInterval(() => { checkAll().catch((e) => host.logError('check failed:', e.message)); }, INTERVAL_SEC * 1000).unref();
})();
