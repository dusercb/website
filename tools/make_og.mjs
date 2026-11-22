// Render site/og.png (the 1200x630 preview LinkedIn shows) from the live hero.
// Needs the preview server running (node tools/serve.mjs) and Playwright:
//   npm i -D playwright && npx playwright install chromium
//   node tools/make_og.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../site/og.png', import.meta.url));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(process.env.URL || 'http://localhost:8080/', { waitUntil: 'networkidle' });
await page.addStyleTag({
  content: `
    .nav, .hero__scroll, .hero__cta, .grain, .hero__caption p, .hero__caption .hint { display: none !important; }
    .hero { min-height: 630px !important; height: 630px; }
    .hero__inner { padding-top: 92px !important; }
    .hero__name { font-size: 132px !important; }
    .hero__lede { font-size: 23px !important; max-width: 30ch; }
    .hero__caption { bottom: 34px !important; width: 300px !important; }
  `,
});
await page.waitForTimeout(5200);
await page.screenshot({ path: out });
await browser.close();
console.log('wrote', out);
