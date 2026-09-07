/* Ntandomods Bot Platform — dashboard client */
'use strict';
(() => {

  // ---------- state ----------
  const S = {
    token: localStorage.getItem('ntando_token') || null,
    user: JSON.parse(localStorage.getItem('ntando_user') || 'null'),
    bots: [],
    keys: [],
    deps: [],
    stats: null,
    templates: [],
    chat: { bot: null, initing: false, msgs: [] },
    polls: { bots: null, logs: null },
  };

  const $ = (id) => document.getElementById(id);

  // ---------- helpers ----------
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (S.token) headers.Authorization = `Bearer ${S.token}`;
    const r = await fetch(path, { ...opts, headers });
    let d = null;
    try { d = await r.json(); } catch { d = null; }
    if (r.status === 401) { logout(); throw new Error((d && d.error) || 'session expired'); }
    if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
    return d;
  }

  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $('toastZone').appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtAgo(ts) {
    if (!ts) return '—';
    const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  // ---------- auth ----------
  function logout() {
    S.token = null; S.user = null;
    localStorage.removeItem('ntando_token');
    localStorage.removeItem('ntando_user');
    if (S.polls.bots) clearInterval(S.polls.bots);
    $('appView').classList.remove('on');
    $('loginView').style.display = 'flex';
  }

  async function doLogin(ev) {
    ev.preventDefault();
    const email = $('loginEmail').value.trim();
    const password = $('loginPassword').value;
    $('loginErr').textContent = '';
    try {
      const d = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      S.token = d.token; S.user = d.user;
      localStorage.setItem('ntando_token', d.token);
      localStorage.setItem('ntando_user', JSON.stringify(d.user));
      enterApp();
    } catch (err) {
      $('loginErr').textContent = err.message;
    }
  }

  function enterApp() {
    $('loginView').style.display = 'none';
    $('appView').classList.add('on');
    $('whoami').innerHTML = `<b>${esc(S.user.email)}</b> · ${esc(S.user.role)}`;
    boot();
  }

  // ---------- boot / refresh ----------
  async function boot() {
    try {
      const t = await api('/api/templates');
      S.templates = t.templates;
    } catch (err) { toast(err.message, 'err'); return; }
    await refreshAll();
    if (!S.polls.bots) S.polls.bots = setInterval(refreshAll, 5000);
    chatInit();
  }

  async function refreshAll() {
    try {
      const [b, s] = await Promise.all([
        api('/api/bots'),
        api('/api/stats'),
      ]);
      S.bots = b.bots; S.stats = s.stats;
      renderStats(); renderBots();
      if ($('depsPanel').open) renderDeployments();
      if ($('keysPanel').open) renderKeys();
    } catch (err) { /* transient */ }
  }

  // ---------- renderers ----------
  function renderStats() {
    const s = S.stats;
    if (!s) return;
    $('statBots').textContent = s.botsTotal;
    $('statRunning').textContent = s.running;
    $('statCrashed').textContent = s.crashed;
    $('statRestarts').textContent = s.totalRestarts;
    $('statMem').textContent = `${s.aggregateRssMb}MB`;
    $('statUsers').textContent = s.users;
  }

  const STATUS_ICON = { running: '🟢', starting: '🟡', crashed: '🔴', stopped: '⚪', created: '🔵' };

  function renderBots() {
    const grid = $('botGrid');
    if (!S.bots.length) {
      grid.innerHTML = '<div class="empty">No bots yet — click <b>+ New Bot</b> to deploy your first one.</div>';
      return;
    }
    grid.innerHTML = S.bots.map((b) => {
      const rt = b.runtime || {};
      const status = rt.status || b.status || 'created';
      const tpl = S.templates.find((t) => t.key === b.template);
      const lines = [
        `<div class="meta">template <b>${esc(b.template)}</b> · port <b>${b.port}</b> · pid <b>${rt.pid || '—'}</b></div>`,
        `<div class="meta">uptime <b>${rt.uptimeSec != null ? rt.uptimeSec + 's' : '—'}</b> · rss <b>${rt.rssMb != null ? rt.rssMb + 'MB' : '—'}</b> · restarts <b>${rt.restarts || 0}</b></div>`,
        `<div class="meta"><a href="${esc(b.liveUrl)}" target="_blank" rel="noopener">${esc(b.liveUrl)}</a></div>`,
      ].join('');
      const actions = [
        `<button class="btn" data-act="logs" data-id="${b.id}">Logs</button>`,
        `<a class="btn" style="text-decoration:none;display:inline-block" href="${esc(b.liveUrl)}" target="_blank" rel="noopener">Live</a>`,
        status === 'running' || status === 'starting'
          ? `<button class="btn" data-act="restart" data-id="${b.id}">Restart</button>
             <button class="btn danger" data-act="stop" data-id="${b.id}">Stop</button>`
          : `<button class="btn primary" data-act="start" data-id="${b.id}">Start</button>`,
        `<button class="btn danger" data-act="delete" data-id="${b.id}">Delete</button>`,
      ].join('');
      return `<div class="botcard">
        <div class="row1">
          <div class="icon">${STATUS_ICON[status] || '⚪'}</div>
          <div class="name">${esc(b.name)}</div>
          <span class="badge ${esc(status)}">${esc(status)}</span>
        </div>
        <div class="meta">slug <b>${esc(b.slug)}</b></div>
        ${lines}
        <div class="btns">${actions}</div>
      </div>`;
    }).join('');
  }

  function renderKeys() {
    const t = $('keyTable');
    if (!S.keys.length) {
      t.innerHTML = '<tr><td colspan="4" class="dim">No API keys — create one for programmatic access.</td></tr>';
      return;
    }
    t.innerHTML = S.keys.map((k) => `<tr>
      <td>${esc(k.name)}</td>
      <td class="mono">${esc(k.prefix)}…</td>
      <td class="dim">${fmtAgo(k.createdAt)}</td>
      <td><button class="btn danger" onclick="window.__revokeKey(${k.id}, '${esc(k.name)}')">Revoke</button></td>
    </tr>`).join('');
  }

  function renderDeployments() {
    const t = $('depTable');
    if (!S.deps.length) {
      t.innerHTML = '<tr><td colspan="4" class="dim">No deployments yet.</td></tr>';
      return;
    }
    t.innerHTML = S.deps.slice(0, 12).map((d) => {
      const bot = S.bots.find((b) => b.id === d.botId);
      return `<tr>
        <td>${d.id}</td>
        <td>${esc(bot ? bot.slug : d.botId)}</td>
        <td class="dim">${esc(d.trigger)}</td>
        <td class="${d.status === 'running' || d.status === 'finished' ? 'ok' : d.status === 'failed' ? 'bad' : 'dim'}">${esc(d.status)}</td>
        <td class="dim">${fmtAgo(d.createdAt)}</td>
      </tr>`;
    }).join('');
  }

  async function loadDeps() {
    try {
      const d = await api('/api/deployments?limit=20');
      S.deps = d.deployments;
    } catch { S.deps = []; }
  }

  // ---------- bot actions ----------
  async function botAction(act, id) {
    const b = S.bots.find((x) => x.id === id);
    if (!b) return;
    try {
      if (act === 'delete') {
        if (!confirm(`Delete ${b.name} (${b.slug})? This removes it permanently.`)) return;
        await api(`/api/bots/${id}`, { method: 'DELETE' });
        toast(`${b.slug} deleted`, 'ok');
      } else if (act === 'logs') {
        openLogs(b);
      } else if (act === 'start' || act === 'stop' || act === 'restart') {
        await api(`/api/bots/${id}/${act}`, { method: 'POST' });
        toast(`${b.slug} ${act}ed`, 'ok');
      }
      refreshAll();
    } catch (err) { toast(err.message, 'err'); }
  }

  // ---------- modals ----------
  function closeModal(id) {
    $(id).classList.remove('on');
    if (S.polls.logs) { clearInterval(S.polls.logs); S.polls.logs = null; }
    if (id === 'logModal') { $(id).classList.remove('on'); }
  }

  function openLogs(b) {
    $('logTitle').textContent = `Logs — ${b.slug}`;
    $('logBox').textContent = 'loading…';
    $('logModal').classList.add('on');
    const fetchLogs = async () => {
      try {
        const d = await api(`/api/bots/${b.id}/logs?tail=150`);
        $('logBox').innerHTML = d.logs.map((l) => {
          const cls = /(error|fatal|crash|⛔)/i.test(l) ? 'err' : /(ready|running|started|✅)/i.test(l) ? 'ok' : '';
          return `<div class="${cls}">${esc(l)}</div>`;
        }).join('') || '<div class="dim">no output yet</div>';
        const box = $('logBox');
        box.scrollTop = box.scrollHeight;
      } catch (err) { /* transient */ }
    };
    fetchLogs();
    if (S.polls.logs) clearInterval(S.polls.logs);
    S.polls.logs = setInterval(fetchLogs, 2000);
  }

  function openWizard() {
    S.wizard = { template: null };
    $('wizardTplGrid').innerHTML = S.templates.map((t) => `
      <div class="tpl" data-key="${t.key}">
        <div class="t">${t.icon} ${esc(t.name)}</div>
        <div class="s">${esc(t.summary)}</div>
      </div>`).join('');
    $('botName').value = '';
    $('botAutoRestart').checked = true;
    $('tplFields').innerHTML = '';
    renderTplFields(null);
    $('wizardModal').classList.add('on');
  }

  function renderTplFields(key) {
    const box = $('tplFields');
    if (!key) { box.innerHTML = '<div class="dim" style="font-size:12px;margin-top:8px">Pick a template to configure it.</div>'; return; }
    const tpl = S.templates.find((t) => t.key === key);
    if (!tpl || !tpl.fields || !tpl.fields.length) {
      box.innerHTML = '<div class="dim" style="font-size:12px;margin-top:8px">This template needs no configuration.</div>';
      return;
    }
    box.innerHTML = tpl.fields.map((f) => `
      <div class="field">
        <label class="fl">${esc(f.label)}${f.required ? ' *' : ''} <span class="dim">(${esc(f.key)})</span></label>
        <input id="fld_${esc(f.key)}" placeholder="${esc(f.placeholder || f.key)}">
      </div>`).join('');
  }

  async function deployBot() {
    if (!S.wizard.template) { toast('pick a template first', 'err'); return; }
    const name = $('botName').value.trim();
    if (!name) { toast('bot name required', 'err'); return; }
    const tpl = S.templates.find((t) => t.key === S.wizard.template);
    const env = {};
    let missing = false;
    (tpl.fields || []).forEach((f) => {
      const el = $(`fld_${f.key}`);
      if (!el) return;
      const v = el.value.trim();
      if (f.required && !v) missing = true;
      if (v) env[f.key] = v;
    });
    if (missing) { toast('fill required fields', 'err'); return; }
    $('deployBtn').disabled = true;
    $('deployBtn').textContent = 'Deploying…';
    try {
      const d = await api('/api/bots', {
        method: 'POST',
        body: JSON.stringify({
          name,
          template: S.wizard.template,
          env,
          autoRestart: $('botAutoRestart').checked,
        }),
      });
      toast(`${d.bot.slug} deployed — pid ${d.started ? d.started.pid : '—'}`, 'ok');
      closeModal('wizardModal');
      await refreshAll();
      const b = S.bots.find((x) => x.id === d.bot.id);
      if (b) openLogs(b);
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      $('deployBtn').disabled = false;
      $('deployBtn').textContent = 'Deploy';
    }
  }

  async function createKey() {
    const name = $('keyName').value.trim() || 'api key';
    try {
      const d = await api('/api/keys', { method: 'POST', body: JSON.stringify({ name }) });
      $('keyName').value = '';
      $('secretBox').style.display = 'flex';
      $('secretValue').textContent = d.secret;
      renderKeysAfterCreate(d.key);
      toast('API key created — copy it now', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  function renderKeysAfterCreate(key) {
    S.keys.unshift(key);
    renderKeys();
  }

  async function revokeKey(id, name) {
    if (!confirm(`Revoke key "${name}"? Bots using it lose access.`)) return;
    try {
      await api(`/api/keys/${id}`, { method: 'DELETE' });
      S.keys = S.keys.filter((k) => k.id !== id);
      renderKeys();
      toast('key revoked', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }
  window.__revokeKey = revokeKey;

  // ---------- chat widget ----------
  async function chatInit() {
    if (S.chat.initing) return;
    S.chat.initing = true;
    try {
      // find or deploy the assistant chatbot
      let bot = S.bots.find((b) => b.template === 'chatbot');
      if (!bot) {
        const d = await api('/api/bots', {
          method: 'POST',
          body: JSON.stringify({ name: 'Dashboard Assistant', template: 'chatbot', env: {}, autoRestart: true }),
        });
        bot = d.bot;
      }
      // wait until running
      for (let i = 0; i < 10; i++) {
        const st = await api(`/api/bots/${bot.id}/stats`);
        if (st.runtime && ['running', 'starting'].includes(st.runtime.status)) break;
        await new Promise((r) => setTimeout(r, 600));
      }
      S.chat.bot = bot;
      chatAdd(`${bot.name} ready — try "status" or "deploy My Bot monitor"`, 'b');
    } catch (err) {
      chatAdd('assistant unavailable — deploy a chatbot manually', 'b');
    } finally {
      S.chat.initing = false;
    }
  }

  function chatAdd(text, who) {
    const log = $('chatLog');
    const div = document.createElement('div');
    div.className = who;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  async function chatSend(ev) {
    ev.preventDefault();
    if (!S.chat.bot) { toast('assistant not ready yet', 'err'); return; }
    const el = $('chatInput');
    const v = el.value.trim();
    if (!v) return;
    el.value = '';
    chatAdd(v, 'u');
    try {
      const r = await fetch(`${S.chat.bot.liveUrl}chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: v, session: 'dashboard' }),
      });
      const d = await r.json();
      chatAdd(d.reply || '(no reply)', 'b');
    } catch (err) {
      chatAdd('network error — bot not running?', 'b');
    }
  }

  // ---------- wire up ----------
  function wire() {
    $('loginForm').addEventListener('submit', doLogin);
    $('loginForm').addEventListener('submit', function once() { }, { once: true });
    $('logoutBtn').addEventListener('click', logout);
    $('newBotBtn').addEventListener('click', openWizard);
    $('deployBtn').addEventListener('click', deployBot);
    $('keyCreateBtn').addEventListener('click', createKey);
    $('chatFab').addEventListener('click', () => {
      $('chatWidget').classList.toggle('on');
      $('chatFab').style.display = $('chatWidget').classList.contains('on') ? 'none' : 'block';
    });
    $('chatClose').addEventListener('click', () => {
      $('chatWidget').classList.remove('on');
      $('chatFab').style.display = 'block';
    });
    $('chatForm').addEventListener('submit', chatSend);

    $('botGrid').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      botAction(btn.dataset.act, Number(btn.dataset.id));
    });

    $('wizardTplGrid').addEventListener('click', (ev) => {
      const t = ev.target.closest('.tpl');
      if (!t) return;
      S.wizard.template = t.dataset.key;
      document.querySelectorAll('#wizardTplGrid .tpl').forEach((el) => el.classList.toggle('sel', el === t));
      renderTplFields(t.dataset.key);
    });

    ['logModal', 'wizardModal', 'keyModal'].forEach((id) => {
      const bg = $(id);
      bg.addEventListener('click', (ev) => { if (ev.target === bg) closeModal(id); });
    });
    document.querySelectorAll('[data-close]').forEach((el) => {
      el.addEventListener('click', () => closeModal(el.dataset.close));
    });

    $('keysPanel').addEventListener('toggle', () => {
      if ($('keysPanel').open) api('/api/keys').then((d) => { S.keys = d.keys; renderKeys(); }).catch(() => {});
    });
    $('depsPanel').addEventListener('toggle', () => {
      if ($('depsPanel').open) loadDeps().then(renderDeployments).catch(() => {});
    });
  }

  // ---------- go ----------
  wire();
  if (S.token && S.user) enterApp();
  else $('loginView').style.display = 'flex';
})();
