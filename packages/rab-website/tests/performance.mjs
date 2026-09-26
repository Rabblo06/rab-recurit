import { chromium } from 'playwright';
import lighthouse from 'lighthouse';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--remote-debugging-port=9223'],
});
try {
  const result = await lighthouse('http://localhost:3100', {
    port: 9223,
    output: ['json', 'html'],
    logLevel: 'error',
    onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
  });
  await writeFile('qa/lighthouse-mobile.json', result.report[0]);
  await writeFile('qa/lighthouse-mobile.html', result.report[1]);
  const summary = {
    scores: Object.fromEntries(
      Object.entries(result.lhr.categories).map(([k, v]) => [
        k,
        Math.round(v.score * 100),
      ]),
    ),
    metrics: Object.fromEntries(
      [
        'largest-contentful-paint',
        'cumulative-layout-shift',
        'total-blocking-time',
        'first-contentful-paint',
      ].map((k) => [k, result.lhr.audits[k].displayValue]),
    ),
    environment: result.lhr.configSettings,
    runtimeError: result.lhr.runtimeError || null,
  };
  await writeFile(
    'qa/performance-summary.json',
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary));
} finally {
  await browser.close();
}
