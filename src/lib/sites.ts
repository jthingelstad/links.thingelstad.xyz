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

const shared = JSON.parse(
  readFileSync(join(process.cwd(), 'shared/sites.json'), 'utf8'),
) as { owner: Owner; sites: SharedSite[] };

// This site's id for refs. Linking Things is not in sites.json yet (Jamie,
// 2026-10-23: it joins the strip when it is done); when its line lands with
// this id, the strip marks it current with no change here.
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
