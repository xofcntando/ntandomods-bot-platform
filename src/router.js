'use strict';
// Ntandomods Bot Platform — REST API router
// All routes live under /api/. Auth via Bearer JWT or X-API-Key.

const crypto = require('crypto');
const { signToken, verifyToken, hashApiKey, verifyPassword, RateLimiter } = require('./auth');
const registry = require('./templates/registry');
const config = require('./config');

function createRouter(store, supervisor) {
  const routes = [];
  const rateLimiter = new RateLimiter(config.rateLimit.max, config.rateLimit.windowMs);

  function add(method, pattern, handler) {
    const keys = [];
    const rx = new RegExp(
      '^' + pattern.replace(/:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$'
    );
    routes.push({ method, rx, keys, handler });
  }

  function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 256 * 1024) { reject(httpError(413, 'body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(httpError(400, 'invalid JSON body')); }
      });
      req.on('error', reject);
    });
  }

  const httpError = (status, message) => Object.assign(new Error(message), { status });

  async function authenticate(req) {
    const auth = String(req.headers.authorization || '');
    if (auth.startsWith('Bearer ')) {
      const payload = verifyToken(auth.slice(7));
      if (payload) {
        const user = store.getUser(payload.sub);
        if (user) return user;
      }
      return null;
    }
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const record = store.findApiKeyByHash(hashApiKey(apiKey));
      if (record) {
        store.touchApiKey(record.id);
        return store.getUser(record.userId);
      }
      return null;
    }
    return null;
  }

  const requireAuth = async (user) => user || Promise.reject(httpError(401, 'authentication required'));
  const requireAdmin = async (user) =>
    (user && user.role === 'admin') || Promise.reject(httpError(403, 'admin only'));

  const canSee = (user, bot) => user.role === 'admin' || bot.ownerId === user.id;

  function liveUrl(bot) {
    return config.rootDomain
      ? `https://${bot.slug}.${config.rootDomain}/`
      : `${config.baseUrl}/live/${bot.slug}/`;
  }

  const mergeRuntime = (bot) => ({ ...bot, runtime: supervisor.describe(bot.id), liveUrl: liveUrl(bot) });

  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt });

  // ---------------- auth ----------------
  add('GET', '/api/health', async () => ({ ok: true, service: 'ntandomods-bot-platform', time: new Date().toISOString() }));

  add('POST', '/api/auth/login', async (c) => {
    const body = await readBody(c.req);
    const user = await store.getByEmail(String(body.email || '').toLowerCase());
    if (!user || !verifyPassword(String(body.password || ''), user.passwordHash)) {
      throw httpError(401, 'invalid email or password');
    }
    return { token: signToken({ sub: user.id, role: user.role }), user: publicUser(user) };
  });

  add('POST', '/api/auth/register', async (c) => {
    const body = await readBody(c.req);
    const password = String(body.password || '');
    if (password.length < 8) throw httpError(400, 'password must be at least 8 characters');
    const user = store.createUser({
      email: String(body.email || '').toLowerCase(),
      name: String(body.name || '').trim(),
      password,
    });
    return { token: signToken({ sub: user.id, role: user.role }), user: publicUser(user) };
  });

  add('GET', '/api/auth/me', async (c) => ({ user: publicUser(await requireAuth(c.user)) }));

  // ---------------- templates ----------------
  add('GET', '/api/templates', async () => ({ templates: registry.list() }));
  add('GET', '/api/templates/:key', async (c) => {
    const tpl = registry.get(c.params.key);
    return { template: tpl };
  });

  // ---------------- api keys ----------------
  add('GET', '/api/keys', async (c) => {
    await requireAuth(c.user);
    return { keys: store.listApiKeys(c.user.id) };
  });

  add('POST', '/api/keys', async (c) => {
    const user = await requireAuth(c.user);
    const body = await readBody(c.req);
    const created = store.createApiKey(user.id, String(body.name || 'api key').slice(0, 60));
    return {
      key: { id: created.id, name: created.name, prefix: created.prefix, createdAt: created.createdAt },
      secret: created.secret,
      note: 'store this secret now — it will not be shown again',
    };
  });

  add('DELETE', '/api/keys/:id', async (c) => {
    const user = await requireAuth(c.user);
    const id = Number(c.params.id);
    const keys = store.listApiKeys(user.id);
    const target = keys.find((k) => k.id === id);
    if (!target) throw httpError(404, 'no such key');
    store.revokeApiKey(id);
    return { ok: true, revoked: id };
  });

  // ---------------- bots ----------------
  add('GET', '/api/bots', async (c) => {
    const user = await requireAuth(c.user);
    const all = store.listBots();
    const bots = user.role === 'admin'
      ? (c.query.owner !== undefined ? all.filter((b) => b.ownerId === Number(c.query.owner)) : all)
      : all.filter((b) => b.ownerId === user.id);
    return { bots: bots.map(mergeRuntime), count: bots.length };
  });

  add('POST', '/api/bots', async (c) => {
    const user = await requireAuth(c.user);
    const body = await readBody(c.req);
    const template = registry.get(String(body.template || ''));
    const env = body.env || {};
    registry.validate(template.key, env);
    const bot = store.createBot({
      name: String(body.name || '').trim() || `${template.key}-bot`,
      template: template.key,
      env,
      ownerId: user.id,
      autoRestart: body.autoRestart !== false,
      memoryLimitMb: Number(body.memoryLimitMb) || 0,
    });
    const dep = store.addDeployment(bot.id, bot.ownerId, 'manual');
    let started = null;
    if (body.start !== false) {
      started = await supervisor.start(bot, { deployId: dep.id });
    }
    return { bot: mergeRuntime(store.getBot(bot.id)), deployment: dep, started, liveUrl: liveUrl(bot) };
  });

  add('GET', '/api/bots/:id', async (c) => {
    const user = await requireAuth(c.user);
    const bot = store.getBot(c.params.id);
    if (!bot) throw httpError(404, 'no such bot');
    if (!canSee(user, bot)) throw httpError(403, 'not your bot');
    return { bot: mergeRuntime(bot) };
  });

  add('PATCH', '/api/bots/:id', async (c) => {
    const user = await requireAuth(c.user);
    const bot = store.getBot(c.params.id);
    if (!bot) throw httpError(404, 'no such bot');
    if (!canSee(user, bot)) throw httpError(403, 'not your bot');
    const body = await readBody(c.req);
    const patch = {};
    if (body.name !== undefined) patch.name = String(body.name).trim().slice(0, 80);
    if (body.env !== undefined) {
      registry.validate(bot.template, body.env);
      patch.env = body.env;
    }
    if (body.autoRestart !== undefined) patch.autoRestart = !!body.autoRestart;
    if (body.memoryLimitMb !== undefined) patch.memoryLimitMb = Number(body.memoryLimitMb) || 0;
    const updated = store.updateBot(bot.id, patch);
    const rt = supervisor.describe(bot.id);
    const needsRestart = patch.env !== undefined && rt && ['running', 'starting'].includes(rt.status);
    if (needsRestart) supervisor.restart(updated).catch(() => {});
    return { bot: mergeRuntime(store.getBot(bot.id)), restarted: needsRestart };
  });

  add('DELETE', '/api/bots/:id', async (c) => {
    const user = await requireAuth(c.user);
    const bot = store.getBot(c.params.id);
    if (!bot) throw httpError(404, 'no such bot');
    if (!canSee(user, bot)) throw httpError(403, 'not your bot');
    await supervisor.remove(bot.id).catch(() => {});
    store.deleteBot(bot.id);
    return { ok: true, deleted: bot.slug };
  });

  // ---------------- lifecycle ----------------
  const lifecycle = (action) => async (c) => {
    const user = await requireAuth(c.user);
    const bot = store.getBot(c.params.id);
    if (!bot) throw httpError(404, 'no such bot');
    if (!canSee(user, bot)) throw httpError(403, 'not your bot');

    if (action === 'start') {
      const dep = store.addDeployment(bot.id, bot.ownerId, 'restart');
      const started = await supervisor.start(bot, { deployId: dep.id });
      return { ok: true, started, liveUrl: liveUrl(bot) };
    }
    if (action === 'stop') {
      await supervisor.stop(bot.id);
      return { ok: true, stopped: true };
    }
    if (action === 'restart') {
      await supervisor.stop(bot.id, { persist: false }).catch(() => {});
      const dep = store.addDeployment(bot.id, bot.ownerId, 'restart');
      const started = await supervisor.start(bot, { deployId: dep.id });
      return { ok: true, started, liveUrl: liveUrl(bot) };
    }
    if (action === 'disable') {
      await supervisor.stop(bot.id).catch(() => {});
      store.updateBot(bot.id, { autoRestart: false });
      return { ok: true, disabled: true };
    }
    if (action === 'enable') {
      store.updateBot(bot.id, { autoRestart: true });
      return { ok: true, enabled: true };
    }
    throw httpError(400, 'unknown action');
  };
  for (const action of ['start', 'stop', 'restart', 'disable', 'enable']) {
    add('POST', `/api/bots/:id/${action}`, lifecycle(action));
  }

  // ---------------- logs / stats / deployments ----------------
  add('GET', '/api/bots/:id/logs', async (c) => {
    const user = await requireAuth(c.user);
    const bot = store.getBot(c.params.id);
    if (!bot) throw httpError(404, 'no such bot');
    if (!canSee(user, bot)) throw httpError(403, 'not your bot');
    const tail = Math.min(Number(c.query.tail) || 50, 500);
    return { bot: bot.slug, logs: supervisor.logs(bot.id, tail) };
  });

  add('GET', '/api/bots/:id/stats', async (c) => {
    const user = await requireAuth(c.user);
    const bot = store.getBot(c.params.id);
    if (!bot) throw httpError(404, 'no such bot');
    if (!canSee(user, bot)) throw httpError(403, 'not your bot');
    return { bot: bot.slug, runtime: supervisor.describe(bot.id), liveUrl: liveUrl(bot) };
  });

  add('GET', '/api/bots/:id/deployments', async (c) => {
    const user = await requireAuth(c.user);
    const bot = store.getBot(c.params.id);
    if (!bot) throw httpError(404, 'no such bot');
    if (!canSee(user, bot)) throw httpError(403, 'not your bot');
    return { deployments: store.listDeployments({ botId: bot.id, limit: 20 }) };
  });

  add('GET', '/api/deployments', async (c) => {
    const user = await requireAuth(c.user);
    const limit = Math.min(Number(c.query.limit) || 20, 100);
    const deps = store.listDeployments({ limit });
    const visible = user.role === 'admin' ? deps : deps.filter((d) => d.ownerId === user.id);
    return { deployments: visible };
  });

  // ---------------- platform stats ----------------
  add('GET', '/api/stats', async (c) => {
    const user = await requireAuth(c.user);
    const stats = supervisor.platformStats();
    return {
      stats: { ...stats, users: store.users.length, maxBots: config.maxBots, platformUptimeSec: Math.round(process.uptime()) },
    };
  });

  // ---------------- admin ----------------
  add('GET', '/api/admin/users', async (c) => {
    await requireAdmin(await requireAuth(c.user));
    return { users: store.users.map(publicUser) };
  });

  add('POST', '/api/admin/users', async (c) => {
    const admin = await requireAdmin(await requireAuth(c.user));
    const body = await readBody(c.req);
    const password = String(body.password || '');
    if (password.length < 8) throw httpError(400, 'password must be at least 8 characters');
    const user = store.createUser({
      email: String(body.email || '').toLowerCase(),
      name: String(body.name || '').trim(),
      password,
      role: body.role === 'admin' ? 'admin' : 'user',
    });
    return { user: publicUser(user), createdBy: admin.email };
  });

  add('DELETE', '/api/admin/users/:id', async (c) => {
    const admin = await requireAdmin(await requireAuth(c.user));
    const id = Number(c.params.id);
    if (id === admin.id) throw httpError(400, 'cannot delete yourself');
    const ok = store.deleteUser(id);
    if (!ok) throw httpError(404, 'no such user');
    return { ok: true, deleted: id };
  });

  add('GET', '/api/admin/logs', async (c) => {
    await requireAdmin(await requireAuth(c.user));
    const all = [];
    for (const bot of store.listBots()) {
      for (const line of supervisor.logs(bot.id, 50)) all.push(`[${bot.slug}] ${line}`);
    }
    all.sort(() => 0);
    return { logs: all.slice(-300) };
  });

  // ---------------- dispatcher ----------------
  async function dispatch(req, res) {
    if (!req.url.startsWith('/api/')) return false;

    const rate = rateLimiter.check(req.socket.remoteAddress || 'unknown');
    if (!rate.ok) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(Math.ceil(config.rateLimit.windowMs / 1000)) });
      res.end(JSON.stringify({ error: 'rate limit exceeded' }));
      return true;
    }

    const requestId = crypto.randomUUID();
    let user = null;
    try { user = await authenticate(req); } catch { user = null; }

    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const u = new URL(req.url, 'http://internal');
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const query = Object.fromEntries(u.searchParams);

    for (const route of routes) {
      if (route.method !== method) continue;
      const m = path.match(route.rx);
      if (!m) continue;
      const params = {};
      route.keys.forEach((k, i) => { params[k] = m[i + 1]; });
      res.setHeader('X-Request-Id', requestId);
      res.setHeader('X-RateLimit-Remaining', String(rate.remaining ?? 0));
      try {
        const out = await route.handler({ req, res, params, query, user });
        if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
        else if (!res.headersSent) sendJson(res, 200, { ok: true });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, err.status || 500, { error: err.message || 'internal error', requestId });
        } else { try { res.end(); } catch (_) {} }
      }
      return true;
    }

    sendJson(res, 404, { error: 'no such API route', requestId });
    return true;
  }

  return { dispatch };
}

module.exports = { createRouter };
