#!/usr/bin/env node
// Scan every file in dist/ for framerusercontent.com asset references.
// Downloads anything missing from _deps/.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', 'dist');
const DEPS = join(DIST, '_deps');

const missing = new Map(); // localPath -> remoteUrl

function walk(dir, cb) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, cb);
    else cb(full);
  }
}

// Scan text files for framerusercontent.com URLs
function scanText(text, sourceFile) {
  // images
  const imgPat = /framerusercontent\.com\/images\/([\w\-\.@]+)/g;
  let m;
  while ((m = imgPat.exec(text)) !== null) {
    const id = m[1];
    const local = join(DEPS, 'images', id);
    if (!existsSync(local)) {
      missing.set(local, `https://framerusercontent.com/images/${id}`);
    }
  }

  // assets (fonts, videos)
  const assetPat = /framerusercontent\.com\/assets\/([\w\-\.\/]+)/g;
  while ((m = assetPat.exec(text)) !== null) {
    const p = m[1];
    const local = join(DEPS, 'assets', p);
    if (!existsSync(local)) {
      missing.set(local, `https://framerusercontent.com/assets/${p}`);
    }
  }

  // sites bundles
  const sitesPat = /framerusercontent\.com\/sites\/([\w\-\.\/]+)/g;
  while ((m = sitesPat.exec(text)) !== null) {
    const p = m[1];
    const local = join(DEPS, 'sites', p);
    if (!existsSync(local)) {
      missing.set(local, `https://framerusercontent.com/sites/${p}`);
    }
  }
}

// Scan binary files (latin1) for image references
function scanBinary(filePath) {
  const bytes = readFileSync(filePath);
  const text = bytes.toString('latin1');
  scanText(text, filePath);
}

console.log('Scanning all files for framerusercontent.com references...\n');

walk(DIST, (filePath) => {
  // Skip _deps itself (we scan those too but only for text)
  const ext = filePath.split('.').pop().toLowerCase();

  if (['html', 'js', 'mjs', 'json', 'css'].includes(ext)) {
    let text;
    try { text = readFileSync(filePath, 'utf-8'); } catch { return; }
    scanText(text, filePath);
  } else if (filePath.endsWith('.framercms')) {
    scanBinary(filePath);
  }
  // Binary images/fonts themselves — no need to scan
});

console.log(`Found ${missing.size} missing assets.\n`);

if (missing.size === 0) {
  console.log('Nothing to download. All assets are present.');
  process.exit(0);
}

// Download missing
let downloaded = 0;
let failed = 0;

for (const [localPath, remoteUrl] of missing) {
  mkdirSync(dirname(localPath), { recursive: true });
  try {
    const res = await fetch(remoteUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) {
      console.warn(`  ⚠ ${res.status} ${remoteUrl}`);
      failed++;
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(localPath, buf);
    const rel = localPath.split('_deps')[1] || localPath;
    console.log(`  ✓ ${rel} (${(buf.length / 1024).toFixed(1)}KB)`);
    downloaded++;
  } catch (e) {
    console.warn(`  ⚠ ${remoteUrl} — ${e.message}`);
    failed++;
  }
}

console.log(`\nDone. Downloaded ${downloaded}, failed ${failed}.`);
