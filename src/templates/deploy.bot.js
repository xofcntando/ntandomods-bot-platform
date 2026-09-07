// ── deploy.bot.js — 🚀 Deploy Automation template ────────────────
// An API-driven deployer: exposes POST /jobs to create + start sibling
// bots through the platform pipeline, with recorded steps.
'use strict';

const host = require('../bots/host');

const spec = host.loadSpec();
const E = spec.env;
const DEFAULT_TEMPLATE = String(E.DEFAULT_TEMPLATE || 'monitor');

const jobs = new Map(); // jobId → job record
let jobSeq = 0;

// ── the pipeline ─────────────────────────────────────────────────
async function runPipeline({ name, template, env }, job) {
  const step = (sname, status, detail) => {
    job.steps.push({ name: sname, status, detail, at: new Date().toISOString() });
    host.log(`[job ${job.id}] ${sname}: ${status} — ${detail}`);
  };

  // 1) validate the template
  const templates = await host.platformCall('listTemplates');
  const tpl = templates.find((t) => t.key === template);
  if (!tpl) throw new Error(`unknown template "${template}"`);
  step('validate-template', 'ok', `${tpl.icon} ${tpl.name} (${template})`);

  // 2) create the bot record
  const created = await host.platformCall('createBot', { name, template, env: env || {}, autoRestart: true });
  const bot = created.bot;
  step('create-bot', 'ok', `bot "${bot.slug}" created (id ${bot.id}, port ${bot.port})`);

  // 3) record a deployment
  const depRes = await host.platformCall('addDeployment', { botId: bot.id, trigger: 'pipeline:' + spec.slug, template, name });
  step('record-deployment', 'ok', `deployment #${depRes.dep.id} recorded`);

  // 4) start it
  const started = await host.platformCall('startBot', { slug: bot.slug });
  step('start-bot', 'ok', `pid ${started.started.pid} on port ${bot.port} — ${started.liveUrl}`);

  // 5) verify it's alive
  await new Promise((r) => setTimeout(r, 700));
  const status = await host.platformCall('botStatus', { slug: bot.slug });
  const rt = status.runtime;
  if (!rt || !['running', 'starting'].includes(rt.status)) {
    throw new Error(`bot did not reach running state (status: ${rt && rt.status})`);
  }
  step('verify', 'ok', `runtime status "${rt.status}"`);

  job.status = 'succeeded';
  job.result = { bot, liveUrl: started.liveUrl };
}

async function submitJob(body) {
  const name = String(body.name || '').trim();
  const template = String(body.template || DEFAULT_TEMPLATE).trim();
  const env = body.env && typeof body.env === 'object' ? body.env : {};
  if (name.length < 2) throw new Error('name must be at least 2 characters');

  const job = {
    id: ++jobSeq,
    status: 'running',
    name,
    template,
    env,
    steps: [],
    result: null,
    error: null,
    submittedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  if (jobs.size > 100) jobs.delete(jobs.keys().next().value);

  host.log(`job ${job.id}: deploying "${name}" from template ${template}`);
  runPipeline({ name, template, env }, job)
    .catch((err) => {
      job.status = 'failed';
      job.error = err.message;
      host.logError(`job ${job.id} FAILED: ${err.message}`);
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      const ok = [...jobs.values()].filter((j) => j.status === 'succeeded').length;
      const failed = [...jobs.values()].filter((j) => j.status === 'failed').length;
      host.reportMetrics({ jobsRun: jobSeq, jobsSucceeded: ok, jobsFailed: failed });
    });
  return job;
}

function jobsJson() {
  return [...jobs.values()].slice().reverse().map((j) => ({
    id: j.id, status: j.status, name: j.name, template: j.template,
    steps: j.steps, result: j.result, error: j.error,
    submittedAt: j.submittedAt, finishedAt: j.finishedAt,
  }));
}

host.http((req, res, u) => {
  if (u.method === 'GET' && (u.path === '/' || u.path === '')) {
    return host.sendJson(res, 200, {
      bot: spec.slug,
      service: 'deploy automation',
      endpoints: { jobs: 'GET /jobs', submit: 'POST /jobs {name, template, env}', botControl: 'POST /bots {action:restart|stop, bot:slug}' },
      defaultTemplate: DEFAULT_TEMPLATE,
      jobsRun: jobSeq,
    });
  }
  if (u.method === 'GET' && u.path === '/jobs') return host.sendJson(res, 200, { jobs: jobsJson() });
  if (u.method === 'GET' && u.parts[0] === 'jobs' && u.parts[1]) {
    const j = jobs.get(Number(u.parts[1]));
    return j ? host.sendJson(res, 200, j) : host.sendJson(res, 404, { error: 'job not found' });
  }
  if (u.method === 'POST' && u.path === '/jobs') {
    return host.readBody(req)
      .then((body) => submitJob(body))
      .then((job) => host.sendJson(res, 201, { ok: true, jobId: job.id, watch: `GET /jobs/${job.id}` }))
      .catch((err) => host.sendJson(res, 400, { error: err.message }));
  }
  if (u.method === 'POST' && u.path === '/bots') {
    return host.readBody(req)
      .then(async (body) => {
        const action = String(body.action || '');
        const botSlug = String(body.bot || '');
        if (action === 'restart') {
          await host.platformCall('restartBot', { slug: botSlug });
          return { ok: true, restarted: botSlug };
        }
        if (action === 'stop') {
          await host.platformCall('stopBot', { slug: botSlug });
          return { ok: true, stopped: botSlug };
        }
        throw new Error('action must be "restart" or "stop"');
      })
      .then((r) => host.sendJson(res, 200, r))
      .catch((err) => host.sendJson(res, err.message.includes('not found') ? 404 : 400, { error: err.message }));
  }
  host.sendJson(res, 404, { error: 'not found', endpoints: ['GET /', 'GET /jobs', 'POST /jobs', 'POST /bots'] });
});

host.ready({ jobsRun: 0 });
