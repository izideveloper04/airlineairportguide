# Airlines Locations — Astro Frontend + Headless WordPress Backend

## Overview

The frontend is built in **Astro**. **WordPress stays installed and running purely as a headless CMS** — editors publish Pages and Posts there, but nothing from the WP theme layer is rendered to visitors. Astro fetches content from WordPress's API and renders it with its own design system.

Three kinds of pages exist in this project, and they must not be confused during build:

1. **Static/landing pages** — hand-built directly as `.astro` files (homepage, 404, anything with bespoke layout or interactive widgets like the AviationStack search). `index.astro` and `404.astro` do **not** pull content from WordPress and prerender to plain HTML at build time.
2. **Content pages** — Pages published in WordPress. Astro fetches these live, per request (title, content HTML, parent relationship, assigned template), through a short in-memory cache, and renders them through a shared layout system via `src/pages/[...slug].astro`. Editors control these entirely from WP admin; an edit shows up on the next request once the cache entry expires — no rebuild, no redeploy, nothing to trigger from WP's side (see rendering-mode decision in `IMPLEMENTATION.md`).
3. **Hand-built directory/listing pages** — `src/pages/blog.astro` and `src/pages/airlines.astro`. These are real `.astro` files (not WP records) but still render live (`prerender = false`) and pull from WordPress: `blog.astro` lists all published WP posts, `airlines.astro` lists every WP page using the airline template regardless of tree position, with server-side search (`?q=`). Their slugs (`blog`, `airlines`) are reserved in `RESERVED_SLUGS` (`src/lib/wp.ts`) so a WP page can never shadow them.

## URL structure — must mirror WordPress exactly

WordPress's own parent/child page hierarchy is the source of truth for the URL. If "Departures" is a child of "Flights" in WP admin, the live URL must be:

```
domain.com/flights/departures
```

Astro does not invent its own routing scheme for content pages — it resolves the full nested path by walking each page's WordPress ancestor chain and reproduces it exactly. See `IMPLEMENTATION.md` for the resolution algorithm.

## Page templates ("classes") carry through from WordPress

Every WP page has an assigned page template (e.g. a "Parent" template vs a "Child" template). This assignment is not cosmetic here — it's data. Astro fetches which template each page uses and uses that to decide:
- Which Astro layout component wraps the page
- Whether it renders a sidebar of child pages ("Parent" template)
- Whether it renders a "Related Pages" block of sibling pages ("Child" template)

## Tech stack

- **Astro**, hybrid output (`output: "hybrid"`) with the `@astrojs/node` adapter (standalone mode) — the homepage and 404 prerender to plain HTML at build time; WP content pages and the flight-search route render live per request on a persistent Node process. Deployed on **Hostinger only**, via their Node.js App feature (Business/Cloud plans) — see `IMPLEMENTATION.md` §11 for the full deployment writeup and why this replaced an earlier fully-static attempt.
- **WordPress** — headless CMS only, installed on its own Hostinger subdomain (`cms.airlineairportguide.com`, separate from the Astro app's `airlineairportguide.com`), exposing content via the core REST API plus one custom field (`wp_template`, see `wordpress/rest-api-additions.php`). WPGraphQL was considered and rejected to avoid an extra plugin dependency for something the REST API already covers.
- **Tailwind CSS** — styling, self-hosted build via `@astrojs/tailwind`, no CDN.
- **AviationStack API** — flight search, implemented as zero-JS-framework islands (`HeroFlightSearch.astro` for the homepage hero's three search pills, `FlightBoard.astro` to render results) living directly in the relevant `.astro` files, calling a server-side proxy route (`src/pages/api/flight-search.ts`) so the API key never reaches the browser.
- **`src/middleware.ts`** — runs on every request: 301-redirects the non-canonical `www`/non-`www` host to whichever `SITE_URL` names, and sets baseline security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS) on every response.

`SITE_URL` (the Astro app's domain) and `WP_API_URL` (WordPress's subdomain) are the two variables that name the two domains — see `IMPLEMENTATION.md` §9/§11 for how `SITE_URL` flows through to canonical tags, sitemap and robots.txt.

## Pre-launch staging gate

`STAGING` (env var, defaults to `true` — see `src/lib/config.ts`) blocks the site from being indexed or listed anywhere until explicitly flipped: while staging, `robots.txt` serves `Disallow: /`, and `sitemap.xml`/`llms.txt` both serve an empty "not yet publicly available" placeholder instead of the real page tree. Flip `STAGING=false` in Hostinger's Node.js App env-var panel (no rebuild needed) to go live.

## Content flow (content pages only)

```
Editor publishes/edits a Page in WP admin
        ↓
Visitor requests the resolved path — Astro (Node process) checks its page-tree cache
        ↓
Cache miss (or expired) → fetches page tree + content HTML, parent ID, slug, assigned template from WP
        ↓
[...slug].astro resolves the path against the tree and renders it inside the matching layout
        ↓
Layout adds sidebar / related pages based on the template + parent-child data
```

Content HTML is copied through as-is from WordPress — no rewriting of the editorial content itself. Astro controls the surrounding chrome (header, footer, sidebar, typography system), not the copy.

## Project layout

See `IMPLEMENTATION.md` §5 for the full folder structure and `src/lib/wp.ts` / `src/lib/aviationstack.ts` for the two data-access modules. `wordpress/rest-api-additions.php` is the one required backend change (Phase 0) — install it before running a build against a real WP instance.

Besides the WP content routes, the site also serves three generated, always-dynamic text endpoints — `sitemap.xml.ts`, `robots.txt.ts`, and `llms.txt.ts` — each reflecting the live WP page tree at request time (respecting the `STAGING` gate above) so nothing needs manual edits when content changes.

## Local dev setup

1. WordPress instance running (local or staging) with `wordpress/rest-api-additions.php` installed (adds the `wp_template` REST field — see `IMPLEMENTATION.md`, Phase 0).
2. `npm install` in the Astro project.
3. Copy `.env.example` to `.env`, set:
   - `SITE_URL` (the Astro app's own domain)
   - `WP_API_URL` (WordPress's REST API, on its own subdomain)
   - `AVIATIONSTACK_API_KEY`
   - `AVIATIONSTACK_CACHE_TTL`
   - `STAGING` (set to `false` locally to see the real sitemap/robots/llms.txt output instead of the pre-launch placeholder)
4. `npm run dev` — Astro dev server.
5. Tailwind builds through Astro's Vite pipeline — no separate watch process needed.
6. For a production-shaped local test: `npm run build && npm start` (runs the built Node server directly, same as Hostinger would).

## Non-goals for this phase

- No visual theme/plugin work inside WordPress itself — WP is data-entry only.
- No ACF wiring yet — template/parent data comes from core WP fields plus the minimal custom REST field addition in `wordpress/rest-api-additions.php`.
- No chatbot/"Ask" widget yet.
- No CDN-hosted fonts, CSS frameworks, or JS libraries anywhere in the Astro project.
