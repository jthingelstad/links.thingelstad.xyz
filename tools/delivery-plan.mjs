// The deploy's rules, with no AWS calls in them, so tests/deploy.test.mjs can
// pin them: which key a built file becomes, the Content-Type and Cache-Control
// it is stored with, what a deploy uploads and removes, and what it
// invalidates. tools/deploy.mjs does the calls.
//
// Objects are stored exactly as built, never gzip-encoded. CloudFront
// compresses (gzip or Brotli) for a client that asks, so a client that sends
// no Accept-Encoding (Python's urllib, curl without --compressed) still gets
// plain JSON, Markdown and llms.txt, and an object's S3 ETag is the md5 of the
// built file: a single-part PutObject into a bucket encrypted with SSE-S3
// (infra/storage.json) reports md5 as the ETag, so one ListObjectsV2 pass
// tells a deploy what changed.
import { createHash } from 'node:crypto';
import path from 'node:path';

export const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  // Pagefind's index files are gzip inside and decoded by Pagefind's script.
  '.pagefind': 'application/octet-stream',
  '.pf_meta': 'application/octet-stream',
  '.pf_index': 'application/octet-stream',
  '.pf_fragment': 'application/octet-stream',
  '.pf_filter': 'application/octet-stream',
};

export const cachePolicies = {
  // Content-addressed: a changed file gets a new name.
  immutable: 'public,max-age=31536000,immutable',
  // Browsers ask every time (a 304 when unchanged); edges keep a copy a
  // minute, and every deploy invalidates what it changed.
  revalidate: 'public,max-age=0,s-maxage=60,must-revalidate',
  hour: 'public,max-age=3600',
};

// Astro's bundles and fonts, and Pagefind's index chunks, fragments, filters
// and meta file, are named by their content. They never need invalidating.
export function isHashedAsset(key) {
  return (
    key.startsWith('_astro/') ||
    (key.startsWith('pagefind/') && /\.pf_[a-z]+$/.test(key))
  );
}

const documents = new Set(['.html', '.json', '.md', '.xml', '.txt']);

export function contentType(key) {
  const type = contentTypes[path.posix.extname(key)];
  if (!type) throw new Error(`No Content-Type for ${key}`);
  return type;
}

export function cacheControl(key) {
  if (isHashedAsset(key)) return cachePolicies.immutable;
  // Pages, their JSON and Markdown twins, feeds, sitemaps, robots.txt and
  // revision.json; and Pagefind's entry file and scripts, which name the
  // current index chunks.
  if (documents.has(path.posix.extname(key)) || key.startsWith('pagefind/'))
    return cachePolicies.revalidate;
  return cachePolicies.hour;
}

export const objectHeaders = (key) => ({
  ContentType: contentType(key),
  CacheControl: cacheControl(key),
});

// A file's path under dist/ to its object key: forward slashes, relative, no
// empty, "." or ".." segment, no backslash.
export function keyFor(relative) {
  const key = relative.split(path.sep).join('/');
  if (
    !key ||
    key.startsWith('/') ||
    key.includes('\\') ||
    key.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new Error(`Unsafe object key: ${relative}`);
  return key;
}

// The edge function (infra/site.json) redirects /hosts/<name> to
// /hosts/<name>/, because host names have dots in them (/hosts/obsidian.md/).
// So no file but the index may sit directly under hosts/.
export const shadowedByRedirect = (key) =>
  /^hosts\/[^/]+$/.test(key) && key !== 'hosts/index.html';

export const etag = (bytes) => createHash('md5').update(bytes).digest('hex');
export const normalizeEtag = (value) => (value || '').replaceAll('"', '');

// local: key -> md5 of the built file. remote: key -> ETag from the listing.
// force uploads everything (the header rules changed, below). A multipart
// ETag ("<hash>-<parts>") never matches, so such an object is replaced.
export function planSync(local, remote, { force = false } = {}) {
  const upload = [];
  let unchanged = 0;
  for (const [key, tag] of local) {
    if (!force && normalizeEtag(remote.get(key)) === tag) unchanged++;
    else upload.push(key);
  }
  const stale = [...remote.keys()].filter((key) => !local.has(key));
  return { upload: upload.sort(), unchanged, stale: stale.sort() };
}

// Upload order: content-addressed assets; then what pages refer to by a fixed
// name (twins, feeds, Pagefind's entry file and scripts, which name the new
// index); then the pages; revision.json last, since it says which commit is
// live.
export function publicationGroups(keys) {
  const groups = [[], [], [], []];
  for (const key of [...keys].sort()) {
    const group =
      key === 'revision.json'
        ? 3
        : isHashedAsset(key)
          ? 0
          : key.endsWith('.html')
            ? 2
            : 1;
    groups[group].push(key);
  }
  return groups;
}

// A deploy that would remove more pages than this stops before writing
// anything, unless DEPLOY_ALLOW_REMOVALS names the exact count. Sync already
// refuses to shrink the data by a tenth (tools/README.md); this catches a
// build that lost pages for another reason.
export const removalLimit = (livePages) =>
  Math.max(100, Math.ceil(livePages * 0.02));

// CloudFront's first 1,000 invalidation paths a month are free across the
// whole account (every distribution Jamie has), then $0.005 a path, and /*
// counts as one. A warm edge cache is worth nothing at this site's traffic, so
// anything beyond a handful of paths becomes /*.
export const invalidationLimit = 50;

export function invalidationPaths(keys, limit = invalidationLimit) {
  const paths = new Set();
  for (const key of keys) {
    if (isHashedAsset(key)) continue;
    const url = encodeURI(`/${key}`);
    paths.add(url);
    // The edge function serves /x/ from x/index.html; clear both forms.
    if (key === 'index.html' || key.endsWith('/index.html'))
      paths.add(url.slice(0, -'index.html'.length));
  }
  return paths.size > limit ? ['/*'] : [...paths].sort();
}

// ETags cover bodies only. When the header rules above change, this
// fingerprint changes; tools/write-revision.mjs puts it in revision.json, and
// the next deploy sees the live revision.json disagree and uploads every
// object again, so the stored headers follow the rules. sampleKeys reaches
// every content type and every cache policy (tests/deploy.test.mjs checks).
export const sampleKeys = [
  ...Object.keys(contentTypes).map((extension) => `sample${extension}`),
  'index.html',
  'links/0123456789ab/index.html',
  'links/0123456789ab.json',
  'links/0123456789ab.md',
  '_astro/Layout.sample.css',
  '_astro/font.sample.woff2',
  'pagefind/fragment/en_sample.pf_fragment',
  'pagefind/pagefind-entry.json',
  'pagefind/pagefind.js',
  'pagefind/wasm.en.pagefind',
  'favicon.svg',
  'revision.json',
];
export const headersFingerprint = createHash('sha256')
  .update(
    JSON.stringify(
      sampleKeys.map((key) => [key, contentType(key), cacheControl(key)]),
    ),
  )
  .digest('hex')
  .slice(0, 16);

// Run fn over items, at most limit at a time; stop taking new items once one
// has failed, and reject with that failure.
export async function eachLimit(items, limit, fn) {
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failed && next < items.length) {
        const item = items[next++];
        try {
          await fn(item);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
}
