import sharp from 'sharp';
import { readdir } from 'node:fs/promises';
const files = (await readdir('qa/frames'))
  .filter((f) => f.endsWith('.png'))
  .sort();
const images = await Promise.all(
  files.map(async (file, i) => ({
    input: await sharp(`qa/frames/${file}`).resize(360, 225).png().toBuffer(),
    left: (i % 4) * 360,
    top: Math.floor(i / 4) * 225,
  })),
);
await sharp({
  create: {
    width: 1440,
    height: Math.ceil(files.length / 4) * 225,
    channels: 3,
    background: '#fff',
  },
})
  .composite(images)
  .png()
  .toFile('qa/scroll-frames.png');
