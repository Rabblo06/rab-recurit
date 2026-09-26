const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
(async () => {
  const name = process.argv[2];
  if (!/^[a-z-]+$/.test(name)) throw new Error('Invalid capture name');
  const html = path.join(__dirname, 'video-review.html');
  fs.writeFileSync(html, `<video src="${name}.mp4" muted preload="auto"></video>`);
  const browser = await chromium.launch({ headless: true, args: ['--allow-file-access-from-files'] });
  try {
    const page = await browser.newPage();
    await page.goto('file:///' + html.replaceAll('\\', '/'));
    await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
    for (const at of [.1, 1.2, 1.3, 1.4, 1.45, 1.5, 1.55, 1.6, 1.7, 1.8, 1.9, 2, 2.2, 2.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.95, 4, 4.05, 4.1, 4.2, 4.3, 4.4, 4.6, 5]) {
      const data = await page.evaluate(async (at) => {
        const video = document.querySelector('video');
        await new Promise(resolve => { video.onseeked = resolve; video.currentTime = at; });
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        return canvas.toDataURL('image/png').split(',')[1];
      }, at);
      fs.writeFileSync(path.join(__dirname, `${name}-${at}.png`), Buffer.from(data, 'base64'));
    }
    console.log('Saved native video frames for ' + name);
  } finally { await browser.close(); }
})();

