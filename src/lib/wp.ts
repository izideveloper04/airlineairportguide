import he from "he";
// All WordPress-fetching logic lives here. No ad-hoc fetch() calls to the
// WP REST API anywhere else in the project (components/pages import from
// this module only).

// process.env (not import.meta.env) so this is read live from the Node
// process's environment on Hostinger — changing WP_API_URL in the Node.js
// App panel + restarting the app is enough, no rebuild required.
// WordPress lives on its own subdomain (e.g. cms.airlineairportguide.com),
// entirely separate from SITE_URL (the Node app's own domain) — no
// derivation between the two, since they're independent vhosts.
const WP_API_URL = (process.env.WP_API_URL ?? "http://localhost:8080/wp-json/wp/v2").replace(/\/+$/, "");

/** The WP origin (e.g. https://cms.airlineairportguide.com) - just for rewriting
 *  the WP-origin URLs baked into Yoast's schema graph (see YoastHead.schema)
 *  to this site's own origin before it's injected into a page's <head>. */
export function getWpOrigin(): string {
  return new URL(WP_API_URL).origin;
}
const PAGE_TREE_CACHE_TTL_MS =
  Number(process.env.PAGE_TREE_CACHE_TTL ?? 300) * 1000;

export interface YoastHead {
  title?: string;
  description?: string;
  canonical?: string;
  og_title?: string;
  og_description?: string;
  og_image?: { url: string }[];
  /**
   * Yoast's full structured-data graph for this page/post - WebPage,
   * BreadcrumbList, ImageObject, and (when the content has a Yoast FAQ
   * block) FAQPage/Question/Answer nodes, among others. On a normal
   * (non-headless) WP install Yoast injects this into <head> itself via
   * wp_head; this REST field exists specifically so a headless frontend
   * like this one can do the same. Every @id/url in it points at the WP
   * origin (cms.*), not this site - resolvePageMeta leaves that alone,
   * BaseLayout rewrites it to the live site's origin right before injecting
   * the <script> tag (see getWpOrigin below).
   */
  schema?: { "@context": string; "@graph": Record<string, unknown>[] };
}

/**
 * The lightweight shape used everywhere a page is listed alongside its
 * siblings — the page tree, a section's children, breadcrumb ancestors.
 * Deliberately excludes `content`/`yoast`/`commentsOpen`: those are only
 * ever needed for the single page actually being rendered (see WPPage
 * below), and fetching them for every row of a large catalog is what made
 * the old page-tree crawl slow enough to 504 (see IMPLEMENTATION.md §4a).
 */
export interface WPPageSummary {
  id: number;
  slug: string;
  parent: number;
  title: string;
  template: string;
  menuOrder: number;
  date: string;
  featuredImage: string | null;
  /** Computed by walking the parent chain, e.g. "flights/departures". */
  fullPath: string;
}

/** The full record for the one page actually being rendered this request. */
export interface WPPage extends WPPageSummary {
  content: string;
  yoast: YoastHead | null;
  /** WP's own per-page Discussion setting ("Allow comments") — the comment
   *  form is hidden entirely when this is false, independent of whether any
   *  approved comments already exist. */
  commentsOpen: boolean;
}

/** A breadcrumb-ready ancestor — title/fullPath is all any layout needs. */
export interface Breadcrumb {
  title: string;
  fullPath: string;
}

export interface ResolvedPage {
  page: WPPage;
  /** Root-first. */
  ancestors: Breadcrumb[];
}

export interface SiteSettings {
  title: string;
}

export interface PageTree {
  byId: Map<number, WPPageSummary>;
  byPath: Map<string, WPPageSummary>;
  list: WPPageSummary[];
}

interface RawWPPage {
  id: number;
  slug: string;
  parent: number;
  title: { rendered: string };
  content?: { rendered: string };
  wp_template?: string;
  menu_order?: number;
  date: string;
  yoast_head_json?: YoastHead;
  /** Added by wordpress/rest-api-additions.php; null when no featured image. */
  featured_image_url?: string | null;
  comment_status?: "open" | "closed";
  _embedded?: {
    "wp:featuredmedia"?: { source_url: string }[];
  };
}

/** A published blog post — unrelated to the page hierarchy (WPPage/PageTree). */
export interface WPPost {
  id: number;
  slug: string;
  title: string;
  excerpt: string;
  content: string;
  date: string;
  featuredImage: string | null;
  yoast: YoastHead | null;
}

interface RawWPPost {
  id: number;
  slug: string;
  title: { rendered: string };
  excerpt: { rendered: string };
  content: { rendered: string };
  date: string;
  yoast_head_json?: YoastHead;
  /** Added by wordpress/rest-api-additions.php; null when no featured image. */
  featured_image_url?: string | null;
  _embedded?: {
    "wp:featuredmedia"?: { source_url: string }[];
  };
}

// A cache layer somewhere on the hosting network path between this app and
// WP_API_URL (not WordPress itself, not the public CDN edge — both confirmed
// to always serve fresh data) has been observed serving a stale response
// indefinitely, keyed by URL, regardless of this app's own TTL/purge cycle
// or WordPress's own Cache-Control headers. A per-request cache-busting
// param plus an explicit no-store request header defeats it structurally,
// without needing to know exactly what or where it is.
function withCacheBust(url: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}_cb=${Date.now()}`;
}

const NO_CACHE_REQUEST_HEADERS = { "Cache-Control": "no-store, no-cache" };

function apiUrl(path: string) {
  return withCacheBust(`${WP_API_URL.replace(/\/+$/, "")}${path}`);
}

/** Slugs that are hand-built Astro routes and must never be shadowed by a WP page.
 *  "home" is WordPress's own default sample page slug on a fresh install -
 *  reserved so a leftover, never-deleted one can never leak into the page
 *  tree as a second, competing homepage at /home. */
const RESERVED_SLUGS = new Set(["", "api", "airlines", "airline-terminals", "blog", "home"]);

// Fields for the catalog-wide listing (page tree / sitemap / llms.txt /
// section children) — no `content` or `yoast_head_json`. Those two are by
// far the heaviest part of a WP page response (full rendered HTML, and
// Yoast's whole schema graph), and WP's REST controller only bothers
// generating them when they're actually requested via _fields — omitting
// them here cuts both the payload and the server-side work, not just what
// gets sent over the wire. Only the single page actually being rendered
// needs those (see FULL_PAGE_FIELDS / getPageByPath below).
const SUMMARY_PAGE_FIELDS = "id,slug,parent,title,wp_template,featured_image_url,menu_order,date,_links,_embedded";
const FULL_PAGE_FIELDS = "id,slug,parent,title,content,wp_template,featured_image_url,menu_order,date,yoast_head_json,comment_status,_links,_embedded";

// A full catalog fetch (dozens to hundreds of paginated requests on a large
// site) is done as a bounded fan-out rather than one request at a time —
// this WP host has also been observed taking 10-20s for even a single-row
// request, so sequential pagination alone was the main source of the 504s
// this replaced. Kept modest rather than "everything at once" so this
// doesn't hammer a host that's already resource-constrained.
const CATALOG_FETCH_CONCURRENCY = 6;

async function fetchPagesPage(pageNum: number, perPage: number, fields: string): Promise<{ items: RawWPPage[]; totalPages: number }> {
  const res = await fetch(
    apiUrl(`/pages?status=publish&per_page=${perPage}&page=${pageNum}&_embed=wp:featuredmedia&_fields=${fields}`),
    { headers: NO_CACHE_REQUEST_HEADERS },
  );
  if (!res.ok) {
    throw new Error(`WP page tree fetch failed: ${res.status} ${res.statusText}`);
  }
  return { items: await res.json(), totalPages: Number(res.headers.get("X-WP-TotalPages") ?? "1") };
}

async function fetchAllPages(): Promise<RawWPPage[]> {
  const perPage = 100;
  const first = await fetchPagesPage(1, perPage, SUMMARY_PAGE_FIELDS);
  const results: RawWPPage[] = [...first.items];

  const remainingPageNumbers = Array.from({ length: Math.max(0, first.totalPages - 1) }, (_, i) => i + 2);
  for (let i = 0; i < remainingPageNumbers.length; i += CATALOG_FETCH_CONCURRENCY) {
    const batch = remainingPageNumbers.slice(i, i + CATALOG_FETCH_CONCURRENCY);
    const batchResults = await Promise.all(batch.map((pageNum) => fetchPagesPage(pageNum, perPage, SUMMARY_PAGE_FIELDS)));
    for (const { items } of batchResults) results.push(...items);
  }

  return results;
}

async function fetchAllPosts(): Promise<RawWPPost[]> {
  const perPage = 100;
  let page = 1;
  let totalPages = 1;
  const results: RawWPPost[] = [];

  do {
    const res = await fetch(
      apiUrl(`/posts?status=publish&per_page=${perPage}&page=${page}&_embed=wp:featuredmedia&_fields=id,slug,title,excerpt,content,date,featured_image_url,yoast_head_json,_links,_embedded`),
      { headers: NO_CACHE_REQUEST_HEADERS },
    );
    if (!res.ok) {
      throw new Error(`WP posts fetch failed: ${res.status} ${res.statusText}`);
    }
    totalPages = Number(res.headers.get("X-WP-TotalPages") ?? "1");
    results.push(...(await res.json()));
    page += 1;
  } while (page <= totalPages);

  return results;
}

function normalizePath(path: string): string {
  return path.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
}

/** `undefined` if any ancestor is missing from `byId` — i.e. the page sits
 *  under a parent that isn't published, so it isn't reachable at any URL
 *  (same rule as walkAncestors below). */
function computeFullPath(id: number, byId: Map<number, RawWPPage>): string | undefined {
  const segments: string[] = [];
  let current: RawWPPage | undefined = byId.get(id);
  const seen = new Set<number>();

  while (current) {
    if (seen.has(current.id)) break; // guard against a corrupt/circular parent chain
    seen.add(current.id);
    segments.unshift(current.slug);
    if (!current.parent) break;
    current = byId.get(current.parent);
    if (!current) return undefined;
  }

  return segments.join("/");
}

function toSummary(p: RawWPPage, fullPath: string): WPPageSummary {
  return {
    id: p.id,
    slug: p.slug,
    parent: p.parent,
    title: he.decode(p.title.rendered),
    template: p.wp_template ?? "",
    menuOrder: p.menu_order ?? 0,
    date: p.date,
    featuredImage: p.featured_image_url || p._embedded?.["wp:featuredmedia"]?.[0]?.source_url || null,
    fullPath,
  };
}

let cache: { tree: PageTree; expires: number } | null = null;
let inflight: Promise<PageTree> | null = null;
// Bumped by purgeCache() so a rebuild already in flight when a purge lands
// can't win the race and resurrect the stale tree into `cache` once it
// resolves — see the generation check in getPageTree() below.
let generation = 0;

async function buildPageTree(): Promise<PageTree> {
  const raw = await fetchAllPages();
  const rawById = new Map(raw.map((p) => [p.id, p]));

  const byId = new Map<number, WPPageSummary>();
  const byPath = new Map<string, WPPageSummary>();
  const list: WPPageSummary[] = [];

  for (const p of raw) {
    const rawPath = computeFullPath(p.id, rawById);
    if (rawPath === undefined) continue;
    const fullPath = normalizePath(rawPath);
    if (RESERVED_SLUGS.has(fullPath)) continue;

    const page = toSummary(p, fullPath);
    byId.set(page.id, page);
    byPath.set(fullPath, page);
    list.push(page);
  }

  return { byId, byPath, list };
}

function refreshPageTree(): Promise<PageTree> {
  if (inflight) return inflight;

  const requestGeneration = generation;
  inflight = buildPageTree()
    .then((tree) => {
      // A purgeCache() call that landed while this fetch was in flight
      // bumped `generation` — committing this result now would silently
      // undo that purge and hold the stale tree for a full TTL window.
      if (requestGeneration === generation) {
        cache = { tree, expires: Date.now() + PAGE_TREE_CACHE_TTL_MS };
      }
      return tree;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

const EMPTY_TREE: PageTree = { byId: new Map(), byPath: new Map(), list: [] };

/**
 * Fetches (or returns the cached) full page tree, rebuilt on a TTL.
 *
 * Stale-while-revalidate, including at cold start: at catalog sizes in the
 * thousands, a full rebuild (paginating every WP page, even with the
 * lighter fields/concurrency above) can take long enough that no request
 * should ever block on it — not even the very first one after a process
 * restart. So this never awaits a rebuild itself: an expired cache is
 * served while a fresh one rebuilds in the background, and if nothing has
 * been built yet at all, an empty tree is handed back immediately while the
 * first build kicks off behind it. Callers of this (homepage "latest
 * pages", /airlines, /sitemap.xml, /llms.txt) already degrade gracefully to
 * "nothing yet" rather than erroring on an empty tree, and it self-heals
 * within one build cycle. Actual content edits still show up promptly via
 * the publish webhook (see purgeCache()); this TTL is only the fallback.
 * Individual content pages (the bulk of traffic) never depend on this at
 * all — see getPageByPath.
 */
export async function getPageTree(): Promise<PageTree> {
  const now = Date.now();
  if (cache) {
    if (cache.expires > now) return cache.tree;
    void refreshPageTree().catch(() => {}); // failure surfaces to whichever caller (if any) awaits `inflight` directly next
    return cache.tree;
  }

  void refreshPageTree().catch(() => {});
  return EMPTY_TREE;
}

let postsCache: { posts: WPPost[]; expires: number } | null = null;
let postsInflight: Promise<WPPost[]> | null = null;

async function buildPosts(): Promise<WPPost[]> {
  const raw = await fetchAllPosts();
  return raw
    .map((p) => ({
      id: p.id,
      slug: p.slug,
      title: he.decode(p.title.rendered),
      excerpt: p.excerpt.rendered,
      content: p.content.rendered,
      date: p.date,
      featuredImage: p.featured_image_url || p._embedded?.["wp:featuredmedia"]?.[0]?.source_url || null,
      yoast: p.yoast_head_json ?? null,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Published blog posts, newest first — separate from the page tree (posts
 * aren't part of the page hierarchy), but shares the same cache/TTL/purge
 * machinery, including the generation guard against a purge landing mid-fetch.
 */
export async function getPosts(): Promise<WPPost[]> {
  const now = Date.now();
  if (postsCache && postsCache.expires > now) return postsCache.posts;
  if (postsInflight) return postsInflight;

  const requestGeneration = generation;
  postsInflight = buildPosts()
    .then((posts) => {
      if (requestGeneration === generation) {
        postsCache = { posts, expires: Date.now() + PAGE_TREE_CACHE_TTL_MS };
      }
      return posts;
    })
    .finally(() => {
      postsInflight = null;
    });

  return postsInflight;
}

export async function getPostBySlug(slug: string): Promise<WPPost | undefined> {
  const posts = await getPosts();
  const needle = slug.toLowerCase();
  return posts.find((p) => p.slug.toLowerCase() === needle);
}

/** A single approved, publicly-visible comment on a page. */
export interface WPComment {
  id: number;
  authorName: string;
  /**
   * Already run through WP's own `comment_text` filter (wpautop + linkify)
   * and, before that, sanitized at submission time against a fixed
   * inline-tag allowlist (`wp_kses` on WP's `pre_comment_content` filter) —
   * safe to render raw. Same "trusted HTML" call as page content
   * (IMPLEMENTATION.md §7), but the trust here comes from WP's fixed
   * comment-tag allowlist rather than from the author being an editor.
   */
  content: string;
  date: string;
}

interface RawWPComment {
  id: number;
  author_name: string;
  content: { rendered: string };
  date: string;
}

const COMMENTS_CACHE_TTL_MS = 60_000;
const commentsCache = new Map<number, { comments: WPComment[]; expires: number }>();

/**
 * Approved comments for a page, oldest first. WP's REST API only lets an
 * unauthenticated request (which is all this app ever sends — see the
 * module note at the top of this file) see `status=approve` comments,
 * regardless of what's asked for; anything else 401s. So "fetch as
 * ourselves, no auth header" already *is* the enforcement of "only show what
 * an editor approved in the WP dashboard" — nothing extra to filter here.
 *
 * Cached briefly per page so a busy page doesn't hit WP on every render;
 * unlike page content, a new/approved comment showing up a few seconds late
 * isn't worth wiring the revalidate webhook for.
 */
export async function getApprovedComments(postId: number): Promise<WPComment[]> {
  const now = Date.now();
  const cached = commentsCache.get(postId);
  if (cached && cached.expires > now) return cached.comments;

  const res = await fetch(
    apiUrl(`/comments?post=${postId}&order=asc&orderby=date&per_page=100&_fields=id,author_name,content,date`),
    { headers: NO_CACHE_REQUEST_HEADERS },
  );
  if (!res.ok) {
    throw new Error(`WP comments fetch failed: ${res.status} ${res.statusText}`);
  }

  const raw: RawWPComment[] = await res.json();
  const comments: WPComment[] = raw.map((c) => ({
    id: c.id,
    authorName: he.decode(c.author_name),
    content: c.content.rendered,
    date: c.date,
  }));

  commentsCache.set(postId, { comments, expires: now + COMMENTS_CACHE_TTL_MS });
  return comments;
}

export interface CommentSubmission {
  postId: number;
  authorName: string;
  authorEmail: string;
  content: string;
}

export type SubmitCommentResult =
  | { status: "ok" }
  | { status: "error"; message: string; httpStatus: number };

/**
 * Submits a visitor's comment to WordPress. Lands in whatever moderation
 * state WP itself assigns an anonymous, unauthenticated commenter — normally
 * pending review, unless WP's own auto-approve rules (e.g. a previously
 * approved email on this site) apply — approval always happens in the WP
 * dashboard, never here. The created comment's moderation status isn't
 * readable back from this call (WP only exposes it in "edit" context, which
 * an anonymous submitter doesn't have), so success here just means WP
 * accepted the submission, not that it's already visible.
 *
 * Only called from src/pages/api/comments.ts, which is where visitor input
 * is validated before it ever reaches this function.
 */
export async function submitComment(input: CommentSubmission): Promise<SubmitCommentResult> {
  let res: Response;
  try {
    res = await fetch(`${WP_API_URL}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...NO_CACHE_REQUEST_HEADERS },
      body: JSON.stringify({
        post: input.postId,
        author_name: input.authorName,
        author_email: input.authorEmail,
        content: input.content,
      }),
    });
  } catch {
    return { status: "error", message: "Network error contacting WordPress", httpStatus: 502 };
  }

  if (res.ok) return { status: "ok" };

  // Passed straight through rather than collapsed to a generic 502: WP's
  // rejection here is a genuine, meaningful response (e.g. 401 "you must be
  // logged in to comment" when Settings > Discussion requires registration,
  // or 400 on a missing/invalid field) — a "Bad Gateway" status code on a
  // response that says exactly what's wrong just muddies devtools/logs, and
  // this app's own request to WP itself succeeded fine.
  const body = await res.json().catch(() => null);
  return {
    status: "error",
    message: body?.message ?? `WordPress rejected the comment (${res.status})`,
    httpStatus: res.status,
  };
}

interface AncestorLink {
  id: number;
  slug: string;
  parent: number;
  title: string;
}

const ancestorLinkCache = new Map<number, { link: AncestorLink; expires: number }>();

/** A single page's own {id,slug,parent,title} — the minimum needed to walk a
 *  parent chain one hop at a time without pulling in the rest of the catalog. */
async function fetchAncestorLink(id: number): Promise<AncestorLink | undefined> {
  const now = Date.now();
  const cached = ancestorLinkCache.get(id);
  if (cached && cached.expires > now) return cached.link;

  const res = await fetch(apiUrl(`/pages/${id}?_fields=id,slug,parent,title`), { headers: NO_CACHE_REQUEST_HEADERS });
  if (!res.ok) return undefined;

  const raw: { id: number; slug: string; parent: number; title: { rendered: string } } = await res.json();
  const link: AncestorLink = { id: raw.id, slug: raw.slug, parent: raw.parent, title: he.decode(raw.title.rendered) };
  ancestorLinkCache.set(id, { link, expires: now + PAGE_TREE_CACHE_TTL_MS });
  return link;
}

/** Walks a parent chain up to the root, root-first. `undefined` (rather than
 *  a partial chain) if any link is broken — a parent id that no longer
 *  resolves means the candidate below it isn't reachable at any URL, so the
 *  caller should treat it the same as "this candidate doesn't match". */
async function walkAncestors(parentId: number): Promise<AncestorLink[] | undefined> {
  const chain: AncestorLink[] = [];
  let currentId = parentId;
  const seen = new Set<number>();

  while (currentId) {
    if (seen.has(currentId)) break; // guard against a corrupt/circular parent chain
    seen.add(currentId);
    const link = await fetchAncestorLink(currentId);
    if (!link) return undefined;
    chain.unshift(link);
    currentId = link.parent;
  }

  return chain;
}

async function fetchPagesBySlug(slug: string): Promise<RawWPPage[]> {
  const res = await fetch(
    apiUrl(`/pages?status=publish&slug=${encodeURIComponent(slug)}&_embed=wp:featuredmedia&_fields=${FULL_PAGE_FIELDS}`),
    { headers: NO_CACHE_REQUEST_HEADERS },
  );
  if (!res.ok) {
    throw new Error(`WP page fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function toFullPage(p: RawWPPage, fullPath: string): WPPage {
  return {
    ...toSummary(p, fullPath),
    content: p.content?.rendered ?? "",
    yoast: p.yoast_head_json ?? null,
    commentsOpen: p.comment_status === "open",
  };
}

/**
 * Resolves a request path directly against WordPress — a `?slug=` lookup
 * for the leaf segment (usually one row, occasionally a handful if the slug
 * is reused under different parents) plus a short walk up each candidate's
 * `parent` chain to confirm which one actually matches the full path. Only
 * ever a handful of REST calls, most of them served from the small
 * ancestor-link cache above on repeat visits — unlike the old
 * getPageTree()-backed lookup, this never depends on the size of the rest
 * of the catalog.
 */
async function resolveByPath(normalized: string): Promise<{ raw: RawWPPage; ancestors: Breadcrumb[] } | undefined> {
  const segments = normalized.split("/");
  const leafSlug = segments[segments.length - 1];

  const candidates = await fetchPagesBySlug(leafSlug);

  for (const candidate of candidates) {
    const ancestorLinks = candidate.parent ? await walkAncestors(candidate.parent) : [];
    if (!ancestorLinks) continue;

    const candidateFullPath = normalizePath([...ancestorLinks.map((a) => a.slug), candidate.slug].join("/"));
    if (candidateFullPath !== normalized) continue;

    let acc = "";
    const ancestors: Breadcrumb[] = ancestorLinks.map((a) => {
      acc = acc ? `${acc}/${a.slug}` : a.slug;
      return { title: a.title, fullPath: acc };
    });

    return { raw: candidate, ancestors };
  }

  return undefined;
}

const resolvedPageCache = new Map<string, { resolved: ResolvedPage | null; expires: number }>();

export async function getPageByPath(path: string): Promise<ResolvedPage | undefined> {
  const normalized = normalizePath(path);
  if (!normalized || RESERVED_SLUGS.has(normalized)) return undefined;

  const now = Date.now();
  const cached = resolvedPageCache.get(normalized);
  if (cached && cached.expires > now) return cached.resolved ?? undefined;

  const found = await resolveByPath(normalized);
  const resolved: ResolvedPage | null = found
    ? { page: toFullPage(found.raw, normalized), ancestors: found.ancestors }
    : null;

  resolvedPageCache.set(normalized, { resolved, expires: now + PAGE_TREE_CACHE_TTL_MS });
  return resolved ?? undefined;
}

const childrenCache = new Map<number, { children: WPPageSummary[]; expires: number }>();

async function fetchChildrenRaw(parentId: number): Promise<RawWPPage[]> {
  const perPage = 100;
  let page = 1;
  let totalPages = 1;
  const results: RawWPPage[] = [];

  do {
    const res = await fetch(
      apiUrl(`/pages?status=publish&parent=${parentId}&per_page=${perPage}&page=${page}&_embed=wp:featuredmedia&_fields=${SUMMARY_PAGE_FIELDS}`),
      { headers: NO_CACHE_REQUEST_HEADERS },
    );
    if (!res.ok) {
      throw new Error(`WP children fetch failed: ${res.status} ${res.statusText}`);
    }
    totalPages = Number(res.headers.get("X-WP-TotalPages") ?? "1");
    results.push(...(await res.json()));
    page += 1;
  } while (page <= totalPages);

  return results;
}

/**
 * Direct children of one page — queried from WP scoped to that parent
 * (`?parent=`) rather than filtered out of the whole-site tree, so the cost
 * is proportional to the size of this one section, not the catalog. Used
 * both for a section's own directory listing (ParentPageLayout) and,
 * filtered/capped by the caller, for a child page's sibling list
 * (ChildPageLayout).
 */
export async function getChildren(parent: { id: number; fullPath: string }): Promise<WPPageSummary[]> {
  const now = Date.now();
  const cached = childrenCache.get(parent.id);
  if (cached && cached.expires > now) return cached.children;

  const raw = await fetchChildrenRaw(parent.id);
  const children = raw
    .map((p) => toSummary(p, normalizePath(`${parent.fullPath}/${p.slug}`)))
    .sort((a, b) => a.menuOrder - b.menuOrder || a.title.localeCompare(b.title));

  childrenCache.set(parent.id, { children, expires: now + PAGE_TREE_CACHE_TTL_MS });
  return children;
}

/**
 * The template → layout naming convention (see IMPLEMENTATION.md §4): a page
 * assigned WordPress's page-templates/parent-page-template.php (bare, or
 * path-prefixed, e.g. "page-templates/parent-page-template.php") is a
 * section-parent page; child-page-template.php is a section-child page.
 * Exported so [...slug].astro's layout picker, ChildPageLayout's sibling
 * filter, and getParentPages() below share one definition instead of
 * duplicating the regex.
 *
 * The boundary before the template name is deliberately "/" or
 * start-of-string only — not "-" — so a same-suffix-but-different template
 * like "page-templates/All-parent-page-template.php" (WordPress's own
 * site-wide directory template, found assigned to a page literally titled
 * "Airline Terminals") doesn't get mistaken for this one just because it
 * ends the same way. A hyphen right before "parent-page-template.php" means
 * it's a different template name, not a path separator.
 */
export function isParentTemplate(template: string): boolean {
  return /(?:^|\/)parent-page-template\.php$/i.test(template);
}

export function isChildTemplate(template: string): boolean {
  return /(?:^|\/)child-page-template\.php$/i.test(template);
}

/**
 * Every page using the parent-section template, regardless of where it sits
 * in the hierarchy — the top-level directory for pages like /airlines. This
 * genuinely needs to scan the whole catalog (there's no WP-side way to
 * filter pages by template), so it stays backed by the shared, TTL/SWR-cached
 * getPageTree() rather than a per-request fetch.
 */
export async function getParentPages(): Promise<WPPageSummary[]> {
  const tree = await getPageTree();
  return tree.list
    .filter((p) => isParentTemplate(p.template))
    .sort((a, b) => a.menuOrder - b.menuOrder || a.title.localeCompare(b.title));
}

let siteSettingsCache: { settings: SiteSettings; expires: number } | null = null;

export async function getSiteSettings(): Promise<SiteSettings> {
  const now = Date.now();
  if (siteSettingsCache && siteSettingsCache.expires > now) {
    return siteSettingsCache.settings;
  }

  const wpRoot = WP_API_URL.replace(/\/wp-json\/wp\/v2\/?$/, "/wp-json");
  const res = await fetch(withCacheBust(wpRoot), { headers: NO_CACHE_REQUEST_HEADERS });
  const settings: SiteSettings = res.ok
    ? { title: (await res.json()).name ?? process.env.SITE_TITLE ?? "" }
    : { title: process.env.SITE_TITLE ?? "" };

  siteSettingsCache = { settings, expires: now + PAGE_TREE_CACHE_TTL_MS };
  return settings;
}

/**
 * Invalidates every in-memory cache so WordPress edits show up promptly
 * instead of waiting out a TTL. Called from the /api/revalidate webhook (see
 * wordpress/rest-api-additions.php), which WP pings on publish/update/trash
 * for both pages and posts. The TTL stays in place as a fallback in case the
 * webhook never fires.
 *
 * The page tree is marked expired rather than nulled out (unlike the
 * smaller per-page/per-section caches below it, which are cheap enough to
 * just drop): with a large catalog, forcing the very next request after
 * every publish to block on a full rebuild would just reintroduce the
 * latency spike this cache exists to avoid. getPageTree()'s
 * stale-while-revalidate path serves the (momentarily stale) tree instead
 * and refreshes it in the background.
 */
export function purgeCache(): void {
  if (cache) cache.expires = 0;
  siteSettingsCache = null;
  postsCache = null;
  resolvedPageCache.clear();
  childrenCache.clear();
  ancestorLinkCache.clear();
  generation += 1;
}

export interface ResolvedPageMeta {
  title: string;
  description?: string;
  canonical?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  /** Yoast's raw structured-data graph, still WP-origin URLs - see YoastHead.schema. */
  schema?: YoastHead["schema"];
}

/**
 * Single source of truth for the Yoast-fields-with-fallback rule (IMPLEMENTATION.md §8).
 * Called from BaseLayout and any static page that also needs SEO fallback.
 * Takes the narrow shape it actually needs (not WPPage specifically) so it
 * also works for WPPost — both carry title/yoast, nothing else here matters.
 *
 * Yoast's title/description/og_title/og_description come back HTML-entity
 * encoded (same as title.rendered elsewhere in this file) but are consumed
 * in plain-text contexts (<title>, <meta content>), so they're decoded here
 * too. page.title is already decoded upstream in buildPageTree/buildPosts.
 */
export function resolvePageMeta(page: { title: string; yoast: YoastHead | null }, site: SiteSettings): ResolvedPageMeta {
  const yoast = page.yoast;

  const title =
    yoast?.title && yoast.title.trim().length > 0
      ? he.decode(yoast.title)
      : `${page.title} - ${site.title}`;

  const description =
    yoast?.description && yoast.description.trim().length > 0
      ? he.decode(yoast.description)
      : undefined;

  return {
    title,
    description,
    canonical: yoast?.canonical,
    ogTitle: yoast?.og_title ? he.decode(yoast.og_title) : undefined,
    ogDescription: yoast?.og_description ? he.decode(yoast.og_description) : undefined,
    ogImage: yoast?.og_image?.[0]?.url,
    schema: yoast?.schema,
  };
}