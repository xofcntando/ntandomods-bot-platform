// ── Live reverse proxy: subdomain mode + /live/<slug> path mode ──
'use strict';

const http = require('http');
const config = require('./config');

const HOP_HEADERS = ['connection', 'keep-alive', 'te', 'upgrade', 'host', 'transfer-encoding'];
const UPSTREAM_TIMEOUT_MS = 15 * 1000;

function createProxy(store, supervisor) {
  // Resolve the target bot for this request, or null if not a proxy path.
  async function resolveTarget(req) {
    const host = String(req.headers.host || '').toLowerCase().split(':')[0];

    // ── subdomain mode: <slug>.root.domain ──
    if (config.rootDomain && host.endsWith('.' + config.rootDomain) && host !== config.rootDomain) {
      const slug = host.slice(0, -(config.rootDomain.length + 1));
      if (slug === 'www') return null; // reserved
      const bot = await store.getBot(slug);
      if (!bot) return { miss: 'unknown-slug', slug };
      const rt = supervisor.describe(bot.id);
      if (!rt || !['running', 'starting'].includes(rt.status)) return { miss: 'not-running', slug };
      return { bot, slug, port: bot.port, subpath: req.url };
    }

    // ── path mode: /live/<slug>/... ──
    const m = req.url.match(/^\/live\/([^/]+)(\/.*)?$/);
    if (m) {
      const slug = m[1];
      const restPath = m[2] || '/';
      const bot = await store.getBot(slug);
      if (!bot) return { miss: 'unknown-slug', slug };
      const rt = supervisor.describe(bot.id);
      if (!rt || !['running', 'starting'].includes(rt.status)) return { miss: 'not-running', slug };
      return { bot, slug, port: bot.port, subpath: restPath, stripPrefix: `/live/${slug}` };
    }

    return null;
  }

  function proxyError(res, status, code, message) {
    if (res.headersSent) {
      try { res.end(); } catch (_) {}
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: code, message }));
  }

  // Returns true if the request was handled as a proxy path.
  async function handle(req, res) {
    const target = await resolveTarget(req);
    if (!target) return false;

    if (target.miss) {
      if (target.miss === 'unknown-slug') {
        proxyError(res, 404, 'unknown-slug', `no bot named "${target.slug}"`);
      } else {
        proxyError(res, 502, 'not-running', `bot "${target.slug}" is not running`);
      }
      return true;
    }

    const headers = { ...req.headers };
    for (const h of HOP_HEADERS) delete headers[h];
    headers.host = `127.0.0.1:${target.port}`;

    const upstream = http.request(
      { host: '127.0.0.1', port: target.port, method: req.method, path: target.subpath, headers },
      (ur) => {
        const outHeaders = { ...ur.headers };
        // rewrite redirect targets so path-mode stays inside /live/<slug>
        if (target.stripPrefix && typeof outHeaders.location === 'string' && outHeaders.location.startsWith('/') && !outHeaders.location.startsWith(target.stripPrefix)) {
          outHeaders.location = target.stripPrefix + outHeaders.location;
        }
        res.writeHead(ur.statusCode, outHeaders);
        ur.pipe(res);
      }
    );

    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upstream.destroy();
      proxyError(res, 504, 'upstream-timeout', 'bot did not respond within 15s');
    });
    upstream.on('error', (err) => proxyError(res, 502, 'bad-gateway', err.message));

    req.pipe(upstream);
    return true;
  }

  return { handle };
}

module.exports = { createProxy };
