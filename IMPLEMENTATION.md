# IMPLEMENTATION — Airlines Locations (Astro + Headless WordPress)

Reference this before writing code in the corresponding area. Update this file if a decision changes during the build — it must stay accurate, not aspirational.

## 1. Rendering mode

**Decided: hybrid — static landing pages, live SSR for WP content pages (`output: "hybrid"`, Node adapter, standalone mode).**

Revised from an earlier fully-static (`getStaticPaths()`) attempt once the hosting target was confirmed as **Hostinger only**, via their Node.js App feature (Business/Cloud plans — runs a persistent Node process, not a serverless platform). With an always-on Node process available anyway, SSR-on-demand is simpler than static generation: no build-time page enumeration, no rebuild-on-publish webhook, no deploy-hook wiring. `src/pages/[...slug].astro` and `src/pages/api/flight-search.ts` both set `export const prerender = false` and resolve/fetch per request; `index.astro` and `404.astro` still prerender since they're pure static content.

Crawlability is unaffected either way: Astro SSR still returns fully-formed HTML per request (no client-side render step Googlebot has to wait on), same as a prerendered file would. The only real tradeoff vs. static is a per-request WP page-tree fetch — mitigated by the TTL cache in `src/lib/wp.ts` (`PAGE_TREE_CACHE_TTL`), so most requests hit the in-memory cache rather than WP.

A WP edit shows up on the next request after the cache entry expires — no rebuild, no redeploy, nothing to trigger from WP's side.

## 2. WordPress API layer

**Decided: REST API + one custom field registration** (not WPGraphQL) — avoids adding a GraphQL plugin dependency when the core REST API already covers everything needed except the template slug.

The API response for a page includes:

| Field | Purpose |
|---|---|
| `id` | Unique identifier |
| `slug` | This page's own slug segment |
| `parent` | Parent page ID (0/null if top-level) |
| `title.rendered` | Page title |
| `content.rendered` | The copy, rendered as final HTML — not raw blocks/shortcodes |
| `wp_template` | Custom REST field (see `wordpress/rest-api-additions.php`) — the assigned page template identifier, the "class" driving layout selection |
| `menu_order` / `date` | Used for ordering children in the sidebar |
| `yoast_head_json` | Yoast's computed SEO title + meta description for this page |

`wp_template` is not exposed by the default REST API — `wordpress/rest-api-additions.php` hooks `rest_api_init` and registers it, reading `get_page_template_slug( $post_id )`. This is a backend (WP-side) dependency; it must be installed on the WP instance before a build against it will resolve layouts correctly.

**Decided: (a) — the ancestor chain is computed server-side in Astro's Node process**, not via a custom REST field. `src/lib/wp.ts` fetches the full page tree (`id`, `slug`, `parent`, `wp_template`), builds an `id → page` map, then walks `parent` links per page to compute `fullPath`. This avoids extra WP-side custom code beyond the one `wp_template` field. The fetch happens on cache-miss only (TTL-based, see §1) rather than per visitor request.

## 3. Path resolution algorithm

Implemented in `src/lib/wp.ts` / `src/pages/[...slug].astro`:

1. `byId: Map<id, page>` built from the fetched page list.
2. `computeFullPath(id)` walks `parent` upward, prepending each ancestor's slug, until reaching a page with no parent (with a cycle guard).
3. `byPath: Map<fullPath, page>` built for reverse lookup; paths and lookups are normalized (trimmed slashes, lowercased) so trailing-slash/case differences don't cause false misses.
4. `[...slug].astro` reads `Astro.params.slug` per request, calls `getPageByPath()` against the (cached) `byPath` map.
5. If not found → `return Astro.rewrite("/404")`, which renders `src/pages/404.astro` in place without changing the URL.
6. If found → the matched page's `wp_template` selects the layout (§4).

A `RESERVED_SLUGS` set in `wp.ts` (currently `""`, `"api"`) drops any WP page that would collide with a hand-built static route.

## 4. Template → layout mapping

Implemented in `src/pages/[...slug].astro` as a naming *convention*, not an exact-match table:

```ts
const isParentTemplate = /(?:^|[-/])parent\.php$/i.test(page.template);
const isChildTemplate = /(?:^|[-/])child\.php$/i.test(page.template);
const Layout = isParentTemplate ? ParentPageLayout : isChildTemplate ? ChildPageLayout : DefaultPageLayout;
```

Any WP template file ending in `parent.php` — bare (`parent.php`) or prefixed (`parking-parent.php`, `page-templates/parent.php`) — gets `ParentPageLayout`; anything ending in `child.php` gets `ChildPageLayout`. A brand-new section (Parking, Terminals, Map, Passenger Info, Car Rental, Lounges, ...) therefore needs **no Astro code change**: assign it a `<section>-parent.php` / `<section>-child.php` template pair in WP and it renders correctly immediately.

Section membership (which pages belong under which parent) comes from WordPress's native page `parent` field via `getChildren()`/`getAncestorChain()`/`getSiblings()` in `wp.ts` — the template *name* only decides which layout component renders the page, it plays no part in grouping pages together.

- `ParentPageLayout` — hero (`<h1>` + `<Breadcrumbs>`), then a two-column split: content on the left, `<PageSidebar>` on the right populated via `getLatestPages()` (the site's most recently published pages, independent of section). Below that, `<RelatedPages>` lists this page's direct children via `getChildren(page.id)`.
- `ChildPageLayout` — renders `<RelatedPages>` populated via `getSiblings(page.id)` (entries whose `parent === currentPage.parent`, excluding the current page).
- Any template string matching neither suffix (including no template at all, e.g. `home`/`blog`) falls through to `DefaultPageLayout` — never throws or blank-pages on an unrecognized template.

## 5. Folder structure (as built)

```
/src
  /layouts
    ParentPageLayout.astro
    ChildPageLayout.astro
    DefaultPageLayout.astro
    BaseLayout.astro          (shared header/footer/head, used by all layouts)
  /components
    PageSidebar.astro
    RelatedPages.astro
    Breadcrumbs.astro
    FlightSearchBar.astro      (AviationStack island, vanilla JS, no framework)
    Header.astro
    Footer.astro
  /lib
    wp.ts                      (WP API client, page-tree cache, path resolution, meta resolution)
    aviationstack.ts            (server-side AviationStack client, used only inside /pages/api)
  /pages
    index.astro                 (static homepage, prerendered)
    404.astro                    (static, prerendered)
    [...slug].astro              (catch-all for WP content pages, live SSR — prerender = false)
    sitemap.xml.ts               (dynamic — reflects the live page tree, prerender = false)
    robots.txt.ts                (dynamic — Sitemap line always matches SITE_URL)
    /api
      flight-search.ts          (live SSR; proxies AviationStack)
  /styles
    global.css                  (Tailwind entry + @font-face + prose layer)
  /assets
    /fonts                      (drop licensed .woff2 files here — see fonts/README.md)
astro.config.mjs
tailwind.config.mjs
.env.example
wordpress/
  rest-api-additions.php        (wp_template REST field only — see §2/§11)
```

## 6. AviationStack search bars

- Live only inside specific `.astro` page files (homepage hero; add a dedicated flight-status page the same way), never sourced from or configured through WordPress.
- `FlightSearchBar.astro` is plain HTML (a `<form>`) plus one vanilla `<script>` — deliberately not a hydrated framework island, to keep the JS payload on static pages as close to zero as possible.
- The script calls `src/pages/api/flight-search.ts`, a server route — never calls AviationStack directly from the browser, so the API key stays server-side.
- `flight-search.ts` reads `AVIATIONSTACK_API_KEY` from env; `src/lib/aviationstack.ts` applies an in-memory cache (keyed by query params, TTL from `AVIATIONSTACK_CACHE_TTL`) before calling out, and only caches successful/no-result responses (not errors/rate-limits).
- UI handles loading (`"Searching…"` placeholder text), no-results, and upstream error/rate-limit states without ever throwing past the surrounding static page.

## 7. Content rendering safety

- WP's `content.rendered` HTML is inserted via Astro's raw-HTML mechanism (`set:html`). Trust boundary: content comes only from authenticated WP editors, not public user input — acceptable to render as-is.
- The rendered content block is scoped under a `.prose` class (`src/styles/global.css`) with typography defaults for headings, paragraphs, lists, links, images, blockquotes, and tables, since WP's block editor output assumes WP core CSS, which isn't loaded here.
- WP media images render as plain `<img>` tags with the original WP URL (no `astro:assets` proxy/optimization — avoids extra build-time image processing against an external host, which matters more once the page tree is large). The WP media host is still allow-listed in `astro.config.mjs`'s `image.domains` in case a specific page later opts into `astro:assets`.
- **Revisited**: WP now does carry public, user-submitted content through a `set:html`-rendered field — comments (`WPComment.content`, `src/components/CommentSection.astro`). Trust boundary there is different from page content: it's not "authenticated editor only", it's "sanitized by WP's own fixed inline-tag allowlist" (`wp_kses` on WP's `pre_comment_content` filter, applied before storage) plus "only ever fetched unauthenticated", which forces WP's REST API to filter to `status=approve` regardless of what's requested — so nothing reaches the frontend that hasn't both passed WP's tag allowlist and been approved in the WP dashboard. See `getApprovedComments()`/`submitComment()` in `src/lib/wp.ts`.

## 8. Yoast SEO integration

Implemented once, in `resolvePageMeta(page, siteSettings)` in `src/lib/wp.ts`, called from `[...slug].astro` and passed into whichever layout renders `BaseLayout`.

**Per-page resolution logic, in order:**

1. If `yoast_head_json.title` exists and is non-empty → use it as the `<title>` tag.
2. Else → fall back to `"{Page Title} – {Site Title}"`, where `{Page Title}` is `title.rendered` and `{Site Title}` comes from `getSiteSettings()` (fetches the WP root `/wp-json` endpoint once, cached alongside the page tree with the same TTL).
3. Same pattern for meta description: `yoast_head_json.description` if present and non-empty, otherwise the `<meta name="description">` tag is omitted entirely (no placeholder copy invented).
4. `og_title`, `og_description`, `og_image[0].url`, and `canonical` are pulled the same way and passed through to `BaseLayout`, which falls back to the resolved title/description for `og:title`/`og:description` when the Yoast-specific OG fields are absent, and to `Astro.url` when no Yoast canonical is set.

Static/landing pages (`index.astro`, `404.astro`) set `title`/`description` directly in frontmatter — no WP record to check, so they skip this chain entirely.

## 9. Environment variables

```
STAGING=true
SITE_URL=https://airlineairportguide.com
WP_API_URL=https://cms.airlineairportguide.com/wp-json/wp/v2
AVIATIONSTACK_API_KEY=
AVIATIONSTACK_CACHE_TTL=120
PAGE_TREE_CACHE_TTL=300
SITE_TITLE=Airlines Locations
```

**`STAGING`** (`src/lib/config.ts`) blocks search engines while the site isn't ready: `robots.txt` (`src/pages/robots.txt.ts`) serves `Disallow: /` instead of the real sitemap-referencing version, and `BaseLayout.astro` renders a site-wide `<meta name="robots" content="noindex, nofollow">`. Defaults to blocked (`true`) whenever unset, so it can't accidentally ship open by omission — set to `false` and **rebuild** to go live (the homepage/404 bake the meta tag in at build time since they're prerendered; only the SSR content-page routes would otherwise pick it up live).

**Two separate domains, two separate variables** (see §11) — `SITE_URL` is the Node app's own domain (feeds the `<link rel="canonical">` fallback and the `sitemap.xml`/`robots.txt` base URL); `WP_API_URL` is WordPress's REST API on its own subdomain, a distinct vhost with no relationship to `SITE_URL` in code. There's no derivation between them (an earlier version of this project had WP living in a subfolder of the same domain, which made that derivation possible — this was replaced once WordPress moved to its own subdomain).

`src/lib/wp.ts` and `src/lib/aviationstack.ts` read these via `process.env` (not `import.meta.env`) specifically so they're live on the running Node process — changing a value in Hostinger's Node.js App environment-variables panel and restarting the app is enough, no rebuild needed. The one exception is `astro.config.mjs`'s `site` (built from `SITE_URL`, used for the canonical fallback and the `sitemap.xml`/`robots.txt` base URL) — that's read at build time, so a `SITE_URL` change needs one rebuild to take effect everywhere.

## 10. Naming conventions

- Astro components: PascalCase file names, one component per file.
- WP API client functions: verb-first — `getPageTree()`, `getPageByPath()`, `getChildren(id)`, `getSiblings(id)`, `getSiteSettings()`, `getAncestorChain()`.
- All WP-fetching logic stays inside `src/lib/wp.ts` — no ad-hoc `fetch()` calls to the WP API scattered across components or pages.

## 11. Deployment

**Decided: Hostinger only** — Business or Cloud plan (required for the "Setup Node.js App" hPanel feature; plain shared hosting can't run a Node process). WordPress and the Astro app are **separate subdomains on the same Hostinger account**, not a shared domain with a subfolder split (an earlier version of this plan used a `public_html/wordpress` subfolder — replaced once the domain layout was finalized):

- `airlineairportguide.com` — the Astro Node app, root domain.
- `cms.airlineairportguide.com` — a separate Hostinger subdomain, its own document root, a standard (non-headless-special) WordPress install.

Because these are two distinct vhosts, there's no path-routing conflict to configure at all — each subdomain's webserver only ever sees requests meant for it. This is simpler than the subfolder approach, which needed Hostinger to route `/wordpress/*` to WP ahead of the Node app.

- The Astro project builds with `@astrojs/node` in `standalone` mode (`astro.config.mjs`), producing `dist/` (static assets + `dist/server/entry.mjs`). Hostinger's Node.js App feature runs that entry file as a persistent process bound to the `airlineairportguide.com` subdomain/application-URL slot; Passenger (Hostinger's Node process manager) sets `PORT`/`HOST` env vars that `@astrojs/node` standalone reads automatically — no manual port wiring needed.
- Set `SITE_URL`, `WP_API_URL`, `AVIATIONSTACK_API_KEY`, `AVIATIONSTACK_CACHE_TTL`, `PAGE_TREE_CACHE_TTL`, `SITE_TITLE` directly in the Node.js App's environment-variables panel in hPanel — there's no `.env`-file loading in production, only the actual process environment (see §9).
- No deploy hook / rebuild trigger is needed for content edits (§1) — only redeploy (rebuild + restart the Node app) when the Astro *code* changes, not when WP content changes.
- CORS is still not required on the WP side (§2) — the subdomain split doesn't change this, since the Astro Node process fetches WP server-side either way, never from the visitor's browser.

## 12. Explicit placeholder markers

Use consistently, so they're greppable later:
- `<!-- TODO: ACF field integration -->`
- `<!-- TODO: Ask/AI widget mount point -->`
- `<!-- TODO: SEO plugin meta fields -->`
