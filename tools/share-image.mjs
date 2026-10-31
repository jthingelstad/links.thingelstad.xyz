// The share image every page names as its og:image (src/layouts/Layout.astro):
// the live front page at 1200 x 630, light, with Tinylytics blocked so the
// capture is never a visit. Run by hand (`npm run share-image`) when the
// front page changes enough to matter; the count on it is a point in time.
// SHARE_URL draws another copy of the front page instead, such as a local
// build (`npx astro preview`) before the change that redraws it goes live.
// The front page is the sky, so the capture waits for the stars and their
// names, then for the camera to settle.
import { chromium } from 'playwright';

const url = process.env.SHARE_URL || 'https://links.thingelstad.xyz/';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  });
  await page.route(/tinylytics/, (route) => route.abort());
  await page.goto(url, { waitUntil: 'networkidle' });
  await page
    .locator('[data-sky] .sky-loading')
    .waitFor({ state: 'detached', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.screenshot({
    path: 'public/share.jpg',
    type: 'jpeg',
    quality: 82,
  });
} finally {
  await browser.close();
}
