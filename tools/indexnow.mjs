// IndexNow: after a deploy, tell Bing, Yandex, Seznam, Naver and Yep which
// pages that deploy changed (https://www.indexnow.org/documentation). No AWS
// calls and no reads of dist/ here, so tests/indexnow.test.mjs can pin which
// URLs are chosen; tools/deploy.mjs passes in what it uploaded and removed and
// the sitemap it built.
//
// The key is public by design: the engines check it by fetching
// /<key>.txt, which ships from public/ with the site and holds the key and
// nothing else. It is shared with thingelstad.xyz and weekly.thingelstad.com.
//
// Which URLs: a page whose built bytes differ from the live object (a new or
// changed index.html, by md5 against the bucket's ETag, so a headers-only
// re-upload pings nothing) and that the sitemap lists (noindex pages are left
// out of the sitemap, so they are left out here too), plus every page the
// deploy removed, since IndexNow takes deleted URLs as well. Nothing changed,
// nothing sent. At most 10,000 URLs a request.
//
// A failed ping never fails the deploy: submit() logs and returns.

export const INDEXNOW_KEY = '79f379d18599eeec9bebf34c9a2a5deb';
export const INDEXNOW_KEY_FILE = `${INDEXNOW_KEY}.txt`;
export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
export const INDEXNOW_LIMIT = 10000;

const decodeXml = (text) =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

// Every <loc> in a sitemap (not a sitemap index), as a normalised URL.
export function sitemapUrls(xml) {
  const urls = new Set();
  for (const match of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g))
    urls.add(new URL(decodeXml(match[1])).href);
  return urls;
}

// A built key to the page URL it serves, or null for anything not a page:
// dir/index.html is /dir/ (the edge function redirects .../index.html there).
export function pageUrl(key, base) {
  if (key !== 'index.html' && !key.endsWith('/index.html')) return null;
  return new URL(`/${key.slice(0, -'index.html'.length)}`, base).href;
}

// changed: keys whose built bytes differ from the live object (new or
// modified). removed: keys the deploy removed. indexable: the sitemap's URLs.
export function changedUrls({ changed, removed = [], indexable, base }) {
  const urls = new Set();
  for (const key of changed) {
    const url = pageUrl(key, base);
    if (url && indexable.has(url)) urls.add(url);
  }
  for (const key of removed) {
    const url = pageUrl(key, base);
    if (url) urls.add(url);
  }
  return [...urls].sort();
}

// The request bodies: one per 10,000 URLs, none when nothing changed.
export function payloads(urls, base, limit = INDEXNOW_LIMIT) {
  const { host } = new URL(base);
  const keyLocation = new URL(`/${INDEXNOW_KEY_FILE}`, base).href;
  const bodies = [];
  for (let i = 0; i < urls.length; i += limit)
    bodies.push({
      host,
      key: INDEXNOW_KEY,
      keyLocation,
      urlList: urls.slice(i, i + limit),
    });
  return bodies;
}

// POST each batch. 200 and 202 are accepted; anything else, or a network
// failure, is logged and the rest are skipped. Never throws.
export async function submit(
  urls,
  base,
  { post = fetch, log = console, endpoint = INDEXNOW_ENDPOINT } = {},
) {
  const bodies = payloads(urls, base);
  if (!bodies.length) {
    log.log('IndexNow: no changed pages, nothing sent');
    return { sent: 0, ok: true };
  }
  let sent = 0;
  for (const body of bodies) {
    try {
      const response = await post(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      if (response.status !== 200 && response.status !== 202) {
        log.warn(
          `IndexNow: ${response.status} for ${body.urlList.length} URLs; the deploy carries on`,
        );
        return { sent, ok: false, status: response.status };
      }
      sent += body.urlList.length;
    } catch (error) {
      log.warn(
        `IndexNow: ${error.name}: ${error.message}; the deploy carries on`,
      );
      return { sent, ok: false };
    }
  }
  log.log(`IndexNow: ${sent} changed pages submitted`);
  return { sent, ok: true };
}
