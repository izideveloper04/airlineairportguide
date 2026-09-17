// Loads .env into process.env for local dev. Astro's dev server only
// populates import.meta.env from .env by default — this project deliberately
// reads process.env everywhere instead (see src/lib/wp.ts), since that's
// what actually matches production on Hostinger, where env vars are real
// process env vars set in the Node.js App panel, not a .env file. Without
// this, `npm run dev` silently falls back to every var's hardcoded default
// even with a real .env file present. No-op in production: no .env file is
// ever part of the deploy zip (see DEPLOYMENT.md), so this finds nothing to
// load there and does nothing.
import "dotenv/config";

import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import node from "@astrojs/node";

// Two separate origins now: the Node app (SITE_URL, e.g.
// airlineairportguide.com) and WordPress on its own subdomain (WP_API_URL, e.g.
// cms.airlineairportguide.com) — separate vhosts on Hostinger, no path routing
// between them to worry about. See src/lib/wp.ts for the same pair read at
// runtime via process.env.
const wpApiUrl = process.env.WP_API_URL ?? "http://localhost:8080/wp-json/wp/v2";
const wpMediaHost = new URL(wpApiUrl).hostname;

export default defineConfig({
  site: process.env.SITE_URL ?? "http://localhost:4321",

  // "hybrid": static-by-default, per-route opt-out via `export const prerender
  // = false`. Content pages (src/pages/[...slug].astro) and the flight-search
  // API route opt out and run live on Node — everything else (homepage, 404)
  // still prerenders. Runs as a persistent Node process via Hostinger's
  // Node.js App feature (Business/Cloud plans), not a serverless platform.
  output: "hybrid",
  adapter: node({ mode: "standalone" }),

  integrations: [tailwind()],

  image: {
    domains: [wpMediaHost],
  },
});
