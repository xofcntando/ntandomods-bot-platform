// ── Template registry: bot blueprints the platform can deploy ───
'use strict';

// A template defines: entry file, env fields it accepts, whether it
// exposes HTTP, and validation rules. All entries live in src/templates/.

const TEMPLATES = {
  monitor: {
    key: 'monitor',
    name: 'Site Monitor',
    category: 'monitoring',
    icon: '📡',
    summary: 'Periodically checks HTTP(S) targets and exposes a status page + JSON API.',
    entry: 'monitor.bot.js',
    exposesHttp: true,
    defaultEnv: { TARGETS: 'https://example.com,https://nodejs.org', CHECK_INTERVAL_SEC: '30', TIMEOUT_MS: '5000', HISTORY_SIZE: '50' },
    fields: [
      { name: 'TARGETS', label: 'Targets (comma-separated URLs)', type: 'text', required: true, placeholder: 'https://example.com,https://nodejs.org' },
      { name: 'CHECK_INTERVAL_SEC', label: 'Check interval (seconds)', type: 'number', default: 30 },
      { name: 'TIMEOUT_MS', label: 'Timeout per check (ms)', type: 'number', default: 5000 },
      { name: 'HISTORY_SIZE', label: 'History size', type: 'number', default: 100 },
    ],
  },
  deploy: {
    key: 'deploy',
    name: 'Deploy Automation',
    category: 'deployment',
    icon: '🚀',
    summary: 'Creates and starts sibling bots through the platform pipeline (API-driven).',
    entry: 'deploy.bot.js',
    exposesHttp: true,
    defaultEnv: { DEFAULT_TEMPLATE: 'monitor' },
    fields: [
      { name: 'DEFAULT_TEMPLATE', label: 'Default template for new bots', type: 'select', options: ['monitor', 'deploy', 'healthcheck', 'chatbot'], default: 'monitor' },
    ],
  },
  healthcheck: {
    key: 'healthcheck',
    name: 'Health Auditor',
    category: 'health-check',
    icon: '🩺',
    summary: 'Audits all your bots + the platform supervisor and records anomalies.',
    entry: 'healthcheck.bot.js',
    exposesHttp: true,
    defaultEnv: { CHECK_INTERVAL_SEC: '60' },
    fields: [
      { name: 'CHECK_INTERVAL_SEC', label: 'Audit interval (seconds)', type: 'number', default: 60 },
    ],
  },
  chatbot: {
    key: 'chatbot',
    name: 'Chat Assistant',
    category: 'chatbot',
    icon: '💬',
    summary: 'Natural-language assistant that can deploy, inspect, and control your bots.',
    entry: 'chatbot.bot.js',
    exposesHttp: true,
    defaultEnv: { BOT_NAME: 'Ntando Assistant', PERSONALITY: 'helpful, concise, a little playful' },
    fields: [
      { name: 'BOT_NAME', label: 'Assistant name', type: 'text', default: 'Ntando Assistant' },
      { name: 'PERSONALITY', label: 'Personality', type: 'text', default: 'helpful, concise, a little playful' },
    ],
  },
};

function get(key) {
  const t = TEMPLATES[key];
  if (!t) throw new Error(`unknown template: ${key}`);
  return t;
}
function list() {
  return Object.values(TEMPLATES);
}
function validate(key, env) {
  get(key);
  if (key === 'monitor') {
    const targets = String((env && env.TARGETS) || '').trim();
    if (!targets) throw new Error('monitor requires at least one target (TARGETS)');
    for (const u of targets.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!/^https?:\/\//i.test(u)) throw new Error(`target must be http(s) URL: ${u}`);
    }
  }
  return true;
}

module.exports = { get, list, validate, TEMPLATES };
