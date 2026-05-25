#!/usr/bin/env node

/**
 * Framer Site Mirror — Extraction Script
 *
 * Usage: node extract.js <framer-url> [--pages /path1,/path2,...]
 *
 * Downloads all pages + CDN assets from a live Framer site,
 * rewrites URLs to local paths, strips editor/analytics cruft,
 * and outputs a self-contained static site in dist/.
 *
 * Output structure uses directory indexes for maximum Apache/nginx compatibility:
 *   /about  →  dist/about/index.html
 *   /       →  dist/index.html
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { normalizeOmitSelectors, omitHtmlBySelectors } from './lib/html-omit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', 'dist');
const DEPS = join(DIST, '_deps');

// ─── Parse CLI args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const SITE_ORIGIN = args.find(a => a.startsWith('http'));

if (!SITE_ORIGIN) {
  console.error('Usage: node extract.js <framer-url> [--pages /path1,/path2,...] [--hide-selector SELECTOR]');
  console.error('Example: node extract.js https://my-site.framer.app --pages /,/about,/contact --hide-selector \'div[data-framer-name="Form"]\'');
  process.exit(1);
}

// Parse --pages flag or default to just /
const pagesIdx = args.indexOf('--pages');
let pagePaths = ['/'];
if (pagesIdx !== -1 && args[pagesIdx + 1]) {
  pagePaths = args[pagesIdx + 1].split(',').map(p => p.trim());
}
const omitSelectorArgs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--hide-selector' && args[i + 1]) {
    omitSelectorArgs.push(args[i + 1]);
    i++;
  }
}
const OMIT_SELECTORS = normalizeOmitSelectors(omitSelectorArgs);

function routePathToOutputFile(routePath) {
  if (routePath === '/') return 'index.html';
  const trimmed = routePath.replace(/^\//, '').replace(/\/$/, '');
  const decoded = trimmed
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
  return `${decoded}/index.html`;
}

// Convert page paths to {path, file} pairs.
// Directory index structure: /about -> about/index.html
// Route segments are decoded for filesystem compatibility on Apache/nginx.
const PAGES = pagePaths.map(p => ({
  path: p,
  file: routePathToOutputFile(p),
}));

console.log(`Site: ${SITE_ORIGIN}`);
console.log(`Pages: ${PAGES.map(p => p.path).join(', ')}`);
if (OMIT_SELECTORS.length > 0) {
  console.log(`Hide selectors: ${OMIT_SELECTORS.join(', ')}`);
}

// ─── Patterns to strip ──────────────────────────────────────────────────────

const STRIP_PATTERNS = [
  // Framer editor bar init script
  /\s*<script>[^<]*localStorage\.get\("__framer_force_showing_editorbar_since"\)[^<]*<\/script>\s*/g,
  // Framer editor bar iframe/scripts
  /\s*<script[^>]*src="https:\/\/framer\.com\/edit[^"]*"[^>]*><\/script>\s*/g,
  // app.framerstatic.com (editor bar chunks)
  /\s*<link[^>]*href="https:\/\/app\.framerstatic\.com[^"]*"[^>]*>\s*/g,
  /\s*<script[^>]*src="https:\/\/app\.framerstatic\.com[^"]*"[^>]*><\/script>\s*/g,
  // Cloudflare Turnstile
  /\s*<script[^>]*src="https:\/\/challenges\.cloudflare\.com[^"]*"[^>]*><\/script>\s*/g,
  /\s*<div[^>]*id="__framer-badge-container"[^>]*>[\s\S]*?<\/div>\s*/g,
  // Sentry
  /\s*<script[^>]*sentry[^>]*><\/script>\s*/g,
  // Framer analytics bootstrap script
  /\s*<script[^>]*src="https:\/\/events\.framer\.com\/[^"]*"[^>]*><\/script>\s*/g,
  // Framer analytics event POST
  /\s*<script[^>]*>[\s\S]*?events\.framer\.com\/anonymous[\s\S]*?<\/script>\s*/g,
];

// Track all unique asset URLs
const assetUrls = new Set();

// ─── URL extraction ──────────────────────────────────────────────────────────

function extractAssetUrls(html) {
  const urlRegex = /https:\/\/(framerusercontent\.com|framer\.com)\/([\w\-\/\.@,]+(?:\?[^"'\s)}<]*)?)/g;
  let match;
  while ((match = urlRegex.exec(html)) !== null) {
    const fullUrl = match[0].replace(/&amp;/g, '&');
    if (fullUrl.includes('framer.com/edit')) continue;
    if (fullUrl.includes('app.framerstatic.com')) continue;
    assetUrls.add(fullUrl);
  }
}

function cdnUrlToLocalPath(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const pathname = parsed.pathname;

    if (host === 'framerusercontent.com') return `/_deps${pathname}`;
    if (host === 'events.framer.com') return `/_deps/events${pathname}`;
    if (host === 'framer.com') return `/_deps/framer${pathname}`;
  } catch { return null; }
  return null;
}

// ─── URL rewriting ───────────────────────────────────────────────────────────

function rewriteUrls(html) {
  // framerusercontent.com (strip query params for local path)
  html = html.replace(
    /https:\/\/framerusercontent\.com\/([\w\-\/\.@,]+(?:\?[^"'\s)}<]*)?)/g,
    (match, path) => `/_deps/${path.split('?')[0]}`
  );

  // events.framer.com
  html = html.replace(
    /https:\/\/events\.framer\.com\/([\w\-\/\.@?=&]*)/g,
    (match, path) => `/_deps/events/${path.split('?')[0]}`
  );

  // framer.com/m/ (phosphor icons etc.) but NOT framer.com/edit
  html = html.replace(
    /https:\/\/framer\.com\/m\/([\w\-\/\.@,]+)/g,
    (match, path) => `/_deps/framer/m/${path}`
  );

  return html;
}

// ─── HTML cleanup ────────────────────────────────────────────────────────────

function stripCruft(html) {
  for (const pattern of STRIP_PATTERNS) {
    html = html.replace(pattern, '');
  }

  // Editor bar modulepreload
  html = html.replace(/\s*<link[^>]*href="https:\/\/framer\.com\/edit\/init\.mjs"[^>]*>\s*/g, '');

  // data-redirect-timezone
  html = html.replace(/ data-redirect-timezone="[^"]*"/, '');

  // Cloudflare Turnstile inline scripts
  html = html.replace(/\s*<script[^>]*turnstile[^>]*>[^<]*<\/script>\s*/gi, '');
  html = html.replace(/\s*<script[^>]*>[\s\S]*?turnstileLoad[\s\S]*?<\/script>\s*/g, '');
  html = html.replace(/\s*<script[^>]*>[\s\S]*?challenges\.cloudflare\.com[\s\S]*?<\/script>\s*/g, '');

  // Framer badge
  html = html.replace(/\s*<p[^>]*>Create a free website with Framer[^<]*<\/p>\s*/g, '');

  // framer.com/edit init script and iframe
  html = html.replace(/\s*<script[^>]*>[\s\S]*?framer\.com\/edit[\s\S]*?<\/script>\s*/g, '');
  html = html.replace(/\s*<iframe[^>]*framer\.com\/edit[^>]*>[\s\S]*?<\/iframe>\s*/g, '');

  return html;
}

// ─── Asset download ──────────────────────────────────────────────────────────

async function downloadAsset(url, localPath) {
  const fullPath = join(DIST, localPath);
  if (existsSync(fullPath)) return;

  mkdirSync(dirname(fullPath), { recursive: true });

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
    });
    if (!res.ok) {
      console.warn(`  ⚠ ${res.status} for ${url}`);
      return;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    writeFileSync(fullPath, buffer);
    console.log(`  ✓ ${localPath} (${(buffer.length / 1024).toFixed(1)}KB)`);
  } catch (err) {
    console.warn(`  ⚠ Failed: ${url} — ${err.message}`);
  }
}

async function downloadSiteFile(pathname, localPath = pathname) {
  const url = `${SITE_ORIGIN}${pathname}`;
  const outPath = join(DIST, localPath.replace(/^\//, ''));
  if (existsSync(outPath)) return false;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      redirect: 'follow',
    });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, buf);
    console.log(`  ✓ ${localPath} (${(buf.length / 1024).toFixed(1)}KB)`);
    return true;
  } catch {
    return false;
  }
}

async function downloadCdnAsset(url) {
  const localPath = cdnUrlToLocalPath(url);
  if (!localPath) return;
  // Always fetch images at full resolution — strip any size-limiting query params
  // (e.g. ?scale-down-to=512) that Framer CDN appends for responsive srcsets.
  const fetchUrl = localPath.startsWith('/_deps/images/')
    ? url.split('?')[0]
    : url;
  await downloadAsset(fetchUrl, localPath);
}

function getUniqueAssetUrls(urls) {
  const byLocalPath = new Map();
  for (const url of urls) {
    const localPath = cdnUrlToLocalPath(url);
    if (!localPath) continue;
    if (!byLocalPath.has(localPath)) {
      byLocalPath.set(localPath, url);
    }
  }
  return [...byLocalPath.values()];
}

function scanJsBundlesForAssets() {
  const jsUrls = [...assetUrls].filter(u => u.endsWith('.mjs') || u.endsWith('.js'));
  for (const url of jsUrls) {
    const localPath = cdnUrlToLocalPath(url);
    if (!localPath) continue;
    const fullPath = join(DIST, localPath);
    if (!existsSync(fullPath)) continue;
    try {
      const content = readFileSync(fullPath, 'utf-8');
      const urlRegex = /https:\/\/framerusercontent\.com\/([\w\-\/\.@,]+)/g;
      let match;
      while ((match = urlRegex.exec(content)) !== null) {
        assetUrls.add(match[0]);
      }
    } catch { /* skip */ }
  }
}

// ─── JS bundle post-processing ───────────────────────────────────────────────
// The Framer runtime executes downloaded .mjs bundles which still have hardcoded
// framerusercontent.com URLs for dynamic chunk/asset loading — HTML rewriting
// alone is not enough. We also fix new URL(x, "/_deps/...") calls: browsers
// require an absolute base URL, so relative /_deps/ paths cause a TypeError
// that crashes the runtime and kills all animations and interactions.

function rewriteJsFile(filePath) {
  const original = readFileSync(filePath, 'utf-8');
  let content = original;

  // Rewrite CDN base URLs in bundle source
  content = content.replace(
    /https:\/\/framerusercontent\.com\/([\w\-\/\.@,]+)/g,
    (match, path) => `/_deps/${path}`
  );
  content = content.replace(
    /https:\/\/framer\.com\/m\/([\w\-\/\.@,]+)/g,
    (match, path) => `/_deps/framer/m/${path}`
  );

  // Fix new URL(firstArg, "/_deps/...") — new URL() requires an absolute base.
  // Wrap with location.origin so it resolves against the current server.
  // Handles double-quoted, single-quoted, and backtick template literals.
  content = content.replace(
    /new URL\(("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`),"(\/_deps\/[^"]+)"\)/g,
    (match, firstArg, path) => `new URL(${firstArg},location.origin+"${path}")`
  );
  content = content.replace(
    /new URL\(("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`),`(\/_deps\/[^`]+)`\)/g,
    (match, firstArg, path) => `new URL(${firstArg},location.origin+"${path}")`
  );

  if (content !== original) {
    writeFileSync(filePath, content, 'utf-8');
    return true;
  }
  return false;
}

function walkDepsForJs(dir, callback) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkDepsForJs(full, callback);
    } else if (entry.endsWith('.mjs') || entry.endsWith('.js')) {
      callback(full);
    }
  }
}

function rewriteAllJsBundles() {
  let rewritten = 0, total = 0;
  walkDepsForJs(DEPS, (filePath) => {
    total++;
    if (rewriteJsFile(filePath)) rewritten++;
  });
  return { rewritten, total };
}

// ─── .framercms data chunk download ─────────────────────────────────────────
// Framer CMS lazy-loads compressed binary data chunks referenced in bundles as:
//   new URL("./name.framercms", base).href
// Collect, resolve to CDN URL, and download them.

async function downloadFramercmsChunks() {
  const seen = new Set();
  const toDownload = [];

  walkDepsForJs(DEPS, (filePath) => {
    let content;
    try { content = readFileSync(filePath, 'utf-8'); } catch { return; }
    // Match both pre-fix and post-fix patterns for the base URL argument
    const pattern = /new URL\("(\.\/[^"]+\.framercms)",(?:location\.origin\+)?"\/(_deps\/[^"]+)"\)/g;
    let m;
    while ((m = pattern.exec(content)) !== null) {
      const chunkName = m[1].replace('./', '');
      const cdnRelPath = m[2].replace(/^_deps\//, ''); // "modules/abc/.../file.js"
      const cdnDir = cdnRelPath.substring(0, cdnRelPath.lastIndexOf('/') + 1);
      const localPath = '/_deps/' + cdnDir + chunkName;
      if (!seen.has(localPath)) {
        seen.add(localPath);
        toDownload.push({
          remoteUrl: 'https://framerusercontent.com/' + cdnDir + chunkName,
          localPath,
        });
      }
    }
  });

  if (toDownload.length === 0) {
    console.log('  No .framercms chunks found');
    return;
  }
  console.log(`  Found ${toDownload.length} .framercms chunks`);
  for (const { remoteUrl, localPath } of toDownload) {
    await downloadAsset(remoteUrl, localPath);
  }
}

// ─── Lazy page chunk download ────────────────────────────────────────────────
// Framer code-splits each page into a separate .mjs loaded via import() at
// runtime. These are not in any HTML <script> tag — only in import() calls
// inside the already-downloaded site bundles.

async function downloadLazyPageChunks() {
  const referenced = new Set();
  const depsNorm = DEPS.replace(/\\/g, '/');

  walkDepsForJs(DEPS, (filePath) => {
    let content;
    try { content = readFileSync(filePath, 'utf-8'); } catch { return; }
    const fileDir = filePath.replace(/\\/g, '/');
    const dirPart = fileDir.substring(0, fileDir.lastIndexOf('/') + 1);
    if (!dirPart.startsWith(depsNorm + '/')) return;
    const relDir = dirPart.slice(depsNorm.length + 1); // e.g. "sites/abc123/"
    const pattern = /import\("(\.[^"]+\.mjs)"\)/g;
    let m;
    while ((m = pattern.exec(content)) !== null) {
      referenced.add(relDir + m[1].replace('./', ''));
    }
  });

  const missing = [...referenced].filter(
    rel => !existsSync(join(DEPS, rel))
  );

  if (missing.length === 0) {
    console.log('  All lazy page chunks already present');
    return;
  }

  console.log(`  Downloading ${missing.length} missing lazy chunks...`);
  for (const rel of missing) {
    await downloadAsset(
      'https://framerusercontent.com/' + rel,
      '/_deps/' + rel
    );
  }

  // Rewrite CDN URLs in newly downloaded chunks
  let rewrote = 0;
  for (const rel of missing) {
    const fp = join(DEPS, rel);
    if (existsSync(fp) && rewriteJsFile(fp)) rewrote++;
  }
  if (rewrote > 0) console.log(`  Rewrote CDN URLs in ${rewrote} new chunks`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔧 Framer Site Mirror — Extraction\n');
  console.log(`Output: ${DIST}\n`);

  mkdirSync(DIST, { recursive: true });

  // Step 1: Fetch all pages
  console.log('📄 Fetching pages...');
  const pageHtmls = new Map();

  for (const page of PAGES) {
    const url = `${SITE_ORIGIN}${page.path}`;
    console.log(`  Fetching ${url}`);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
      });
      if (!res.ok) {
        console.warn(`  ⚠ ${res.status} for ${url}`);
        continue;
      }
      const html = await res.text();
      pageHtmls.set(page.file, html);
      console.log(`  ✓ ${page.file} (${(html.length / 1024).toFixed(0)}KB)`);
    } catch (err) {
      console.warn(`  ⚠ Failed: ${url} — ${err.message}`);
    }
  }

  // Try to get 404 page from a guaranteed-random route
  console.log('  Fetching 404 page...');
  try {
    const nonce = `__framer_export_404_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const res404 = await fetch(`${SITE_ORIGIN}/${nonce}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      redirect: 'manual'
    });
    if (res404.status === 200 || res404.status === 404) {
      const html404 = await res404.text();
      pageHtmls.set('404.html', html404);
      console.log(`  ✓ 404.html (${(html404.length / 1024).toFixed(0)}KB)`);
    }
  } catch { /* skip */ }

  // Step 2: Extract asset URLs
  console.log('\n🔍 Extracting asset URLs...');
  for (const [, html] of pageHtmls) {
    extractAssetUrls(html);
  }
  console.log(`  Found ${assetUrls.size} unique asset URLs`);

  // Step 3: Download all assets (batches of 10)
  console.log('\n📦 Downloading assets...');
  const urls = getUniqueAssetUrls([...assetUrls]);
  for (let i = 0; i < urls.length; i += 10) {
    const batch = urls.slice(i, i + 10);
    await Promise.all(batch.map(downloadCdnAsset));
  }

  // Step 3b: Scan JS bundles for additional assets
  console.log('\n🔍 Scanning JS bundles for additional assets...');
  const beforeCount = assetUrls.size;
  scanJsBundlesForAssets();
  const newUrls = getUniqueAssetUrls([...assetUrls]).filter(url => !urls.includes(url));
  if (newUrls.length > 0) {
    console.log(`  Found ${newUrls.length} additional assets in JS bundles`);
    for (let i = 0; i < newUrls.length; i += 10) {
      const batch = newUrls.slice(i, i + 10);
      await Promise.all(batch.map(downloadCdnAsset));
    }
  } else {
    console.log('  No additional assets found');
  }

  // Step 3c: Rewrite CDN URLs inside downloaded JS bundles
  // The Framer runtime executes these bundles and uses the URLs inside them for
  // dynamic chunk/asset loading. Also fixes new URL(x, "/_deps/...") crashes.
  console.log('\n🔧 Rewriting CDN URLs in JS bundles...');
  const { rewritten, total } = rewriteAllJsBundles();
  console.log(`  Rewrote ${rewritten} of ${total} JS files`);

  // Step 3d: Download .framercms CMS data chunks (lazy-loaded binary data)
  console.log('\n📦 Downloading .framercms CMS data chunks...');
  await downloadFramercmsChunks();

  // Step 3e: Download lazy-loaded page chunks referenced via import() in bundles
  console.log('\n📦 Downloading lazy page chunks...');
  await downloadLazyPageChunks();

  // Step 4: Download favicon and OG images
  console.log('\n🖼️  Downloading favicon & OG images...');
  const firstHtml = [...pageHtmls.values()][0] || '';
  const faviconMatch = firstHtml.match(/rel="icon"[^>]*href="([^"]+)"/);
  const ogMatch = firstHtml.match(/property="og:image"[^>]*content="([^"]+)"/);

  if (faviconMatch) {
    await downloadAsset(faviconMatch[1].replace(/&amp;/g, '&'), '/favicon.png');
  }
  if (ogMatch) {
    await downloadAsset(ogMatch[1].replace(/&amp;/g, '&'), '/og-image.png');
  }

  // Step 4b: Download common root assets if present.
  // These are fetched opportunistically for deployment completeness.
  console.log('\n📎 Downloading common root assets...');
  const commonRootAssets = [
    '/favicon.ico',
    '/robots.txt',
    '/manifest.json',
    '/site.webmanifest',
    '/apple-touch-icon.png',
    '/browserconfig.xml',
    '/sitemap.xml',
    '/sitemap_index.xml',
    '/sitemap-index.xml',
  ];
  let commonDownloaded = 0;
  for (const assetPath of commonRootAssets) {
    if (await downloadSiteFile(assetPath)) commonDownloaded++;
  }
  if (commonDownloaded === 0) {
    console.log('  No additional common root assets found');
  }

  // Step 5: Rewrite and save HTML
  console.log('\n✏️  Rewriting HTML...');
  for (const [file, html] of pageHtmls) {
    let processed = stripCruft(html);
    processed = rewriteUrls(processed);
    processed = omitHtmlBySelectors(processed, OMIT_SELECTORS);

    const outPath = join(DIST, file);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, processed, 'utf-8');
    console.log(`  ✓ ${file} (${(processed.length / 1024).toFixed(0)}KB)`);

  }

  // Summary
  console.log(`\n✅ Done!`);
  console.log(`   ${pageHtmls.size} HTML pages`);
  console.log(`   ${assetUrls.size} assets downloaded`);
  console.log(`   Output: ${DIST}`);
  console.log(`\n   To preview locally: node server.js`);
  console.log(`   Deploy: copy dist/ contents to your Apache/nginx document root`);
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
