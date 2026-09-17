# Deploying to Hostinger

Concrete steps for this project's specific setup: WordPress on its own subdomain (`cms.airlineairportguide.com`), the Astro app running as a Node app on the root domain (`airlineairportguide.com`), both on the same Hostinger account. See `IMPLEMENTATION.md` §11 for the reasoning behind these choices.

## 0. Prerequisites

- A Hostinger **Business** or **Cloud** plan (required — the "Setup Node.js App" feature in hPanel isn't on plain shared hosting).
- The domain `airlineairportguide.com` added to that hosting account.

## 1. Create the `cms` subdomain and install WordPress there

1. In hPanel → **Domains → Subdomains**, create `cms.airlineairportguide.com`. Hostinger gives it its own document root (e.g. `public_html/cms.airlineairportguide.com/` or similar — hPanel shows the exact path).
2. Run the WordPress auto-installer targeting that subdomain's document root.
3. Log into `cms.airlineairportguide.com/wp-admin`, create the Pages you need with the correct parent/child structure, and assign page templates (this is what `wp_template` reads — Phase 0 in `TASKS.md`).
4. Install `wordpress/rest-api-additions.php` from this repo as a must-use plugin: upload it to that subdomain's `wp-content/mu-plugins/rest-api-additions.php` (create the `mu-plugins` folder if it doesn't exist — anything in there auto-activates, no plugin-list step needed).
5. Sanity-check: visit `cms.airlineairportguide.com/wp-json/wp/v2/pages` and confirm each page object includes a `wp_template` field.
6. If SEO fields matter, install/activate Yoast SEO on this WP install and confirm `yoast_head_json` shows up on the same endpoint.

Because this is a separate subdomain (its own vhost), there's no path-routing conflict to worry about with the Node app below — each domain only ever sees requests meant for it.

## 2. Set the environment variables

```
STAGING=true
SITE_URL=https://airlineairportguide.com
WP_API_URL=https://cms.airlineairportguide.com/wp-json/wp/v2
```

`SITE_URL` is baked into the build (canonical tags, sitemap/robots base URL — see `IMPLEMENTATION.md` §9), so decide it before building. It's also which of www/non-www is canonical: `src/middleware.ts` 301s whichever host *isn't* `SITE_URL` to whichever one *is* — non-www here, so `www` redirects to non-www. (This is set to non-www specifically because Hostinger's own edge/CDN already redirects `www` → non-www ahead of the app for this domain, independent of anything in this repo — matching that instead of fighting it. If that's ever removed/changed on Hostinger's side, swap `SITE_URL` back to the www host to flip the direction; no code change needed either way.) `WP_API_URL` is read live at runtime, so it can change later without a rebuild. `STAGING=true` keeps the site out of search engines until you're ready to go live (§6) — leave it on for now.

## 3. What to zip and upload

Zip **only the source** — no `node_modules/`, no `dist/`. `package.json` has a `postinstall` script (`astro build`), so Hostinger's own `npm install` step builds `dist/` on the server automatically; you never need to build locally or include build output in the zip.

```
src/
public/
wordpress/                 (reference only — its contents get installed on the cms subdomain, not here; harmless to include)
astro.config.mjs
package.json
package-lock.json
tailwind.config.mjs
tsconfig.json
.env.example                (optional — reference only, actual values go in hPanel's env-variables panel)
```

Leave out: `node_modules/`, `dist/`, `.astro/` (Astro's local build cache), `.env` (never upload real secrets in a zip), `.git/`, and the `.md` docs (`README.md`, `IMPLEMENTATION.md`, `TASKS.md`, `DEPLOYMENT.md` — reference-only, not needed for the app to run, but harmless if included).

## 4. Upload and set up the Node.js App in hPanel

1. Upload that zip to a folder outside `public_html` that hPanel's Node.js App tool can point at (a common layout is `~/airlines-locations-app/`), then extract it there.
2. In hPanel → **Advanced → Node.js**, create a new application:
   - **Node version**: match what you built/tested locally (18+).
   - **Application root**: the folder from step 1 (e.g. `airlines-locations-app`).
   - **Application startup file**: `dist/server/entry.mjs`.
   - **Application URL**: `airlineairportguide.com` (the root domain — separate from the `cms.` subdomain WordPress uses).
3. In the same panel, add **environment variables**: `STAGING`, `SITE_URL`, `WP_API_URL`, `AVIATIONSTACK_API_KEY`, `AVIATIONSTACK_CACHE_TTL`, `AVIATIONSTACK_BOARD_CACHE_TTL`, `PAGE_TREE_CACHE_TTL`, `SITE_TITLE`. Leave `STAGING=true` (or unset) while this is being built out — it blocks search engines (see §6). Passenger (Hostinger's process manager) injects `PORT`/`HOST` itself — don't set those. `AVIATIONSTACK_BOARD_CACHE_TTL` (seconds, default 21600 = 6h) controls the homepage welcome-section board specifically — it fetches automatically on every cold page load regardless of visitor searches, so on a capped AviationStack plan (the free tier is 100 calls/*month*) this needs to stay long or passive homepage traffic alone exhausts the quota. `AVIATIONSTACK_CACHE_TTL` covers the user-initiated search boxes instead and can stay shorter.
4. Run the panel's "npm install" action (or it may run automatically on save), then start/restart the app.

## 5. Verify

- `airlineairportguide.com/` — homepage loads.
- `airlineairportguide.com/flights/departures` (or whatever nested page exists in WP) — resolves through the live WP fetch.
- `airlineairportguide.com/robots.txt` — should read `Disallow: /` for now (see §6 — this is expected while `STAGING=true`).
- `cms.airlineairportguide.com/wp-admin` — WordPress admin loads independently of the Node app.
- Edit a WP page's title, wait `PAGE_TREE_CACHE_TTL` seconds (default 300), refresh the frontend page — confirm it updates with no redeploy.

## 6. Going live (out of staging)

While `STAGING` is `true`/unset, `robots.txt` disallows everything and every page carries a `noindex, nofollow` meta tag — search engines won't index the site. When it's actually ready:

1. Set `STAGING=false` in the Node.js App environment-variables panel.
2. Re-run hPanel's "npm install" action — no file changed, but this re-triggers the `postinstall` build (`astro build`), which is what actually bakes the new `STAGING` value into the prerendered homepage/404 pages. A plain restart alone won't do this since it doesn't re-run `npm install`.
3. Restart the app.
4. Confirm `airlineairportguide.com/robots.txt` now shows `Allow: /` and a `Sitemap:` line, and that a page's `<head>` no longer has the `noindex` meta tag.

## Future changes

Only `SITE_URL`/`WP_API_URL` and the redeploy step matter if either domain ever changes — e.g. moving WordPress to a different subdomain just means updating `WP_API_URL` in the Node.js App environment-variables panel and restarting (no rebuild needed, since it's read live). Changing `SITE_URL` needs a rebuild + redeploy, since it's baked into the sitemap/canonical output.
