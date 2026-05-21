# framer-local-export

Site-agnostic scripts for exporting a Framer site into a self-hosted static mirror.

The pipeline downloads every page, asset, JS chunk, font, CMS binary, and icon module
referenced by the live site and rewrites all URLs to local `/_deps/` paths. The result
works on Apache, nginx, or any static host — no CDN, no service worker, no runtime shims.

## Requirements

- Node.js 20+
- Network access to the live Framer site during export

## Quick start

```bash
node scripts/export-site.js https://example.com
node server.js
# open http://localhost:8080
```

Example with element omission during export:

```bash
node scripts/export-site.js https://yoursite.com --omit-selector 'div[data-framer-name="Form"]'
```

## Pipeline

`export-site.js` runs these steps in order:

| Step | Script | What it does |
|------|--------|--------------|
| 1 | `extract.js` | Fetches every page, downloads CDN assets, rewrites HTML/JS URLs to `/_deps/` |
| 2 | `fetch-lazy-chunks.js` | Downloads missing lazy `.mjs` chunks and `.framercms` CMS binaries referenced in JS |
| 3 | `fetch-framer-modules.js` | Downloads `framer.com/m/` icon wrapper modules and rewrites their CDN imports |
| 4 | `post-process.js` | Strips Framer editor bootstrap and analytics script tags from HTML; rewrites any remaining CMS path aliases in generated JS; downloads third-party fonts (`fonts.gstatic.com`) and rewrites URLs to local paths |
| 5 | `rewrite-framercms.js` | Parses `.framercms` chunk and index files, rewrites image URLs from CDN to local paths, corrects byte-range pointer offsets in index files, downloads any referenced images that are missing |
| 6 | `audit-missing.js` | Full-scan safety net: finds any remaining `framerusercontent.com` references and downloads them |

## Options

```
node scripts/export-site.js <url> [--no-sitemap] [--max-pages N] [--omit-selector SELECTOR]
```

- `--no-sitemap` — skip sitemap.xml discovery (use link crawl only)
- `--max-pages N` — cap the number of routes crawled (default: 500)
- `--omit-selector SELECTOR` — remove matching HTML elements from every exported page before writing to `dist/`
  You can repeat the flag multiple times, and comma-separated selectors are also accepted.
  Example: `--omit-selector 'div[data-framer-name="Form"]'`

## Local server

```bash
node server.js [port]   # default port: 8080
```

The server serves `dist/` with SPA-style routing (`/about` → `dist/about/index.html`).

It also acts as a caching proxy fallback for `/_deps/framer/m/` and `/_deps/modules/`
files that are missing locally. In normal exports these files are pre-downloaded by
`fetch-framer-modules.js`, so the proxy is only an emergency net for edge cases.

## npm scripts

```bash
npm run export    # export https://janskydundera.com (adjust URL in package.json)
npm run serve     # node server.js
npm run audit     # check dist/ for remaining external references
npm run inspect   # usage: npm run inspect -- dist/_deps/modules/.../file.framercms
```

## Dev utilities

- `scripts/inspect-framercms.js <file>` — read-only parser that pretty-prints the
  structure of a `.framercms` chunk or index file. Useful for debugging CMS binary issues.

## Output layout

```
dist/
  index.html
  about-us/index.html
  project/<slug>/index.html
  news/<slug>/index.html
  404.html
  _deps/
    images/        # CDN images
    assets/        # fonts, videos
    sites/         # Framer-generated JS bundles
    modules/       # third-party Framer component modules + CMS binaries (.framercms)
    framer/m/      # icon wrapper modules (framer.com/m/...)
    third-party-assets/  # fontshare, Google Fonts, and other third-party fonts
```

## Known limitations

- **Route discovery** — routes are found via sitemap.xml + internal link crawl.
  CMS-backed routes that are not linked from any page and not in the sitemap will be
  missed.
