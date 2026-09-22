/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,ts,jsx,tsx,md,mdx}"],
  theme: {
    extend: {
      // Must stay in sync with the CSS custom properties in
      // src/styles/global.css (:root) — that file is the newer, primary
      // source (used directly via var(--brand) etc. in index.astro), this
      // is the older Tailwind-theme mirror still used by every other
      // component (bg-brand, text-ink/60, border-ink/10, ...). Kept as
      // plain hex rather than var(--x) references because Tailwind's /NN
      // opacity-modifier syntax (used pervasively across this codebase)
      // needs a real color value, not a CSS variable, to composite alpha.
      colors: {
        brand: {
          DEFAULT: "#076b3b",
          dark: "#054928",
          light: "#e3f3ea",
        },
        accent: {
          DEFAULT: "#f97316",
          dark: "#c2410c",
        },
        ink: "#0f172a",
        surface: "#f4f7fb",
      },
      fontFamily: {
        sans: ['Manrope', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // Headings sitewide use Jost automatically via the h1-h6 tag
        // selector in global.css — this utility exists for the rare case
        // something needs Jost on a non-heading element.
        display: ["Jost", "system-ui", "-apple-system", "sans-serif"],
      },
      // Aliases the plain Tailwind shadow-sm/shadow-md utilities (already
      // used across several components) to the same --shadow-sm/--shadow-md
      // tokens index.astro references directly — one shadow system sitewide
      // instead of two coexisting ones.
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
      },
    },
  },
  plugins: [],
};
