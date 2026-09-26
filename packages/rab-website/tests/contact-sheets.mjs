import sharp from 'sharp';
import { readdir } from 'node:fs/promises';
for (const kind of ['desktop', 'mobile']) {
  const files = (await readdir('qa'))
    .filter((f) => f.startsWith(`${kind}-section-`) && f.endsWith('.png'))
    .sort();
  const width = kind === 'desktop' ? 480 : 195,
    height = kind === 'desktop' ? 300 : 422,
    columns = kind === 'desktop' ? 3 : 6;
  const images = await Promise.all(
    files.map(async (file, i) => ({
      input: await sharp(`qa/${file}`).resize(width, height).png().toBuffer(),
      left: (i % columns) * width,
      top: Math.floor(i / columns) * height,
    })),
  );
  await sharp({
    create: {
      width: columns * width,
      height: Math.ceil(files.length / columns) * height,
      channels: 3,
      background: '#ffffff',
    },
  })
    .composite(images)
    .png()
    .toFile(`qa/${kind}-contact-sheet.png`);
}
