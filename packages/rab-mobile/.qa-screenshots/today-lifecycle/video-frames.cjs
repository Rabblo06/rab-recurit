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
    for (const at of [.4,.5,.6,.7,.8,.9,1,1.1,2.6,2.7,2.8,2.9,3,3.1,3.2,3.3]) {
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

