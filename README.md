# framer-local-export

Site-agnostic scripts for exporting a Framer site into a self-hosted static mirror.

The pipeline downloads every page, asset, JS chunk, font, CMS binary, and icon module
referenced by the live site and rewrites all URLs to local `/_deps/` paths. The result
works on Apache, nginx, or any static host — no CDN, no service worker, no runtime shims.
For Framer CMS byte-range fetches, use either the default server-assisted mode or `--static`
to pre-bake `.framercms` slices for fully static hosting.

## Requirements

- Node.js 20+
- Network access to the live Framer site during export

## Quick start

```bash
node scripts/export-site.js https://example.com
node server.js
# open http://localhost:8080
```

Example with element hiding during export:

```bash
node scripts/export-site.js https://yoursite.com --hide-selector 'div[data-framer-name="Form"]'
```

## Pipeline

`export-site.js` runs these steps in order:

| Step | Script | What it does |
|------|--------|--------------|
| 1 | `extract.js` | Fetches every page, downloads CDN assets, rewrites HTML/JS URLs to `/_deps/` |
| 2 | `fetch-lazy-chunks.js` | Downloads missing lazy `.mjs` chunks and `.framercms` CMS binaries referenced in JS |
| 3 | `fetch-framer-modules.js` | Downloads `framer.com/m/` icon wrapper modules and rewrites their CDN imports |
| 4 | `post-process.js` | Strips Framer editor bootstrap and analytics script tags from HTML; rewrites any remaining CMS path aliases in generated JS; downloads third-party fonts (`fonts.gstatic.com`) and rewrites URLs to local paths; writes Apache/nginx hosting config |
| 5 | `rewrite-framercms.js` | Parses `.framercms` chunk and index files, rewrites image URLs from CDN to local paths, corrects byte-range pointer offsets in index files, downloads any referenced images that are missing, and in `--static` mode pre-bakes byte-slice files after offsets are finalized |
| 6 | `audit-missing.js` | Full-scan safety net: finds any remaining `framerusercontent.com` references and downloads them |

## Options

```
 node scripts/export-site.js <url> [--no-sitemap] [--max-pages N] [--hide-selector SELECTOR] [--static]
```

- `--no-sitemap` — skip sitemap.xml discovery (use link crawl only)
- `--max-pages N` — cap the number of routes crawled (default: 500)
- `--hide-selector SELECTOR` — inject a `display:none` CSS rule for matching elements into every exported page.
  Repeat the flag as many times as needed; comma-separated selectors within a single value are also accepted.
  Because Framer renders many components client-side, DOM removal during export is not reliable — CSS hiding
  is used instead and takes effect the instant the element is painted, with no visible flash.
  Example: `--hide-selector 'div[data-framer-name="Form"]' --hide-selector '.cookie-banner'`
- `--static` — pre-bake `.framercms.<from>-<to>` slice files and patch the exported JS to request them directly.
  Use this for fully static hosts with no PHP/FastCGI and no special `.framercms` rewrite rules.

## Local server

```bash
 node server.js [port] [--no-rewrite]   # default port: 8080
```

The server serves `dist/` with SPA-style routing (`/about` → `dist/about/index.html`).

By default the server handles `.framercms?range=FROM-TO` requests in memory, which is
correct for non-static exports (where the browser still sends range queries).

Pass `--no-rewrite` (alias `--static`) to disable that slicing and serve all files
verbatim — use this when validating a `--static` export whose JS was patched to request
`.framercms.FROM-TO` slice files directly.

It also acts as a caching proxy fallback for `/_deps/framer/m/` and `/_deps/modules/`
files that are missing locally. In normal exports these files are pre-downloaded by
`fetch-framer-modules.js`, so the proxy is only an emergency net for edge cases.

## npm scripts

```bash
npm run export    # export https://janskydundera.com (adjust URL in package.json)
npm run serve     # node server.js
npm run audit     # check dist/ for remaining external references
```

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

- **Must be deployed to the server root** — all asset references are absolute paths starting
  with `/_deps/`. Deploying to a subfolder (e.g. `/mysite/`) will break all assets. The site
  must be served from `/` on its domain or subdomain.
- **Route discovery** — routes are found via sitemap.xml + internal link crawl.
  CMS-backed routes that are not linked from any page and not in the sitemap will be
  missed.
