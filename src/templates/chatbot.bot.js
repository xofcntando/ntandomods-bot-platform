'use strict';
// Ntandomods Bot Platform — chatbot template
// A conversational assistant that can also manage the platform via chat commands.
// HTTP surface: GET / (chat UI), POST /chat, GET /api/stats

const host = require('../bots/host');
const spec = host.loadSpec();
const E = spec.env;

const BOT_NAME = E.BOT_NAME || 'Ntando Assistant';
const PERSONALITY = E.PERSONALITY || 'helpful, concise, a little playful';

// ---------- sessions ----------
const sessions = new Map();
function getSession(id) {
  let key = String(id || 'anon').slice(0, 40);
  let s = sessions.get(key);
  if (!s) {
    s = { id: key, messages: [], createdAt: Date.now() };
    sessions.set(key, s);
    if (sessions.size > 200) sessions.delete(sessions.keys().next().value);
  }
  return s;
}

const counters = { messagesHandled: 0, commandsRun: 0 };

// ---------- command handlers ----------
const greeting = async () =>
  `${BOT_NAME} 👋 — your platform assistant.\n\n` +
  `I can run the whole platform from this chat. Try:\n` +
  `• status — live bot overview\n` +
  `• templates — installable bot types\n` +
  `• deploy <name> <template>\n` +
  `• logs / restart / stop <slug>\n` +
  `• subdomain — how bot URLs work\n` +
  `• limits — platform capacity\n\n` +
  `Or just talk to me — I'm ${PERSONALITY}.`;

const helpText = async () =>
  `Commands I understand:\n` +
  `• hi / menu — this greeting\n` +
  `• help — this list\n` +
  `• status — all bots with runtime stats\n` +
  `• deploy <name> [template] — deploy a new bot\n` +
  `• templates — available templates\n` +
  `• logs <slug> — last log lines\n` +
  `• restart <slug> / stop <slug>\n` +
  `• subdomain — URL routing explained\n` +
  `• limits — capacity + resource usage`;

const statusCommand = async () => {
  const res = await host.platformCall('listBots', {});
  if (!res.bots || !res.bots.length) return 'No bots deployed yet. Try: deploy My Monitor monitor';
  const lines = res.bots.map(
    (b) =>
      `• ${b.slug} [${b.runtime?.status || b.status}]` +
      (b.runtime?.rssMb ? ` · ${b.runtime.rssMb}MB` : '') +
      (b.template ? ` · ${b.template}` : '')
  );
  return `Bots on this platform:\n${lines.join('\n')}`;
};

const deployCommand = async (m, name, template) => {
  const tpl = template || 'monitor';
  const res = await host.platformCall('createBot', {
    name: String(name).trim(),
    template: tpl,
    env: {},
    autoRestart: true,
  });
  const started = await host.platformCall('startBot', { slug: res.bot.slug });
  return (
    `🚀 Deployed **${res.bot.name}** (${tpl})\n` +
    `slug: ${res.bot.slug}\n` +
    `pid ${started.started.pid} on port ${res.bot.port}\n` +
    `live: ${started.liveUrl}`
  );
};

const logsCommand = async (m, slug) => {
  const res = await host.platformCall('botLogs', { slug, tail: 12 });
  if (!res.logs || !res.logs.length) return `No log lines yet for ${slug}.`;
  return res.logs.map((l) => (/(error|fatal|crash)/i.test(l) ? `⛔ ${l}` : ` ${l}`)).join('\n');
};

const restartCommand = async (m, slug) => {
  await host.platformCall('restartBot', { slug });
  return `🔄 ${slug} restarting — back up in a moment.`;
};

const stopCommand = async (m, slug) => {
  await host.platformCall('stopBot', { slug });
  return `⏹ ${slug} stopped. Restart any time with: restart ${slug}`;
};

const templatesCommand = async () => {
  const res = await host.platformCall('listTemplates', {});
  return (
    'Installable bot types:\n' +
    res.templates.map((t) => `• ${t.icon} ${t.key} — ${t.summary}`).join('\n')
  );
};

const subdomainCommand = async () =>
  spec.platform && spec.platform.subdomains
    ? `Every bot gets its own subdomain: https://<slug>.${spec.platform.rootDomain}/\n` +
      `A path fallback also works: ${spec.platform.baseUrl}/live/<slug>/`
    : `Every bot is served under: ${spec.platform.baseUrl}/live/<slug>/\n` +
      `Set ROOT_DOMAIN in the platform .env to also route <slug>.yourdomain.com (wildcard DNS + TLS required).`;

const limitsCommand = async () => {
  const res = await host.platformCall('supervisorStats', {});
  const s = res.stats;
  return (
    `Platform capacity:\n` +
    `• bots: ${s.running}/${s.botsTotal} running (${s.crashed} crashed)\n` +
    `• restarts this session: ${s.totalRestarts}\n` +
    `• aggregate memory: ${s.aggregateRssMb}MB\n` +
    `• bot limit: ${s.maxBots || 'unlimited'}\n` +
    `Each bot gets its own port, process and memory watchdog.`
  );
};

// ---------- intent matching ----------
const INTENTS = [
  { re: /^(hi|hello|hey|yo|start|menu)\b/i, fn: greeting },
  { re: /^help\b/i, fn: helpText },
  { re: /^status\b/i, fn: statusCommand },
  { re: /^deploy\s+([\w -]+?)(?:\s+(monitor|deploy|healthcheck|chatbot))?\s*$/i, fn: deployCommand },
  { re: /^logs?\s+([\w-]+)\s*$/i, fn: logsCommand },
  { re: /^restart\s+([\w-]+)\s*$/i, fn: restartCommand },
  { re: /^stop\s+([\w-]+)\s*$/i, fn: stopCommand },
  { re: /^templates?\b/i, fn: templatesCommand },
  { re: /^subdomain\b/i, fn: subdomainCommand },
  { re: /^limits?\b/i, fn: limitsCommand },
];

async function reply(message) {
  const text = String(message || '').trim().slice(0, 500);
  counters.messagesHandled++;
  for (const intent of INTENTS) {
    const m = text.match(intent.re);
    if (m) {
      counters.commandsRun++;
      try {
        return await intent.fn(m, ...m.slice(1));
      } catch (err) {
        return `⚠️ ${err.message || 'that command failed'} — try "help".`;
      }
    }
  }
  return (
    `I didn't quite catch that. I'm ${PERSONALITY} — try "help" for the command list.\n` +
    `Popular: status · templates · deploy <name> monitor`
  );
}

// ---------- chat UI ----------
function chatPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${BOT_NAME} — Ntandomods</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0b0e14; color: #e6edf3; font-family: system-ui, -apple-system, sans-serif;
         min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .wrap { width: 100%; max-width: 560px; padding: 16px; }
  h1 { font-size: 18px; color: #22d3ee; margin-bottom: 4px; }
  p.sub { color: #8b949e; font-size: 12px; margin-bottom: 14px; }
  #log { display: flex; flex-direction: column; gap: 8px; height: 60vh; min-height: 360px;
         overflow-y: auto; padding: 14px; background: #11151c; border: 1px solid #1f2630;
         border-radius: 12px; }
  .u, .b { max-width: 82%; padding: 9px 12px; border-radius: 12px; font-size: 14px;
           white-space: pre-wrap; word-break: break-word; line-height: 1.45; }
  .u { align-self: flex-end; background: linear-gradient(135deg, #0891b2, #0e7490); color: #fff; border-bottom-right-radius: 4px; }
  .b { align-self: flex-start; background: #1c2431; border: 1px solid #2d3748; border-bottom-left-radius: 4px; }
  form { display: flex; gap: 8px; margin-top: 12px; }
  input { flex: 1; background: #11151c; border: 1px solid #2d3748; color: #e6edf3;
          padding: 11px 13px; border-radius: 10px; font-size: 14px; outline: none; }
  input:focus { border-color: #22d3ee; }
  button { background: linear-gradient(135deg, #22d3ee, #a78bfa); color: #0b0e14; font-weight: 700;
           border: none; padding: 11px 18px; border-radius: 10px; cursor: pointer; font-size: 14px; }
  button:hover { filter: brightness(1.1); }
</style>
</head>
<body>
<div class="wrap">
  <h1>🤖 ${BOT_NAME}</h1>
  <p class="sub">Ntandomods bot platform · chat assistant · try "status" or "deploy My Bot monitor"</p>
  <div id="log"></div>
  <form id="f">
    <input id="msg" autocomplete="off" placeholder="Type a message or command…">
    <button type="submit">Send</button>
  </form>
</div>
<script>
  const log = document.getElementById('log');
  const session = 'sess-' + Math.random().toString(36).slice(2, 12);
  function add(text, who) {
    const div = document.createElement('div');
    div.className = who === 'u' ? 'u' : 'b';
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
  async function send(v) {
    add(v, 'u');
    try {
      const r = await fetch('chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: v, session: session })
      });
      const d = await r.json();
      add(d.reply || '(no reply)', 'b');
    } catch (e) { add('network error — is the platform up?', 'b'); }
  }
  document.getElementById('f').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const el = document.getElementById('msg');
    const v = el.value.trim();
    if (v) { el.value = ''; send(v); }
  });
  send('hi');
</script>
</body>
</html>`;
}

// ---------- HTTP ----------
host.http(async (req, res, parts) => {
  const { path, method } = parts;

  if (method === 'GET' && (path === '/' || path === '')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(chatPage());
    return;
  }

  if (method === 'GET' && path === '/api/stats') {
    return host.sendJson(res, 200, {
      bot: spec.slug,
      name: BOT_NAME,
      personality: PERSONALITY,
      messagesHandled: counters.messagesHandled,
      commandsRun: counters.commandsRun,
      activeSessions: sessions.size,
    });
  }

  if (method === 'POST' && path === '/chat') {
    const body = await host.readBody(req);
    const message = body && body.message;
    if (typeof message !== 'string' || !message.trim()) {
      return host.sendJson(res, 400, { error: 'message required' });
    }
    const answer = await reply(message);
    const s = getSession(body.session);
    s.messages.push({ from: 'user', text: message, at: Date.now() });
    s.messages.push({ from: 'bot', text: answer, at: Date.now() });
    if (s.messages.length > 20) s.messages.splice(0, s.messages.length - 20);
    return host.sendJson(res, 200, { reply: answer, bot: spec.slug });
  }

  return host.sendJson(res, 404, {
    error: 'not found',
    endpoints: ['GET /', 'POST /chat', 'GET /api/stats'],
  });
});

host.ready({ messagesHandled: 0, commandsRun: 0 });
