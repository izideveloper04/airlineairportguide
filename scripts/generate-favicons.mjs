// Regenerates every public/favicon* file from the source icon in
// src/assets/images/logo/. Run this again any time that source image
// changes: `npm run favicons`.
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const SRC = "src/assets/images/logo/favicon-airlineairportguide.png";
const OUT_DIR = "public";

const pngSizes = [
  ["favicon-16x16.png", 16],
  ["favicon-32x32.png", 32],
  ["apple-touch-icon.png", 180],
  ["favicon-512x512.png", 512],
];

await mkdir(OUT_DIR, { recursive: true });

for (const [name, size] of pngSizes) {
  await sharp(SRC)
    .resize(size, size, { fit: "cover" })
    .png({ compressionLevel: 9, quality: 90 })
    .toFile(`${OUT_DIR}/${name}`);
  console.log(`${OUT_DIR}/${name}`);
}

// .ico bundles a few small raster sizes together - kept separate from the
// PNG loop above since it needs raw buffers (not files) to hand to
// png-to-ico, not individually-written files.
const icoBuffers = await Promise.all(
  [16, 32, 48].map((size) => sharp(SRC).resize(size, size, { fit: "cover" }).png().toBuffer()),
);
await writeFile(`${OUT_DIR}/favicon.ico`, await pngToIco(icoBuffers));
console.log(`${OUT_DIR}/favicon.ico`);
