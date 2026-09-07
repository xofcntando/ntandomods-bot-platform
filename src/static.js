// ── Static file server for the dashboard (SPA fallback) ─────────
'use strict';

const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

function createStatic(rootDir) {
  function notFound(res) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  // Returns true if the request was handled (static path or SPA fallback).
  function serve(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return true;
    }

    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://internal').pathname);
    } catch (_) {
      urlPath = '/';
    }
    if (urlPath === '/') urlPath = '/index.html';

    let filePath = path.resolve(rootDir, '.' + urlPath);
    // path traversal guard
    if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return true;
    }

    let stat = null;
    try {
      stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        stat = fs.statSync(filePath);
      }
    } catch (_) { /* fall through to SPA/404 */ }

    if (!stat || !stat.isFile()) {
      // SPA fallback: extensionless paths serve the app shell
      if (!path.extname(filePath)) {
        const index = path.join(rootDir, 'index.html');
        if (fs.existsSync(index)) {
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
          res.end(fs.readFileSync(index));
          return true;
        }
      }
      notFound(res);
      return true;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const cache = ext === '.html' ? 'no-store' : 'public, max-age=300';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': cache });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  return { serve };
}

module.exports = { createStatic };
