#!/usr/bin/env node

/**
 * Local dev server for framer-to-static exports.
 *
 * Usage: node server.js [port]
 *
 * Serves the dist/ directory with routing support:
 *   /about      → dist/about/index.html
 *   /_deps/...  → static asset pass-through
 *   anything missing → dist/404.html
 */

import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { mkdirSync, writeFileSync } from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'dist');
const PORT = parseInt(process.argv.find(a => /^\d+$/.test(a)) || '8080', 10);
// --no-rewrite (alias: --static): disable server-side .framercms?range= byte slicing.
// Use this when validating a --static export whose JS was patched to request
// .framercms.FROM-TO slice files directly, or to simulate any plain static host.
// Without this flag the server slices .framercms files in memory, which is the
// correct behaviour when serving a non-static (PHP/.htaccess) export locally.
const NO_REWRITE = process.argv.includes('--no-rewrite') || process.argv.includes('--static');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

function getMimeType(filePath) {
  const normalized = filePath.replace(/@[\d.]+$/, '');
  const jsLike = normalized.match(/\.(mjs|js)$/i);
  if (jsLike) {
    return 'application/javascript';
  }

  const ext = extname(normalized).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

async function serve(req, res) {
  const requestUrl = new URL(req.url, 'http://localhost');
  const urlPath = requestUrl.pathname;

  const candidates = [
    join(DIST, urlPath),
    join(DIST, urlPath, 'index.html'),
    join(DIST, urlPath.replace(/\/$/, ''), 'index.html'),
  ];

  for (const filePath of candidates) {
    try {
      const s = await stat(filePath);
      if (s.isFile()) {
        const ext = extname(filePath.replace(/@[\d.]+$/, '')).toLowerCase();
        const mime = getMimeType(filePath);
        let body;
        if (filePath.endsWith('.framercms')) {
          const rangeParam = requestUrl.searchParams.get('range');
          if (rangeParam && !NO_REWRITE) {
            // In-memory slice (default dev-server behaviour).
            body = await readFile(filePath);
            const [start, end] = rangeParam.split('-').map(Number);
            if (Number.isFinite(start) && Number.isFinite(end)) {
              body = body.slice(start, end + 1);
            }
          } else {
            body = await readFile(filePath);
          }
        } else {
          body = await readFile(filePath);
        }
        const headers = { 'Content-Type': mime };
        if (urlPath.startsWith('/_deps/')) {
          headers['Cache-Control'] = 'public, max-age=31536000, immutable';
        }
        if (ext === '.woff2' || ext === '.woff') {
          headers['Access-Control-Allow-Origin'] = '*';
        }
        res.writeHead(200, headers);
        res.end(body);
        return;
      }
    } catch { /* try next */ }
  }

  // Legacy alias /_deps/cms/ → /_deps/modules/.
  // Newer post-processing rewrites generated collection modules to reference
  // local .framercms files directly, but keep this fallback for older exports.
  if (urlPath.startsWith('/_deps/cms/')) {
    const modulesPath = urlPath.replace('/_deps/cms/', '/_deps/modules/');
    const filePath = join(DIST, modulesPath);
    try {
      const s = await stat(filePath);
      if (s.isFile()) {
        const rangeParam = requestUrl.searchParams.get('range');
        let body;
        if (rangeParam && !NO_REWRITE) {
          body = await readFile(filePath);
          const [start, end] = rangeParam.split('-').map(Number);
          body = body.slice(start, end + 1);
        } else {
          body = await readFile(filePath);
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
        res.end(body);
        return;
      }
    } catch { /* fall through to proxy */ }
  }

  // Proxy framer.com/m/ icon modules on-demand.
  // Rewrites framerusercontent.com/modules/ → /_deps/modules/ before saving,
  // so the exported file is self-contained after first request.
  if (urlPath.startsWith('/_deps/framer/m/')) {
    const cdnPath = urlPath.replace('/_deps/framer/', '');
    const cdnUrl = `https://framer.com/${cdnPath}`;
    try {
      const upstream = await fetch(cdnUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (upstream.ok) {
        const text = await upstream.text();
        const rewritten = text.replaceAll('https://framerusercontent.com/modules/', '/_deps/modules/');
        const mime = getMimeType(urlPath);
        const localPath = join(DIST, urlPath);
        mkdirSync(dirname(localPath), { recursive: true });
        writeFileSync(localPath, rewritten, 'utf-8');
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
        res.end(rewritten);
        return;
      }
    } catch { /* fall through */ }
  }

  // Proxy missing /_deps/modules/ files from framerusercontent.com on-demand.
  // This catches underlying module files referenced by rewritten framer.com/m/ wrappers.
  if (urlPath.startsWith('/_deps/modules/')) {
    const modulePath = urlPath.replace('/_deps/modules/', '');
    const cdnUrl = `https://framerusercontent.com/modules/${modulePath}`;
    try {
      const upstream = await fetch(cdnUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (upstream.ok) {
        const mime = getMimeType(urlPath);
        const isJs = mime === 'application/javascript';
        const localPath = join(DIST, urlPath);
        mkdirSync(dirname(localPath), { recursive: true });
        if (isJs) {
          const text = await upstream.text();
          writeFileSync(localPath, text, 'utf-8');
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
          res.end(text);
        } else {
          const body = Buffer.from(await upstream.arrayBuffer());
          writeFileSync(localPath, body);
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
          res.end(body);
        }
        return;
      }
    } catch { /* fall through */ }
  }

  // 404 fallback
  try {
    const body = await readFile(join(DIST, '404.html'));
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

createServer(serve).listen(PORT, () => {
  console.log(`\n🚀 Local server running at http://localhost:${PORT}\n`);
  if (NO_REWRITE) console.log('   Mode: no-rewrite (plain file serving, no .framercms range slicing)\n');
  console.log('   Press Ctrl+C to stop\n');
});
