// Test-only raster helper for the PDF renderer migration harness (P0 plan §5.2 step 5: golden rasters, D6).
// Runs as its own Node process (pdfjs-dist is ESM-only; Jest's CommonJS runtime never loads it).
//
//   node rasterise.mjs render <in.pdf> <outPrefix> [scale]   → <outPrefix>.p1.png and <outPrefix>.last.png;
//                                                               prints {"pages":N,"files":[…]}
//   node rasterise.mjs diff <a.png> <b.png> [<diff.png>]     → prints {"sameSize":…,"differingPixels":…,"ratio":…}
//
// A pixel "differs" when any channel differs by more than 32 (anti-aliasing noise stays below that). pdfjs runs with
// isEvalSupported:false and no system fonts; nothing here touches the network.
import { readFileSync, writeFileSync } from 'node:fs';

const [mode, a, b, c] = process.argv.slice(2);
const { createCanvas, loadImage } = await import('@napi-rs/canvas');

if (mode === 'render') {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const scale = Number(c) || 1.5;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(a)), isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  const files = [];
  const pages = doc.numPages === 1 ? [[1, 'p1']] : [[1, 'p1'], [doc.numPages, 'last']];
  for (const [n, name] of pages) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const file = `${b}.${name}.png`;
    writeFileSync(file, canvas.toBuffer('image/png'));
    files.push(file);
  }
  await doc.destroy();
  process.stdout.write(JSON.stringify({ pages: doc.numPages, files }));
} else if (mode === 'diff') {
  const [x, y] = [await loadImage(readFileSync(a)), await loadImage(readFileSync(b))];
  if (x.width !== y.width || x.height !== y.height) {
    process.stdout.write(JSON.stringify({ sameSize: false, a: [x.width, x.height], b: [y.width, y.height], differingPixels: null, ratio: 1 }));
  } else {
    const read = (img) => {
      const cv = createCanvas(img.width, img.height);
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, img.width, img.height).data;
    };
    const [p, q] = [read(x), read(y)];
    const out = c ? createCanvas(x.width, x.height) : null;
    const outCtx = out?.getContext('2d');
    const outData = outCtx?.createImageData(x.width, x.height);
    let differing = 0;
    for (let i = 0; i < p.length; i += 4) {
      const diff = Math.abs(p[i] - q[i]) > 32 || Math.abs(p[i + 1] - q[i + 1]) > 32 || Math.abs(p[i + 2] - q[i + 2]) > 32;
      if (diff) differing++;
      if (outData) {
        outData.data[i] = diff ? 255 : p[i] * 0.3 + 178;
        outData.data[i + 1] = diff ? 0 : p[i + 1] * 0.3 + 178;
        outData.data[i + 2] = diff ? 0 : p[i + 2] * 0.3 + 178;
        outData.data[i + 3] = 255;
      }
    }
    if (out && outCtx && outData) {
      outCtx.putImageData(outData, 0, 0);
      writeFileSync(c, out.toBuffer('image/png'));
    }
    process.stdout.write(JSON.stringify({ sameSize: true, differingPixels: differing, ratio: differing / (p.length / 4) }));
  }
} else {
  process.stderr.write('usage: rasterise.mjs render <pdf> <outPrefix> [scale] | diff <a.png> <b.png> [diff.png]\n');
  process.exit(2);
}
