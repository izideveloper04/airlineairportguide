import he from "he";

export interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface TocResult {
  /** page.content with an `id` injected on every heading that lacked one. */
  html: string;
  items: TocItem[];
}

const HEADING_RE = /<h([23])((?:\s+[^>]*)?)>([\s\S]*?)<\/h\1>/gi;
const TAG_RE = /<[^>]+>/g;
const ID_ATTR_RE = /\sid=(["'])([\s\S]*?)\1/i;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Scans WP-rendered content for h2/h3 headings to build a table of
 * contents. Reuses an id already on a heading tag; otherwise slugifies its
 * text, de-duping against every id seen so far (existing or generated) with
 * a numeric suffix. Headings with no text (e.g. an empty block) are left
 * alone and skipped.
 */
export function extractToc(html: string): TocResult {
  const items: TocItem[] = [];
  const usedIds = new Set<string>();

  const rewritten = html.replace(HEADING_RE, (match, level, attrs, inner) => {
    const text = he.decode(inner.replace(TAG_RE, "")).trim();
    if (!text) return match;

    const existing = ID_ATTR_RE.exec(attrs);
    let id = existing?.[2];

    if (!id) {
      const base = slugify(text) || `section-${items.length + 1}`;
      id = base;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${base}-${suffix++}`;
      }
    }
    usedIds.add(id);

    items.push({ id, text, level: Number(level) as 2 | 3 });

    if (existing) return match;
    return `<h${level}${attrs} id="${id}">${inner}</h${level}>`;
  });

  return { html: rewritten, items };
}
