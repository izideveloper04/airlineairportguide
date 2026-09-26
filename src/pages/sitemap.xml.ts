import type { APIRoute } from "astro";
import { getPageTree } from "../lib/wp";

// Dynamic (not the static @astrojs/sitemap integration): WP content pages
// are rendered live rather than enumerated at build time, so the sitemap
// has to reflect the current page tree at request time too. Cheap since it
// reuses the same TTL-cached page tree as every content-page request.
export const prerender = false;

const STATIC_PATHS = ["", "contact-us"]; // homepage; add other hand-built landing pages here as they're added

export const GET: APIRoute = async ({ site }) => {
  const base = site?.toString().replace(/\/+$/, "") ?? "";
  const tree = await getPageTree();

  const urls = [
    ...STATIC_PATHS.map((path) => `${base}/${path}`.replace(/\/+$/, "/") || `${base}/`),
    ...tree.list.map((page) => `${base}/${page.fullPath}`),
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${url}</loc></url>`).join("\n")}
</urlset>
`;

  return new Response(body, {
    status: 200,
    // no-store: without this, a CDN can cache a sitemap generated before a
    // page existed and keep serving that stale list indefinitely, regardless
    // of the origin's own page-tree cache being purged (same class of bug
    // fixed in [...slug].astro/404.astro).
    headers: { "Content-Type": "application/xml", "Cache-Control": "no-store" },
  });
};
