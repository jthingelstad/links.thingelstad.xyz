// The share image every page names as its og:image (src/layouts/Layout.astro):
// the live front page at 1200 x 630, light, with Tinylytics blocked so the
// capture is never a visit. Run by hand (`npm run share-image`) when the
// front page changes enough to matter; the count on it is a point in time.
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  });
  await page.route(/tinylytics/, (route) => route.abort());
  await page.goto('https://links.thingelstad.xyz/', {
    waitUntil: 'networkidle',
  });
  await page.screenshot({
    path: 'public/share.jpg',
    type: 'jpeg',
    quality: 82,
  });
} finally {
  await browser.close();
}
