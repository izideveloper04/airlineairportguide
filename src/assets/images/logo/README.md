# Logo & favicon source

- `logo-airlineairportguide.png` — the wordmark lockup (icon + text in one
  image). Imported directly in `Header.astro` and `Footer.astro` and
  rendered via Astro's `<Image>` component (`astro:assets`), which resizes
  it, converts it to WebP, and generates a 1x/2x `srcset` at build time -
  nothing here needs to be pre-resized by hand.
- `favicon-airlineairportguide.png` — the source icon (512x512, solid
  background, no transparency) every `public/favicon*` file and
  `public/favicon.ico` is generated from.

Replacing the logo: just overwrite `logo-airlineairportguide.png` (or update
the import path in `Header.astro`/`Footer.astro` if the filename changes) -
no other steps needed.

Replacing the favicon: overwrite `favicon-airlineairportguide.png`, then run
`npm run favicons` (`scripts/generate-favicons.mjs`) to regenerate every
`public/favicon*.png` and `public/favicon.ico`. That script uses `sharp`
(resize) and `png-to-ico` (multi-size .ico bundling), both devDependencies.
