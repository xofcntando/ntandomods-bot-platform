// ── Configuration + tiny dotenv loader (zero dependencies) ───────
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load ../.env if present. Never overrides real environment variables.
(function loadDotenv() {
  const envPath = path.join(__dirname, '..', '.env');
  try {
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
  } catch (_) { /* .env is optional */ }
})();

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}
function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

const port = num('PORT', 3000);
const baseUrl = env('BASE_URL', `http://localhost:${port}`).replace(/\/+$/, '');
let rootDomain = env('ROOT_DOMAIN', '').toLowerCase().trim();
if (rootDomain.startsWith('*.')) rootDomain = rootDomain.slice(2);
rootDomain = rootDomain.replace(/\.$/, '');
const jwtSecret = env('JWT_SECRET', 'ntandomods-dev-secret-change-me');

const config = {
  port,
  baseUrl,
  rootDomain, // '' → path-mode only
  adminEmail: env('ADMIN_EMAIL', 'admin@ntandomods.local'),
  adminPassword: env('ADMIN_PASSWORD', 'admin123'),
  jwtSecret,
  dataDir: env('DATA_DIR', 'data'),
  maxBots: num('MAX_BOTS', 50),
  backoffBaseMs: num('RESTART_BACKOFF_BASE_MS', 1000),
  backoffMaxMs: num('RESTART_BACKOFF_MAX_MS', 60000),
  memoryLimitMb: num('MEMORY_LIMIT_MB', 0),
  rateLimit: {
    max: num('RATE_LIMIT_MAX', 120),
    windowMs: num('RATE_LIMIT_WINDOW_MS', 60000),
  },
};

// Token bots use when calling back into the platform over IPC.
// Derived deterministically from JWT_SECRET unless explicitly set.
config.internalToken =
  process.env.INTERNAL_TOKEN ||
  crypto.createHash('sha256').update(jwtSecret + ':internal-api').digest('hex');

config.root = path.join(__dirname, '..');

module.exports = config;
