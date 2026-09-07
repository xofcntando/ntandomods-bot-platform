'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { Store } = require('./store');
const { createSupervisor } = require('./supervisor');
const { createRouter } = require('./router');
const { createProxy } = require('./proxy');
const { createStatic } = require('./static');

async function main() {
  const store = await new Store().init();
  const supervisor = createSupervisor(store);
  supervisor.startWatchdog();
  const router = createRouter(store, supervisor);
  const proxy = createProxy(store, supervisor);

  // Dashboard (public/) is optional at boot — rechecked per request.
  const publicDir = path.join(config.root, 'public');
  let serveStatic = fs.existsSync(publicDir) ? createStatic(publicDir) : null;
  const getStatic = () => {
    if (!serveStatic && fs.existsSync(publicDir)) serveStatic = createStatic(publicDir);
    return serveStatic;
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (await router.dispatch(req, res)) return;
      if (await proxy.handle(req, res)) return;
      const st = getStatic();
      if (st && (req.method === 'GET' || req.method === 'HEAD')) {
        if (st.serve(req, res)) return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not found', hint: 'API under /api/, bots under /live/<slug>/, dashboard at /' }));
    } catch (err) {
      console.error(`[server] request error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'internal error' }));
      } else { try { res.end(); } catch (_) {} }
    }
  });

  server.listen(config.port, () => {
    const mode = config.rootDomain ? `subdomain+path` : `path only`;
    console.log('');
    console.log('  ╔════════════════════════════════════════════════════╗');
    console.log('  ║   🤖 Ntandomods Bot Platform — control plane up     ║');
    console.log('  ╠════════════════════════════════════════════════════╣');
    console.log(`  ║   URL:       ${String(config.baseUrl).padEnd(41)}║`);
    console.log(`  ║   Dashboard: ${String(config.baseUrl + '/').padEnd(41)}║`);
    console.log(`  ║   Routing:   ${String(mode).padEnd(41)}║`);
    console.log(`  ║   Bots live: ${String(config.baseUrl + '/live/<slug>/').padEnd(41)}║`);
    console.log('  ╚════════════════════════════════════════════════════╝');
    console.log('');
  });

  const shutdown = (sig) => {
    console.log(`\n[server] ${sig} received — shutting down`);
    server.close(() => {});
    supervisor.shutdownAll().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 10 * 1000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // restore-on-boot: restart bots that were running when the platform died
  const restorables = (await store.listBots()).filter(
    (b) => b.status === 'running' || b.status === 'starting' || b.status === 'crashed'
  );
  if (restorables.length) {
    console.log(`[server] restoring ${restorables.length} bot(s) from previous session...`);
    for (const b of restorables) {
      try { await supervisor.start(b); } catch (err) {
        console.error(`[server] restore failed for ${b.slug}: ${err.message}`);
      }
    }
  }
  return { server, store, supervisor, router, proxy };
}

main().catch((err) => {
  console.error('[server] fatal boot error:', err);
  process.exit(1);
});
