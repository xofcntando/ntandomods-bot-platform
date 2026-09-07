// ── healthcheck.bot.js — 🩺 Health Auditor template ──────────────
// Audits the platform supervisor + every owned bot on an interval,
// records anomalies, and exposes a health endpoint that flips to 503.
'use strict';

const host = require('../bots/host');

const spec = host.loadSpec();
const E = spec.env;
const INTERVAL_SEC = Math.max(15, Number(E.CHECK_INTERVAL_SEC) || 60);
const HISTORY = []; // rolling audit records
const HISTORY_MAX = 100;

function auditOnce(trigger = 'interval') {
  const anomalies = [];
  return host.platformCall('supervisorStats')
    .then((sup) => {
      if (!sup || sup.crashed > 0) anomalies.push(`supervisor reports ${sup ? sup.crashed : '?'} crashed bot(s)`);
      if (sup && sup.botsTotal === 0) anomalies.push('no bots registered under this owner');
      return host.platformCall('listBots');
    })
    .then((bots) => {
      let chain = Promise.resolve();
      for (const b of bots) {
        chain = chain.then(() => host.platformCall('botStatus', { slug: b.slug }).then((st) => {
          const rt = st && st.runtime;
          if (rt && rt.status === 'crashed') anomalies.push(`bot "${b.slug}" is crashed`);
          if (rt && rt.status === 'running' && rt.uptimeSec < 30 && rt.restarts > 0) {
            anomalies.push(`bot "${b.slug}" unstable: uptime ${rt.uptimeSec}s with ${rt.restarts} restart(s)`);
          }
          if (rt && rt.rssMb > 400) anomalies.push(`bot "${b.slug}" using ${rt.rssMb}MB rss`);
        }).catch(() => {}));
      }
      return chain;
    })
    .then(() => {
      const self = host.collectStats();
      if (self.rssMb > 400) anomalies.push(`self memory high: ${self.rssMb}MB`);

      const record = {
        at: new Date().toISOString(),
        trigger,
        anomalies,
        healthy: anomalies.length === 0,
        selfRssMb: self.rssMb,
      };
      HISTORY.unshift(record);
      if (HISTORY.length > HISTORY_MAX) HISTORY.length = HISTORY_MAX;
      if (anomalies.length) host.log(`audit: ${anomalies.length} anomaly(ies): ${anomalies.join('; ')}`);
      return record;
    });
}

host.http((req, res, u) => {
  if (u.method === 'GET' && (u.path === '/' || u.path === '/health' || u.path === '')) {
    const last = HISTORY[0];
    const healthy = !last || last.healthy;
    return host.sendJson(res, healthy ? 200 : 503, {
      bot: spec.slug,
      status: healthy ? 'healthy' : 'unhealthy',
      lastAudit: last || null,
    });
  }
  if (u.method === 'GET' && u.path === '/api/history') {
    return host.sendJson(res, 200, { bot: spec.slug, history: HISTORY.slice(0, 30) });
  }
  if (u.method === 'GET' && u.path === '/api/audit') {
    return auditOnce('manual')
      .then((r) => host.sendJson(res, 200, r))
      .catch((err) => host.sendJson(res, 500, { error: err.message }));
  }
  host.sendJson(res, 404, { error: 'not found', endpoints: ['/', '/health', '/api/history', '/api/audit'] });
});

(async () => {
  try { await auditOnce('boot'); } catch (err) { host.logError('boot audit failed:', err.message); }
  host.ready({ auditsRun: 0 });
  setInterval(() => { auditOnce().catch((e) => host.logError('audit failed:', e.message)); }, INTERVAL_SEC * 1000).unref();
})();
