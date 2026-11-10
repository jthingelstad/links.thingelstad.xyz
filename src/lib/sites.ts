// Jamie's sites, from shared/sites.json (a byte-for-byte copy of
// thingelstad.com's shared/sites.json, npm run sites:sync): the "Jamie's
// sites" strip, the footer h-card and the rel=me links. The contract for all
// three is thingelstad.com's AGENTS.md; change it there first.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface SharedSite {
  id: string;
  strip_label: string;
  url: string;
  description: string;
  in_sites_strip: boolean;
}
interface Owner {
  name: string;
  url: string;
  avatar: string;
  note: string;
  rel_me: string[];
}

// The link that ends the strip on every site, after the list: All Things, the
// list of everything live on thingelstad.xyz (2026-11-10).
interface StripAll {
  label: string;
  url: string;
  description: string;
}
interface Shared {
  owner: Owner;
  sites: SharedSite[];
  strip_all: StripAll;
}

// Reads sites.json and fails the build on a strip_all the strip cannot draw:
// a missing one, an empty label or description, or a URL that is not HTTPS.
export function parseSites(text: string, path = 'shared/sites.json'): Shared {
  const data = JSON.parse(text) as Partial<Shared> & {
    strip_all?: Partial<StripAll>;
  };
  const all = data.strip_all;
  if (!all || typeof all !== 'object')
    throw new Error(`${path} has no strip_all.`);
  for (const field of ['label', 'url', 'description'] as const) {
    if (typeof all[field] !== 'string' || !all[field])
      throw new Error(`${path}: strip_all has no ${field}.`);
  }
  if (!all.url!.startsWith('https://'))
    throw new Error(`${path}: strip_all's url must be HTTPS.`);
  return data as Shared;
}

const shared = parseSites(
  readFileSync(join(process.cwd(), 'shared/sites.json'), 'utf8'),
);

// This site's id for refs. Linking Things joined sites.json and the strip on
// 2026-10-23 under this id, so the strip marks it current.
export const currentSite = 'links';
export const owner = shared.owner;

// Adds ref=<value> after any query the URL has, before any fragment.
export function withRef(url: string, ref: string) {
  const hash = url.indexOf('#');
  const [base, fragment] =
    hash === -1 ? [url, ''] : [url.slice(0, hash), url.slice(hash)];
  const separator = !base.includes('?') ? '?' : /[?&]$/.test(base) ? '' : '&';
  return `${base}${separator}ref=${encodeURIComponent(ref)}${fragment}`;
}

export const sitesStrip = shared.sites
  .filter((s) => s.in_sites_strip)
  .map((s) => ({
    id: s.id,
    href: withRef(s.url, `sites-strip-${currentSite}`),
    description: s.description,
    label: s.strip_label,
    current: s.id === currentSite,
  }));

// All Things, after the list and outside it. It is no site, so it has no id
// and no mark, and it is never current here; it carries the same ref.
export function sitesStripAll(all: StripAll, current = currentSite) {
  return {
    href: withRef(all.url, `sites-strip-${current}`),
    label: all.label,
    description: all.description,
  };
}
export const stripAll = sitesStripAll(shared.strip_all);

// A template link to another strip site carries ?ref=links-<placement>; any
// other URL comes back as it was. Identity links never pass through here.
const stripHosts = new Set(
  shared.sites
    .filter((s) => s.in_sites_strip && s.id !== currentSite)
    .map((s) => new URL(s.url).hostname),
);
export function siteRef(url: string, placement: string) {
  if (!URL.canParse(url) || !stripHosts.has(new URL(url).hostname)) return url;
  return withRef(url, `${currentSite}-${placement}`);
}
