#!/usr/bin/env node
// Post-processing:
//   1. Remove legacy runtime patch / service-worker snippets from HTML
//   2. Rewrite generated CMS modules to use local .framercms files directly
//   3. Download third-party fonts (fonts.gstatic.com) and rewrite URLs to local paths

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', 'dist');
const DEPS = join(DIST, '_deps');

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
console.log('\nDone.');
