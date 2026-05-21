#!/usr/bin/env node

import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const args = process.argv.slice(2);
const originArg = args.find((arg) => arg.startsWith("http"));
const omitSelectors = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--hide-selector" && args[i + 1]) {
    omitSelectors.push(args[i + 1]);
    i++;
  }
}

if (!originArg) {
  console.error(
    "Usage: node scripts/export-site.js <origin> [--no-sitemap] [--max-pages N] [--hide-selector SELECTOR]"
  );
  process.exit(1);
}

const origin = new URL(originArg).origin;
const useSitemap = !args.includes("--no-sitemap");
const maxPagesFlag = args.indexOf("--max-pages");
const maxPages =
  maxPagesFlag !== -1 && args[maxPagesFlag + 1]
    ? Number.parseInt(args[maxPagesFlag + 1], 10)
    : 500;

function runStep(label, scriptArgs) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(process.execPath, scriptArgs, {
    cwd: ROOT,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function normalizePathname(pathname) {
  if (!pathname || pathname === "/") return "/";
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function shouldSkipPath(pathname) {
  return (
    pathname.startsWith("/_framer") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/cdn-cgi") ||
    pathname.includes(".")
  );
}

function extractInternalLinks(html, pageOrigin) {
  const found = new Set();
  const hrefPattern = /\shref="([^"]+)"/g;
  let match;

  while ((match = hrefPattern.exec(html)) !== null) {
    const rawHref = match[1];
    if (
      rawHref.startsWith("#") ||
      rawHref.startsWith("mailto:") ||
      rawHref.startsWith("tel:") ||
      rawHref.startsWith("javascript:")
    ) {
      continue;
    }

    try {
      const url = new URL(rawHref, pageOrigin);
      if (url.origin !== pageOrigin) continue;
      if (shouldSkipPath(url.pathname)) continue;
      found.add(normalizePathname(url.pathname));
    } catch {
      // Ignore malformed URLs in page markup.
    }
  }

  return found;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }

  return res.text();
}

async function discoverFromSitemap(siteOrigin) {
  const routes = new Set();
  const sitemapUrls = [`${siteOrigin}/sitemap.xml`, `${siteOrigin}/sitemap_index.xml`];

  for (const sitemapUrl of sitemapUrls) {
    try {
      const xml = await fetchHtml(sitemapUrl);
      const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1].trim());
      for (const loc of locs) {
        try {
          const url = new URL(loc);
          if (url.origin !== siteOrigin) continue;
          if (shouldSkipPath(url.pathname)) continue;
          routes.add(normalizePathname(url.pathname));
        } catch {
          // Ignore malformed sitemap entries.
        }
      }
      if (routes.size > 0) break;
    } catch {
      // Try the next common sitemap path.
    }
  }

  return routes;
}

async function crawlRoutes(siteOrigin, seedRoutes, limit) {
  const confirmed = new Set(seedRoutes);
  const queued = new Set(seedRoutes);
  const queue = [...seedRoutes];

  while (queue.length > 0 && queued.size < limit) {
    const route = queue.shift();
    const url = new URL(route, siteOrigin).href;

    try {
      const html = await fetchHtml(url);
      confirmed.add(route);
      const links = extractInternalLinks(html, siteOrigin);
      for (const link of links) {
        if (queued.has(link)) continue;
        queued.add(link);
        queue.push(link);
        if (queued.size >= limit) break;
      }
    } catch (err) {
      console.warn(`  Warning: failed to crawl ${url} (${err.message})`);
    }
  }

  return [...confirmed].sort();
}

async function discoverRoutes(siteOrigin, options) {
  const routes = new Set(["/"]);

  if (options.useSitemap) {
    const sitemapRoutes = await discoverFromSitemap(siteOrigin);
    for (const route of sitemapRoutes) routes.add(route);
  }

  return crawlRoutes(siteOrigin, routes, options.maxPages);
}

async function main() {
  console.log(`Source: ${origin}`);
  const routes = await discoverRoutes(origin, { useSitemap, maxPages });
  console.log(`Discovered ${routes.length} routes`);

  runStep("Extract site", [
    join("scripts", "extract.js"),
    origin,
    "--pages",
    routes.join(","),
    ...omitSelectors.flatMap((selector) => ["--hide-selector", selector]),
  ]);
  runStep("Fetch lazy chunks", [join("scripts", "fetch-lazy-chunks.js")]);
  runStep("Fetch Framer modules", [join("scripts", "fetch-framer-modules.js")]);
  runStep("Post-process export", [join("scripts", "post-process.js")]);
  runStep("Rewrite CMS chunks", [join("scripts", "rewrite-framercms.js")]);
  runStep("Audit missing assets", [join("scripts", "audit-missing.js")]);
}

main().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
