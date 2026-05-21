#!/usr/bin/env node
// Download all framer.com/m/ module files referenced in HTML + JS bundles

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', 'dist');
const DEPS = join(DIST, '_deps');

function walk(dir, cb) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, cb);
    else cb(full);
  }
}

function isJavaScriptAsset(filePath) {
  return /\.m?js(?:@[\w.]+)?$/i.test(filePath);
}

const seen = new Set();
const toDownload = [];

function enqueue(remoteUrl, localPath) {
  if (seen.has(localPath)) return;
  seen.add(localPath);
  toDownload.push({ remoteUrl, localPath });
}

function rewriteModuleSource(content) {
  return content
    .replaceAll('https://framerusercontent.com/modules/', '/_deps/modules/')
    .replaceAll('https://framer.com/m/', '/_deps/framer/m/');
}

function scanModuleDependencies(content) {
  const pattern = /\/_deps\/modules\/([^\s"'`<>)]+)/g;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    const path = m[1];
    enqueue(`https://framerusercontent.com/modules/${path}`, `/_deps/modules/${path}`);
  }
}

// Scan all HTML and JS files for /_deps/framer/ paths (statically referenced)
function scan(content) {
  const pattern = /\/_deps\/framer\/(m\/[^\s"'`,<>)]+)/g;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    const path = m[1];
    if (path.endsWith('/')) continue; // base URL declaration, not a file
    enqueue(`https://framer.com/${path}`, `/_deps/framer/${path}`);
  }
}

// ─── Dynamic icon pre-download ───────────────────────────────────────────────
// Framer constructs icon module URLs at runtime from a base URL variable and a
// hardcoded version: import(`${baseUrl}${iconName}${styleVariant}.js@VERSION`)
// None of these paths appear in the static HTML/JS, so we recover them by:
//  1. Finding the base URL and version from the Framer runtime code
//  2. Finding iconSelection prop values baked into page component bundles
//  3. Finding non-Filled style variant names from iconStyle* props

// {category -> version}, e.g. {'material-icons' -> '0.0.32'}
const iconPackages = new Map();
// icon names found in iconSelection props across all JS
const iconSelectionNames = new Set();
// style suffixes to try beyond the default empty (Filled) variant
const iconStyleSuffixes = new Set(['']);

function scanForIconPackageDecl(content) {
  // Match already-rewritten base URL strings like `/_deps/framer/m/material-icons/`
  const baseRe = /["'`]\/_deps\/framer\/m\/([^/"'`\s]+)\/["'`]/g;
  // Match .js@VERSION inside template literals used for dynamic imports
  const versionRe = /\.js@(\d+\.\d+(?:\.\d+)?)["'`]/g;
  let m;
  const localBases = [];
  while ((m = baseRe.exec(content)) !== null) localBases.push(m[1]);
  const localVersions = [];
  while ((m = versionRe.exec(content)) !== null) localVersions.push(m[1]);
  for (const cat of localBases) {
    if (iconPackages.has(cat)) continue;
    // Associate the first version found in the same file as this base URL
    const ver = localVersions[0];
    if (ver) iconPackages.set(cat, ver);
  }
}

function scanForIconSelections(content) {
  // iconSelection:"ArrowUpward" — compiled Framer component data
  const re = /iconSelection\s*[:"'`\s]+([A-Z][a-zA-Z0-9]+)/g;
  let m;
  while ((m = re.exec(content)) !== null) iconSelectionNames.add(m[1]);
}

function scanForIconStyleVariants(content) {
  // iconStyle15:"Outlined" — non-Filled style variants become filename suffixes
  const re = /iconStyle\d+\s*[:"'`\s]+([A-Z][a-zA-Z]+)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const style = m[1];
    if (style !== 'Filled') iconStyleSuffixes.add(style);
  }
}

// Scan HTML files
walk(DIST, (filePath) => {
  if (!filePath.endsWith('.html') && !filePath.endsWith('.mjs') && !filePath.endsWith('.js')) return;
  try {
    const content = readFileSync(filePath, 'utf-8');
    scan(content);
    scanForIconPackageDecl(content);
    scanForIconSelections(content);
    scanForIconStyleVariants(content);
  } catch {}
});

// Rewrite any already-downloaded JS wrappers/assets and enqueue the underlying
// framerusercontent module paths they re-export.
walk(DIST, (filePath) => {
  if (!isJavaScriptAsset(filePath)) return;
  try {
    const original = readFileSync(filePath, 'utf-8');
    const rewritten = rewriteModuleSource(original);
    scanModuleDependencies(rewritten);
    if (rewritten !== original) {
      writeFileSync(filePath, rewritten, 'utf-8');
      console.log(`  rewrote existing: ${filePath.replace(DIST, '')}`);
    }
  } catch {}
});

// Enqueue dynamically-constructed icon module URLs
if (iconPackages.size > 0 && iconSelectionNames.size > 0) {
  console.log(`\nIcon packages detected: ${[...iconPackages.entries()].map(([c,v]) => `${c}@${v}`).join(', ')}`);
  console.log(`Icon selections in use: ${[...iconSelectionNames].join(', ')}`);
  if (iconStyleSuffixes.size > 1) {
    console.log(`Icon style variants: ${[...iconStyleSuffixes].filter(Boolean).join(', ')}`);
  }
  for (const [category, version] of iconPackages) {
    for (const name of iconSelectionNames) {
      for (const styleSuffix of iconStyleSuffixes) {
        const filename = `${name}${styleSuffix}.js@${version}`;
        enqueue(`https://framer.com/m/${category}/${filename}`, `/_deps/framer/m/${category}/${filename}`);
      }
    }
  }
}

if (toDownload.length === 0) {
  console.log('No framer.com/m/ assets found');
  process.exit(0);
}

console.log(`Found ${toDownload.length} framer.com/m/ assets`);
toDownload.forEach(d => console.log(' ', d.remoteUrl));

async function download(url, localPath) {
  const fullPath = join(DIST, localPath);
  if (existsSync(fullPath)) {
    if (isJavaScriptAsset(fullPath) || fullPath.includes('/m/')) {
      const original = readFileSync(fullPath, 'utf-8');
      const rewritten = rewriteModuleSource(original);
      scanModuleDependencies(rewritten);
      if (rewritten !== original) {
        writeFileSync(fullPath, rewritten, 'utf-8');
        console.log(`  rewrote: ${localPath}`);
      } else {
        console.log(`  skip: ${localPath}`);
      }
    } else {
      console.log(`  skip: ${localPath}`);
    }
    return;
  }
  mkdirSync(dirname(fullPath), { recursive: true });
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) { console.warn(`  ⚠ ${res.status} ${url}`); return; }
    if (isJavaScriptAsset(fullPath) || localPath.includes('/m/')) {
      const text = await res.text();
      const rewritten = rewriteModuleSource(text);
      scanModuleDependencies(rewritten);
      writeFileSync(fullPath, rewritten, 'utf-8');
      console.log(`  ✓ ${localPath} (${(Buffer.byteLength(rewritten)/1024).toFixed(1)}KB)`);
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(fullPath, buf);
      console.log(`  ✓ ${localPath} (${(buf.length/1024).toFixed(1)}KB)`);
    }
  } catch (e) {
    console.warn(`  ⚠ ${url} — ${e.message}`);
  }
}

for (let i = 0; i < toDownload.length; i++) {
  const { remoteUrl, localPath } = toDownload[i];
  await download(remoteUrl, localPath);
}
console.log('Done');
