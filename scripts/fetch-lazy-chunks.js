#!/usr/bin/env node
// Scan all downloaded .mjs files for import() references and download any missing chunks.
// Runs iteratively until no more missing chunks are found.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPS = join(__dirname, '..', 'dist', '_deps');

function walk(dir, cb) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, cb);
    else if (entry.endsWith('.mjs') || entry.endsWith('.js')) cb(full);
  }
}

async function downloadFile(url, localPath) {
  if (existsSync(localPath)) return false;
  mkdirSync(dirname(localPath), { recursive: true });
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) { console.warn(`  ⚠ ${res.status} ${url}`); return false; }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(localPath, buf);
    console.log(`  ✓ ${localPath.split('_deps')[1]} (${(buf.length/1024).toFixed(1)}KB)`);
    return true;
  } catch (e) {
    console.warn(`  ⚠ ${url} — ${e.message}`);
    return false;
  }
}

async function downloadReferencedFramercms() {
  const referenced = new Set();

  walk(DEPS, (filePath) => {
    let content;
    try { content = readFileSync(filePath, 'utf-8'); } catch { return; }
    const pattern = /new URL\(["'`](\.\/[^"'`]+\.framercms)["'`],(?:location\.origin\+)?.*?"\/(_deps\/[^"]+)"\)/g;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const chunkName = match[1].replace('./', '');
      const cdnRelPath = match[2].replace(/^_deps\//, '');
      const cdnDir = cdnRelPath.substring(0, cdnRelPath.lastIndexOf('/') + 1);
      referenced.add(cdnDir + chunkName);
    }
  });

  const missing = [...referenced].filter((rel) => !existsSync(join(DEPS, rel)));
  if (missing.length === 0) {
    console.log('  All referenced .framercms files present.');
    return 0;
  }

  console.log(`  Found ${missing.length} missing .framercms files, downloading...`);
  let downloaded = 0;
  for (const rel of missing) {
    const url = 'https://framerusercontent.com/' + rel;
    const localPath = join(DEPS, rel);
    if (await downloadFile(url, localPath)) downloaded++;
  }
  return downloaded;
}

function rewriteJsFile(filePath) {
  const original = readFileSync(filePath, 'utf-8');
  let content = original;
  content = content.replace(/https:\/\/framerusercontent\.com\/([\w\-\/\.@,]+)/g, (_, p) => `/_deps/${p}`);
  content = content.replace(/https:\/\/framer\.com\/m\/([\w\-\/\.@,]+)/g, (_, p) => `/_deps/framer/m/${p}`);
  content = content.replace(
    /new URL\((`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*`),`(\/_deps\/[^`]+)`\)/g,
    (_, a, p) => `new URL(${a},location.origin+"${p}")`
  );
  content = content.replace(
    /new URL\((`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'),"(\/_deps\/[^"]+)"\)/g,
    (_, a, p) => `new URL(${a},location.origin+"${p}")`
  );
  if (content !== original) { writeFileSync(filePath, content, 'utf-8'); return true; }
  return false;
}

let round = 0;
let totalDownloaded = 0;

while (true) {
  round++;
  console.log(`\nRound ${round}: scanning for missing lazy chunks...`);

  const referenced = new Set();
  const depsNorm = DEPS.replace(/\\/g, '/');

  walk(DEPS, (filePath) => {
    let content;
    try { content = readFileSync(filePath, 'utf-8'); } catch { return; }
    const fileDir = filePath.replace(/\\/g, '/');
    const dirPart = fileDir.substring(0, fileDir.lastIndexOf('/') + 1);
    if (!dirPart.startsWith(depsNorm + '/')) return;
    const relDir = dirPart.slice(depsNorm.length + 1);

    // import("./chunk.mjs") and import(`./chunk.mjs`) patterns
    const importPattern = /import\(["'`](\.\/[^"'`]+\.mjs)["'`]\)/g;
    let m;
    while ((m = importPattern.exec(content)) !== null) {
      referenced.add(relDir + m[1].replace('./', ''));
    }
  });

  const missing = [...referenced].filter(rel => !existsSync(join(DEPS, rel)));

  if (missing.length === 0) {
    console.log('  All lazy chunks present.');
    break;
  }

  console.log(`  Found ${missing.length} missing chunks, downloading...`);
  let downloaded = 0;
  for (const rel of missing) {
    const url = 'https://framerusercontent.com/' + rel;
    const localPath = join(DEPS, rel);
    const ok = await downloadFile(url, localPath);
    if (ok) {
      rewriteJsFile(localPath);
      downloaded++;
      totalDownloaded++;
    }
  }

  if (downloaded === 0) {
    console.log('  No new chunks downloaded (all failed). Stopping.');
    break;
  }
}

console.log('\nScanning for referenced .framercms files...');
const framercmsDownloaded = await downloadReferencedFramercms();

console.log(`\nDone. Downloaded ${totalDownloaded} new chunks and ${framercmsDownloaded} .framercms files total.`);
