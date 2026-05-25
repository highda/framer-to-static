#!/usr/bin/env node
// Post-processing:
//   1. Remove legacy runtime patch / service-worker snippets from HTML
//   2. Rewrite generated CMS modules to use local .framercms files directly
//   3. Download third-party fonts (fonts.gstatic.com) and rewrite URLs to local paths

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', 'dist');
const DEPS = join(DIST, '_deps');
const STATIC_MODE = process.argv.includes('--static');

function stripEditorBarRuntime(js) {
  return js.replace(
    /EditorBar:\w+===void 0\?void 0:\(\(\)=>\{[\s\S]*?return\{default:e\(\)\}\}\)\}\)\(\),adaptLayoutToTextDirection:/g,
    'EditorBar:void 0,adaptLayoutToTextDirection:'
  );
}

// ── 1. Remove runtime URL patch + SW registration from all HTML files ────────
console.log('Removing legacy runtime patch and service worker registration...');
let injected = 0;

function walkHtml(dir, cb) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkHtml(full, cb);
    else if (entry.endsWith('.html')) cb(full);
  }
}

walkHtml(DIST, (filePath) => {
  if (filePath.includes('_deps')) return;
  const original = readFileSync(filePath, 'utf-8');
  let patched = original;

  patched = patched.replace(/\s*<script id="framercdn-patch">[\s\S]*?<\/script>\s*/g, '\n');
  patched = patched.replace(/\s*<script>\s*if\s*\('serviceWorker'[\s\S]*?<\/script>\s*/g, '\n');
  patched = patched.replace(/\s*<script[^>]*src="\/_deps\/events\/script"[^>]*><\/script>\s*/g, '\n');

  if (patched !== original) {
    writeFileSync(filePath, patched, 'utf-8');
    injected++;
  }
});
console.log(`  Updated ${injected} HTML files`);

// ── 2. Rewrite generated CMS references to use local .framercms files directly ─
console.log('\nRewriting generated CMS references to local chunk/index paths...');

let rewrittenModules = 0;

function walkJs(dir, cb) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkJs(full, cb);
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) cb(full);
  }
}

walkJs(DEPS, (filePath) => {
  const original = readFileSync(filePath, 'utf-8');
  let patched = original.replace(/\.href\.replace\((["'`])\/modules\/\1,(["'`])\/cms\/\2\)/g, '.href');
  patched = stripEditorBarRuntime(patched);
  if (patched !== original) {
    writeFileSync(filePath, patched, 'utf-8');
    rewrittenModules++;
  }
});

console.log(`  Updated ${rewrittenModules} generated JS files`);

// ── 3. Download third-party fonts and rewrite URLs to local paths ─────────────
console.log('\nDownloading third-party fonts...');

const THIRD_PARTY = join(DEPS, 'third-party-assets');
const fontUrlPattern = /https:\/\/fonts\.gstatic\.com\/[^\s"')]+\.woff2?/g;
const seenFonts = new Map(); // url -> local path

walkHtml(DIST, (filePath) => {
  if (filePath.includes('_deps')) return;
  const content = readFileSync(filePath, 'utf-8');
  let m;
  while ((m = fontUrlPattern.exec(content)) !== null) {
    const url = m[0];
    if (!seenFonts.has(url)) {
      // Preserve the path segments from fonts.gstatic.com/s/... so filenames stay unique
      const urlPath = new URL(url).pathname; // e.g. /s/ibmplexmono/v20/abc.woff2
      const localPath = `/_deps/third-party-assets/gstatic${urlPath}`;
      seenFonts.set(url, localPath);
    }
  }
});

async function downloadFonts() {
  if (seenFonts.size === 0) {
    console.log('  No third-party fonts found');
    return;
  }
  console.log(`  Found ${seenFonts.size} font URLs`);
  for (const [url, localPath] of seenFonts) {
    const fullPath = join(DIST, localPath);
    if (existsSync(fullPath)) {
      console.log(`  skip: ${localPath}`);
      continue;
    }
    mkdirSync(dirname(fullPath), { recursive: true });
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) { console.warn(`  ⚠ ${res.status} ${url}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(fullPath, buf);
      console.log(`  ✓ ${localPath} (${(buf.length / 1024).toFixed(1)}KB)`);
    } catch (e) {
      console.warn(`  ⚠ ${url} — ${e.message}`);
    }
  }

  // Rewrite URLs in HTML files
  let rewrittenHtml = 0;
  walkHtml(DIST, (filePath) => {
    if (filePath.includes('_deps')) return;
    let content = readFileSync(filePath, 'utf-8');
    let changed = false;
    for (const [url, localPath] of seenFonts) {
      if (content.includes(url)) {
        content = content.replaceAll(url, localPath);
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(filePath, content, 'utf-8');
      rewrittenHtml++;
    }
  });
  console.log(`  Rewrote ${rewrittenHtml} HTML files`);
}

await downloadFonts();

// ── 4. Write server config files for Apache and nginx ─────────────────────────
console.log('\nWriting server config files...');

if (STATIC_MODE) {
  writeFileSync(join(DIST, '.htaccess'), `# Framer static export — Apache configuration (static mode, no PHP)
# Generated by post-process.js. Do not edit by hand.

# ── Directory index / trailing-slash fix ────────────────────────────────────────
# Without DirectorySlash Off, Apache 301-redirects /contact → /contact/ because the
# dist/contact/ directory exists. That makes relative links (./about-us) resolve to
# /contact/about-us instead of /about-us. Turning it off plus setting DirectoryIndex
# makes Apache serve contact/index.html directly, keeping the URL as /contact.
DirectorySlash Off
DirectoryIndex index.html

# ── MIME types ──────────────────────────────────────────────────────────────────
# .mjs must be served as JavaScript or browsers refuse ES module execution.
<IfModule mod_mime.c>
    AddType application/javascript .mjs
</IfModule>

# ── SPA-style routing ───────────────────────────────────────────────────────────
# /some/path → /some/path/index.html when the exact file doesn't exist.
<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteCond %{REQUEST_URI} !\\.framercms
    RewriteRule ^(.*)$ /$1/index.html [L]
</IfModule>
`, 'utf-8');

  writeFileSync(join(DIST, 'nginx.conf.example'), `# Framer static export — nginx server block (static mode, no PHP)
# Generated by post-process.js. Adapt paths to your setup,
# then copy into /etc/nginx/sites-available/ and symlink to sites-enabled/.

server {
    listen 80;
    server_name your-domain.com;

    root /path/to/dist;
    index index.html;

    # .mjs files must be served as JavaScript for ES module imports to work.
    location ~* \\.mjs$ {
        default_type application/javascript;
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    # Cache _deps/ assets forever (all filenames are content-hashed).
    location ^~ /_deps/ {
        expires max;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # SPA routing: bare paths → directory index.html.
    location / {
        try_files $uri $uri/ $uri/index.html =404;
    }
}
`, 'utf-8');

  console.log('  Wrote .htaccess, nginx.conf.example (static mode, no .framercms rewrite needed)');

} else {
  writeFileSync(join(DIST, 'framercms.php'), `<?php
/**
 * Serves byte slices of .framercms binary files for the Framer CMS runtime.
 *
 * Framer fetches .framercms files with a ?range=FROM-TO query parameter (both
 * ends inclusive in the URL, exclusive-end in the JS model). Apache ignores the
 * query string for static files and returns the whole file, causing the runtime
 * to throw "Unexpected response length". This script slices the correct bytes.
 *
 * Multi-range requests (comma-separated) are also supported:
 *   ?range=0-648,649-1296
 * The slices are concatenated in order, matching what the Framer client expects.
 */

$requestPath = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$filePath = __DIR__ . $requestPath;
$realFile = realpath($filePath);
$realBase = realpath(__DIR__);

if (
    $realFile === false ||
    strpos($realFile, $realBase . DIRECTORY_SEPARATOR) !== 0 ||
    substr($realFile, -strlen('.framercms')) !== '.framercms'
) {
    http_response_code(403);
    exit;
}

if (!is_file($realFile)) {
    http_response_code(404);
    exit;
}

$range = isset($_GET['range']) ? $_GET['range'] : null;

if ($range === null) {
    $body = file_get_contents($realFile);
} else {
    $content = file_get_contents($realFile);
    $body = '';
    foreach (explode(',', $range) as $segment) {
        $parts = explode('-', trim($segment));
        if (count($parts) !== 2) { http_response_code(400); exit; }
        $start = (int)$parts[0];
        $end   = (int)$parts[1];
        $len   = $end - $start + 1;
        if ($start < 0 || $len <= 0 || $end >= strlen($content)) {
            http_response_code(416);
            exit;
        }
        $body .= substr($content, $start, $len);
    }
}

header('Content-Type: application/octet-stream');
header('Cache-Control: public, max-age=31536000, immutable');
header('Content-Length: ' . strlen($body));
header('Access-Control-Allow-Origin: *');
echo $body;
`, 'utf-8');

  writeFileSync(join(DIST, '.htaccess'), `# Framer static export — Apache configuration
# Generated by post-process.js. Do not edit by hand.

# ── Directory index / trailing-slash fix ────────────────────────────────────────
# Without DirectorySlash Off, Apache 301-redirects /contact → /contact/ because the
# dist/contact/ directory exists. That makes relative links (./about-us) resolve to
# /contact/about-us instead of /about-us. Turning it off plus setting DirectoryIndex
# makes Apache serve contact/index.html directly, keeping the URL as /contact.
DirectorySlash Off
DirectoryIndex index.html

# ── .framercms byte-range handler ──────────────────────────────────────────────
# The Framer CMS runtime fetches .framercms binary files with ?range=FROM-TO.
# Apache ignores query strings for static files and returns the whole file,
# causing the runtime to throw "Unexpected response length". Route these requests
# through framercms.php which slices the correct bytes.
<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteCond %{QUERY_STRING} (^|&)range=
    RewriteRule \\.framercms$ /framercms.php [L,QSA]
</IfModule>

# ── MIME types ──────────────────────────────────────────────────────────────────
# .mjs must be served as JavaScript or browsers refuse ES module execution.
<IfModule mod_mime.c>
    AddType application/javascript .mjs
</IfModule>

# ── SPA-style routing ───────────────────────────────────────────────────────────
# /some/path → /some/path/index.html when the exact file doesn't exist.
<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteCond %{REQUEST_URI} !\\.framercms$
    RewriteRule ^(.*)$ /$1/index.html [L]
</IfModule>
`, 'utf-8');

  writeFileSync(join(DIST, 'nginx.conf.example'), `# Framer static export — nginx server block
# Generated by post-process.js. Adapt paths and the PHP-FPM socket to your setup,
# then copy into /etc/nginx/sites-available/ and symlink to sites-enabled/.

server {
    listen 80;
    server_name your-domain.com;

    root /path/to/dist;
    index index.html;

    # .mjs files must be served as JavaScript for ES module imports to work.
    location ~* \\.mjs$ {
        default_type application/javascript;
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    # .framercms byte-range handler:
    # Framer fetches these with ?range=FROM-TO. nginx (like Apache) ignores the
    # query string for static files. Route all .framercms requests to framercms.php
    # which reads the requested byte slice and returns only those bytes.
    #
    # Adjust the fastcgi_pass socket to match your PHP-FPM installation:
    #   Debian/Ubuntu PHP 8.x: unix:/run/php/php8.2-fpm.sock
    #   CentOS/RHEL:            unix:/run/php-fpm/www.sock
    #   Generic TCP fallback:   127.0.0.1:9000
    location ~* \\.framercms$ {
        fastcgi_pass unix:/run/php/php8.2-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $document_root/framercms.php;
        include fastcgi_params;
    }

    # Cache _deps/ assets forever (all filenames are content-hashed).
    location ^~ /_deps/ {
        expires max;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # SPA routing: bare paths → directory index.html.
    location / {
        try_files $uri $uri/ $uri/index.html =404;
    }
}
`, 'utf-8');

  console.log('  Wrote framercms.php, .htaccess, nginx.conf.example');
}

console.log('\nDone.');
