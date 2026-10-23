// URL normalisation for joins only (docs/DATA.md, "URL normalisation"): an
// issue link, a note mention or a saved URL is matched to another by this
// form. Never used to form an id: the id is md5 of the URL exactly as saved.
//
//   1. Lower-case the host; drop a leading www.
//   2. Drop the scheme.
//   3. Percent-decode the path; drop trailing slashes (an empty path is /).
//   4. Drop query parameters named utm_*, ref, source, mc_cid, mc_eid,
//      fbclid, gclid (exact, case-sensitive); keep the rest in order.
//   5. Drop the fragment.
//
// The reference is normalise() in tools/linking/urls.py, which issues.json is
// joined with, so this follows Python's urlsplit and unquote rather than the
// WHATWG URL parser (which rewrites dot segments, IDN hosts and escapes). The
// cases are pinned in tests/data.test.mjs, the same ones as tests/test_urls.py.
const schemeChars = /^[a-z][a-z0-9+.-]*$/i;
const tracking = new Set([
  'ref',
  'source',
  'mc_cid',
  'mc_eid',
  'fbclid',
  'gclid',
]);
const isTracking = (name: string) =>
  name.startsWith('utm_') || tracking.has(name);

interface Parts {
  netloc: string;
  path: string;
  query: string;
}

// Python's urllib.parse.urlsplit, without the scheme it would return. Throws
// where urlsplit raises ValueError.
function split(input: string): Parts {
  // eslint-disable-next-line no-control-regex
  let url = input.replace(/^[\x00-\x20]+/, '').replace(/[\t\r\n]/g, '');
  const colon = url.indexOf(':');
  if (colon > 0 && schemeChars.test(url.slice(0, colon)))
    url = url.slice(colon + 1);
  let netloc = '';
  if (url.startsWith('//')) {
    const rest = url.slice(2);
    const end = rest.search(/[/?#]/);
    netloc = end === -1 ? rest : rest.slice(0, end);
    url = end === -1 ? '' : rest.slice(end);
    const open = netloc.includes('['),
      close = netloc.includes(']');
    if (open !== close) throw new Error('Invalid IPv6 URL');
    if (open && !/^v|:/i.test(netloc.split('[')[1].split(']')[0]))
      throw new Error('Invalid bracketed host');
    checkNetloc(netloc);
  }
  const hash = url.indexOf('#');
  if (hash !== -1) url = url.slice(0, hash);
  const mark = url.indexOf('?');
  const query = mark === -1 ? '' : url.slice(mark + 1);
  return { netloc, path: mark === -1 ? url : url.slice(0, mark), query };
}

// urlsplit refuses a host that NFKC turns into URL punctuation (U+2100 is a/c).
function checkNetloc(netloc: string) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(netloc)) return;
  const bare = netloc.replace(/[@:#?]/g, '');
  const folded = bare.normalize('NFKC');
  if (bare !== folded && /[/?#@:]/.test(folded))
    throw new Error('Invalid characters under NFKC normalization');
}

// Python's urllib.parse.unquote: %XX escapes in each ASCII run become bytes,
// read as UTF-8 with U+FFFD for a bad sequence; invalid escapes stay as typed.
const utf8 = new TextDecoder('utf-8');
function unquote(text: string) {
  if (!text.includes('%')) return text;
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x7f]+/g, (run) => {
    const bytes: number[] = [];
    for (let i = 0; i < run.length; i++) {
      if (run[i] === '%' && /^[0-9a-f]{2}$/i.test(run.slice(i + 1, i + 3))) {
        bytes.push(parseInt(run.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(run.charCodeAt(i));
    }
    return utf8.decode(new Uint8Array(bytes));
  });
}

export function normalizeUrl(url: string): string {
  const text = url.trim();
  let parts: Parts;
  try {
    parts = split(text);
  } catch {
    // Not parseable (an unclosed IPv6 bracket): it joins only to itself.
    return text;
  }
  let host = parts.netloc.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  const path = unquote(parts.path).replace(/\/+$/, '') || '/';
  const kept = parts.query
    .split('&')
    .filter((param) => param && !isTracking(param.split('=')[0]));
  return host + path + (kept.length ? `?${kept.join('&')}` : '');
}

// The host as the site shows it and files it: the normalised host without
// any user info (example.com:8080 keeps its port).
export function hostOf(url: string): string {
  try {
    const netloc = split(url.trim()).netloc.toLowerCase();
    const host = netloc.slice(netloc.lastIndexOf('@') + 1);
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return '';
  }
}
