// ── Data layer: JSON store with atomic writes (SQLite-swappable DAO) ──
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { hashPassword, hashApiKey } = require('./auth');

const PORT_POOL_START = 40000;
const PORT_POOL_SIZE = 500;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const SCHEMA_VERSION = 1;

class Store {
  constructor() {
    this.file = path.join(config.root, config.dataDir, 'platform.json');
    this.data = null;
    this.saving = Promise.resolve();
  }

  async init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.mkdirSync(path.join(config.root, config.dataDir, 'logs'), { recursive: true });

    if (fs.existsSync(this.file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch (err) {
        // corrupt file → keep a backup, start fresh
        const backup = `${this.file}.corrupt-${Date.now()}`;
        fs.copyFileSync(this.file, backup);
        console.error(`[store] platform.json corrupt — backed up to ${backup}`);
        this.data = null;
      }
    }

    if (!this.data) {
      this.data = { schema: SCHEMA_VERSION, users: [], bots: [], apiKeys: [], deployments: [], meta: { nextUserId: 1, nextBotId: 1, nextKeyId: 1, nextDeploymentId: 1 } };
    }
    this.data.schema = this.data.schema || SCHEMA_VERSION;
    this.data.users = this.data.users || [];
    this.data.bots = this.data.bots || [];
    this.data.apiKeys = this.data.apiKeys || [];
    this.data.deployments = this.data.deployments || [];
    this.data.meta = this.data.meta || { nextUserId: 1, nextBotId: 1, nextKeyId: 1, nextDeploymentId: 1 };

    // seed the first admin if there are no users
    if (this.data.users.length === 0) {
      const admin = {
        id: this.data.meta.nextUserId++,
        email: config.adminEmail,
        passwordHash: hashPassword(config.adminPassword),
        role: 'admin',
        name: 'Ntandomods Admin',
        createdAt: new Date().toISOString(),
      };
      this.data.users.push(admin);
      await this.save();
      console.log(`[store] seeded admin ${admin.email}`);
    }
    return this;
  }

  // atomic write: tmp file + rename, chained to avoid interleaved saves
  async save() {
    const run = async () => {
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    };
    this.saving = this.saving.then(run, run);
    return this.saving;
  }

  // ── users ───────────────────────────────────────────────────────
  async createUser({ email, password, name, role = 'user' }) {
    email = String(email).toLowerCase().trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('invalid email');
    if (this.data.users.some((u) => u.email === email)) throw new Error('email already registered');
    if (String(password).length < 8) throw new Error('password must be at least 8 characters');
    const user = {
      id: this.data.meta.nextUserId++,
      email,
      name: String(name || email.split('@')[0]).slice(0, 80),
      passwordHash: hashPassword(password),
      role: role === 'admin' ? 'admin' : 'user',
      createdAt: new Date().toISOString(),
    };
    this.data.users.push(user);
    await this.save();
    return { ...user, passwordHash: undefined };
  }

  async getByEmail(email) {
    const u = this.data.users.find((u) => u.email === String(email).toLowerCase().trim());
    return u ? { ...u } : null;
  }
  async getUser(id) {
    const u = this.data.users.find((u) => u.id === Number(id));
    return u ? { ...u } : null;
  }
  async listUsers() {
    return this.data.users.map((u) => ({ ...u, passwordHash: undefined }));
  }
  async updateUser(id, patch) {
    const u = this.data.users.find((u) => u.id === Number(id));
    if (!u) return null;
    if (patch.name) u.name = String(patch.name).slice(0, 80);
    if (patch.role && ['admin', 'user'].includes(patch.role)) u.role = patch.role;
    if (patch.password) {
      if (String(patch.password).length < 8) throw new Error('password must be at least 8 characters');
      u.passwordHash = hashPassword(patch.password);
    }
    await this.save();
    return { ...u, passwordHash: undefined };
  }
  async deleteUser(id) {
    id = Number(id);
    if (!this.data.users.some((u) => u.id === id)) return false;
    this.data.users = this.data.users.filter((u) => u.id !== id);
    // cascade: delete owned bots + keys of the deleted user
    this.data.bots = this.data.bots.filter((b) => b.ownerId !== id);
    this.data.apiKeys = this.data.apiKeys.filter((k) => k.userId !== id);
    await this.save();
    return true;
  }

  // ── bots ────────────────────────────────────────────────────────
  _slugify(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'bot';
  }
  _uniqueSlug(base) {
    if (!this.data.bots.some((b) => b.slug === base)) return base;
    let n = 2;
    while (this.data.bots.some((b) => b.slug === `${base}-${n}`)) n++;
    return `${base}-${n}`;
  }
  _sanitizeEnv(env) {
    const out = {};
    for (const [k, v] of Object.entries(env || {})) {
      if (!ENV_NAME_RE.test(k)) continue;
      const val = String(v).slice(0, 2000);
      if (val.length > 0) out[k] = val;
    }
    return out;
  }
  _nextFreePort() {
    const used = new Set(this.data.bots.map((b) => b.port));
    for (let p = PORT_POOL_START; p < PORT_POOL_START + PORT_POOL_SIZE; p++) {
      if (!used.has(p)) return p;
    }
    throw new Error('port pool exhausted');
  }

  async createBot({ name, ownerId, template, env = {}, autoRestart = true, memoryLimitMb = 0 }) {
    if (this.data.bots.length >= config.maxBots) throw new Error(`bot limit reached (${config.maxBots})`);
    name = String(name).trim().slice(0, 60);
    if (name.length < 2) throw new Error('bot name must be at least 2 characters');
    const bot = {
      id: this.data.meta.nextBotId++,
      slug: this._uniqueSlug(this._slugify(name)),
      name,
      ownerId: ownerId == null ? null : Number(ownerId),
      template,
      env: this._sanitizeEnv(env),
      port: this._nextFreePort(),
      memoryLimitMb: Number(memoryLimitMb) || 0,
      autoRestart: !!autoRestart,
      status: 'created',
      restarts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.data.bots.push(bot);
    await this.save();
    return { ...bot };
  }

  async getBot(idOrSlug) {
    const key = String(idOrSlug);
    const b = this.data.bots.find((b) => b.slug === key || b.id === Number(key));
    return b ? { ...b } : null;
  }

  async listBots({ ownerId } = {}) {
    const list = this.data.bots
      .map((b) => ({ ...b }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (ownerId == null) return list;
    return list.filter((b) => b.ownerId === Number(ownerId));
  }

  async updateBot(id, patch) {
    const b = this.data.bots.find((b) => b.id === Number(id));
    if (!b) return null;
    const allowed = ['name', 'env', 'autoRestart', 'memoryLimitMb', 'status', 'template', 'port', 'restarts'];
    for (const k of allowed) {
      if (patch[k] !== undefined) b[k] = patch[k];
    }
    if (patch.env) b.env = this._sanitizeEnv(patch.env);
    b.updatedAt = new Date().toISOString();
    await this.save();
    return { ...b };
  }

  async deleteBot(id) {
    id = Number(id);
    const before = this.data.bots.length;
    this.data.bots = this.data.bots.filter((b) => b.id !== id);
    if (this.data.bots.length === before) return false;
    this.data.deployments = this.data.deployments.filter((d) => d.botId !== id);
    await this.save();
    return true;
  }

  // ── api keys ────────────────────────────────────────────────────
  async createApiKey({ userId, name = 'api-key' }) {
    const key = 'ntando_' + crypto.randomBytes(24).toString('base64url');
    const record = {
      id: this.data.meta.nextKeyId++,
      userId: Number(userId),
      name: String(name).slice(0, 60) || 'api-key',
      prefix: key.slice(0, 13),
      keyHash: hashApiKey(key),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.data.apiKeys.push(record);
    await this.save();
    return { id: record.id, name: record.name, prefix: record.prefix, createdAt: record.createdAt, key }; // full key shown ONCE
  }

  async findApiKeyByHash(hash) {
    const k = this.data.apiKeys.find((k) => k.keyHash === hash && !k.revokedAt);
    return k ? { ...k } : null;
  }
  async touchApiKey(id) {
    const k = this.data.apiKeys.find((k) => k.id === Number(id));
    if (k) {
      k.lastUsedAt = new Date().toISOString();
      await this.save();
    }
  }
  async listApiKeys(userId) {
    return this.data.apiKeys.filter((k) => !k.revokedAt && k.userId === Number(userId)).map((k) => ({ ...k, keyHash: undefined }));
  }
  async revokeApiKey(id, userId) {
    const k = this.data.apiKeys.find((k) => k.id === Number(id) && k.userId === Number(userId));
    if (!k || k.revokedAt) return false;
    k.revokedAt = new Date().toISOString();
    await this.save();
    return true;
  }

  // ── deployments (pipeline records) ──────────────────────────────
  async addDeployment({ botId, ownerId, trigger, template, name }) {
    const dep = {
      id: this.data.meta.nextDeploymentId++,
      botId: Number(botId),
      ownerId: ownerId == null ? null : Number(ownerId),
      trigger,
      template,
      name,
      status: 'pending',
      steps: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.data.deployments.unshift(dep);
    if (this.data.deployments.length > 200) this.data.deployments.length = 200; // prune
    await this.save();
    return { ...dep };
  }
  async getDeployment(id) {
    const idN = Number(id);
    const d = this.data.deployments.find((d) => d.id === idN);
    return d ? { ...d } : null;
  }
  async updateDeployment(id, patch) {
    const idN = Number(id);
    const d = this.data.deployments.find((d) => d.id === idN);
    if (!d) return null;
    for (const k of ['status', 'steps', 'error', 'trigger']) {
      if (patch[k] !== undefined) d[k] = patch[k];
    }
    if (['running', 'failed', 'stopped'].includes(d.status)) d.finishedAt = new Date().toISOString();
    await this.save();
    return { ...d };
  }
  async listDeployments({ limit = 50, botId } = {}) {
    let list = this.data.deployments.map((d) => ({ ...d }));
    if (botId != null) list = list.filter((d) => d.botId === Number(botId));
    return list.slice(0, Number(limit) || 50);
  }
}

module.exports = { Store };
