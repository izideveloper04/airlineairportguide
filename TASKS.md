# TASKS — Airlines Locations (Astro + Headless WordPress)

Work through phases in order. Check off items as completed. Do not begin a phase before the prior phase's items are checked.

## Phase 0 — WordPress-side API preparation

Requires access to the real WP instance to verify/apply — the Astro-side dependency (`wordpress/rest-api-additions.php`) is written and ready to install, but these boxes stay unchecked until confirmed against an actual site.

- [x] Confirm which pages/posts exist in WP and their intended parent/child structure — confirmed live on `cms.airlineairportguide.com`: 10 pages (`home`, `blog` top-level with no template; `parent-page` top-level with `page-templates/parent.php`; 10 children of `parent-page` with `page-templates/child.php`) — structure is currently placeholder/Lorem Ipsum content, real content still to be authored
- [x] Decide REST API (with custom field registration) vs WPGraphQL — decided REST API, see `IMPLEMENTATION.md` §2
- [x] Expose the assigned page template identifier per page via the API — confirmed live: `wp_template` values match `TEMPLATE_LAYOUT_MAP` in `src/pages/[...slug].astro` exactly
- [x] Expose parent ID and computed ancestor slug chain per page via the API — parent ID is native; ancestor chain is computed build-side from the page tree (decision (a), no extra WP field needed), see `IMPLEMENTATION.md` §2
- [x] Confirm `content.rendered` (or GraphQL equivalent) returns fully resolved HTML, not raw block/shortcode markup — confirmed live: resolved `<h3>`/`<p>` tags, no raw shortcodes or block comments
- [x] Enable CORS on the WP instance for the Astro frontend's domain(s) — not needed: WP is fetched server-side from the Astro Node process, never from the browser, so browser CORS restrictions don't apply (see `IMPLEMENTATION.md` §2, `wordpress/rest-api-additions.php`)
- [ ] Confirm image URLs returned in content point to publicly accessible WP media library URLs — not yet testable: no page currently has an embedded image (`featured_media` is 0 on all pages checked)

## Phase 1 — Astro project scaffold
- [x] Initialize Astro project
- [x] Choose and install rendering adapter for on-demand (SSR) pages — `@astrojs/node` (standalone mode), for Hostinger's Node.js App feature (see rendering-mode decision, `IMPLEMENTATION.md` §1)
- [x] Install Tailwind via Astro's official integration (no CDN)
- [x] Self-host font files under `src/assets/fonts/`, add `@font-face` rules — `@font-face` rules are in; actual `.woff2` binaries still need to be dropped in (see `src/assets/fonts/README.md`)
- [x] Set up `.env.example` with `SITE_URL` (the single root-domain variable — see `IMPLEMENTATION.md` §9), `AVIATIONSTACK_API_KEY`, `AVIATIONSTACK_CACHE_TTL`
- [x] Configure `astro.config.mjs`: output mode, allowed remote image domains for WP media

## Phase 2 — WordPress data layer
- [x] Build a typed API client module (`src/lib/wp.ts`) wrapping fetch calls to WP
- [x] Function: fetch full page tree (id, slug, parent, template) — `getPageTree()`
- [x] Function: fetch single page by resolved full path — `getPageByPath()`
- [x] Function: fetch children of a given page ID (for sidebar) — `getChildren()`
- [x] Function: fetch siblings of a given page ID (for related pages) — `getSiblings()`
- [x] Add a caching layer around these calls — module-level TTL cache in `wp.ts`

## Phase 3 — Path resolution for content pages
- [x] Build the ancestor-walking function — `computeFullPath()` / `getAncestorChain()` in `wp.ts`
- [x] Build the reverse lookup — `byPath` map, queried per-request by `getPageByPath()`
- [x] Implement catch-all dynamic route (`src/pages/[...slug].astro`, live SSR — `prerender = false`)
- [x] Handle 404 correctly when no matching WP page exists for a path — `Astro.rewrite("/404")`
- [x] Handle trailing slash / case consistency between WP slugs and incoming URLs — `normalizePath()` in `wp.ts`

## Phase 4 — Template-to-layout mapping
- [x] Define template → layout resolution — convention-based suffix matching (`*-parent.php` → `ParentPageLayout`, `*-child.php` → `ChildPageLayout`) rather than a static per-template table, so new sections need zero code changes; see `IMPLEMENTATION.md` §4
- [x] Build `layouts/ParentPageLayout.astro`
- [x] Build `layouts/ChildPageLayout.astro`
- [x] Build a fallback/default layout — `DefaultPageLayout.astro`
- [x] Confirm the layout choice is driven entirely by the fetched template field, not the URL depth

## Phase 5 — Sidebar & related pages components
- [x] `components/PageSidebar.astro`
- [x] `components/RelatedPages.astro`
- [x] `components/Breadcrumbs.astro`

## Phase 6 — Static/landing pages
- [x] Identify and list every page that is hand-built in Astro rather than sourced from WP — currently just the homepage (`src/pages/index.astro`); add further landing pages the same way as needed
- [x] Build these as standalone `.astro` files with `prerender = true`
- [x] Confirm none of these accidentally collide with the `[...slug].astro` catch-all route — `RESERVED_SLUGS` in `wp.ts` (`""`, `"api"`) drops any WP page matching a reserved static path; not otherwise a concern since WordPress is on its own subdomain, a separate route space entirely

## Phase 7 — AviationStack search bars
- [x] Build the search bar UI component directly inside the relevant Astro page file(s) — `components/FlightSearchBar.astro`, used from `index.astro`
- [x] Build server-side proxy route (`src/pages/api/flight-search.ts`)
- [x] Add response caching (respecting `AVIATIONSTACK_CACHE_TTL`) — `src/lib/aviationstack.ts`
- [x] Wire the component as a client island — implemented as a plain vanilla `<script>`, no framework hydration needed (see `IMPLEMENTATION.md` §6)
- [x] Handle empty/error states in the UI

## Phase 8 — Styling
- [x] Define design tokens (colors, spacing, typography scale) — `tailwind.config.mjs`
- [x] Apply consistent header/footer chrome — `Header.astro` / `Footer.astro` via `BaseLayout.astro`
- [x] Style the content HTML block coming from WP — `.prose` layer in `src/styles/global.css`

## Phase 9 — Content rendering safety
- [x] Decide and document how WP's rendered HTML is inserted and the trust boundary — `IMPLEMENTATION.md` §7
- [x] Confirm embedded WP images render correctly and are covered by the allowed remote domains config — plain `<img>` tags, WP media host allow-listed in `astro.config.mjs`
- [x] Strip or handle WP-specific markup that doesn't make sense outside WP theme context — handled via the `.prose` typography layer rather than markup stripping

## Phase 10 — SEO
- [x] Confirm Yoast SEO's REST fields are exposed on the WP page endpoint — confirmed live: `yoast_head_json` present with title/description on every page checked (current values are placeholder/duplicated across pages — content authoring task, not a code issue)
- [x] Fetch Yoast's meta title and meta description per content page — `resolvePageMeta()` in `wp.ts`
- [x] Implement fallback when Yoast fields are empty — documented and implemented in `IMPLEMENTATION.md` §8 / `resolvePageMeta()`
- [x] Apply the same fetch-with-fallback logic to static/landing pages, or hardcode their meta directly — hardcoded directly in `index.astro`/`404.astro` frontmatter (no WP record for these)
- [x] Generate canonical URLs matching the resolved nested path structure — `resolvePageMeta()` + `BaseLayout.astro` fallback to `Astro.url`
- [x] Generate a sitemap reflecting the same nested paths — custom `src/pages/sitemap.xml.ts` (dynamic, reads the live page tree — the static `@astrojs/sitemap` integration can't enumerate SSR'd routes at build time)

## Phase 11 — Deployment
- [x] Choose hosting/adapter target (document choice and why) — Hostinger only (Business/Cloud plan, Node.js App feature), `@astrojs/node` standalone adapter, see `IMPLEMENTATION.md` §11
- [x] Set up a rebuild/revalidation trigger for statically-prerendered content — not applicable: no content pages are statically prerendered (see `IMPLEMENTATION.md` §1), WP edits show up live within `PAGE_TREE_CACHE_TTL`
- [ ] Set production environment variables — `SITE_URL` (`airlineairportguide.com`), `WP_API_URL` (`cms.airlineairportguide.com`), `AVIATIONSTACK_API_KEY`, etc. directly in the Node.js App environment-variables panel in hPanel; needs the real AviationStack key, can't be filled in from here

## Phase 12 — QA

Needs a real WP instance + deployed build to execute — not yet run.

- [ ] Test a deeply nested page path (3+ levels) resolves correctly — not yet testable: no grandchild page exists in WP yet (all 10 child pages are direct children of `parent-page`, no third level)
- [x] Test a page with no parent (top-level) resolves correctly — confirmed live: `/blog` (top-level, no parent) resolves correctly
- [x] Test a page whose template isn't in the mapping table falls back gracefully — confirmed live: `/blog` has an empty `wp_template` (not in `TEMPLATE_LAYOUT_MAP`) and correctly falls back to `DefaultPageLayout`
- [ ] Test AviationStack search bar failure states — partially confirmed: `/api/flight-search` with no params correctly returns `400`; UI-level states (no results, network failure) still need a manual browser check since they're client-side rendered
- [x] Test WP content edits appear on the frontend within `PAGE_TREE_CACHE_TTL` seconds, no rebuild needed — superseded by push-based invalidation: publish/update/trash now purges the in-memory cache via a webhook (`wordpress/rest-api-additions.php` → `src/pages/api/revalidate.ts` → `purgeCache()` in `src/lib/wp.ts`), confirmed showing up within seconds; the TTL remains as a fallback only
- [x] Confirm `cms.airlineairportguide.com` serves WordPress independently of the `airlineairportguide.com` Node app (separate subdomains — see `IMPLEMENTATION.md` §11) — confirmed, both domains verified live and independently reachable
