// The enrichment shards (docs/DATA.md, "Enrichment"), read once at build:
// facts observed about hosts and pages, written by the Python tools and never
// by a person. This is the only module that reads data/enrichment/.
//
// Only facts leave this module. Jamie, 2026-10-23: "You don't need to
// validate the links. They just are." So nothing that says whether a host or
// a page works (dns, https, status, alive, final_url, redirects, the errors)
// is read past the parse: each view below copies the fields a page may show,
// checked for type, and nothing else. A missing shard, record or field means
// "not observed", never "gone".
//
// LINKS_ENRICHMENT points the build at another directory of shards (the
// fixtures in tests/fixtures/enrichment, for the screenshot build and the
// unit tests); it defaults to data/enrichment.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Link, absolute, linkById, links } from './data.ts';

const root = process.env.LINKS_ROOT || process.cwd();
export const enrichmentDir = process.env.LINKS_ENRICHMENT
  ? resolve(process.env.LINKS_ENRICHMENT)
  : join(root, 'data/enrichment');
// Images the facts tool stores with the site (public/media/), served from
// this host as any public file.
const publicDir = join(root, 'public');

type Json = Record<string, unknown>;

// Every record of every shard in a directory, merged. Shards are keyed by
// host or id, so no key appears in two.
function shards(folder: string, name: RegExp): Map<string, Json> {
  const dir = join(enrichmentDir, folder);
  const out = new Map<string, Json>();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir)
    .filter((f) => name.test(f))
    .sort()) {
    const shard = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Json;
    for (const [key, record] of Object.entries(shard))
      if (record && typeof record === 'object' && !Array.isArray(record))
        out.set(key, record as Json);
  }
  return out;
}

const hostRecords = shards('hosts', /^[a-z0-9]\.json$/);
const pageRecords = shards('pages', /^\d{4}\.json$/);
const factRecords = shards('facts', /^\d{4}\.json$/);

// Field readers: a value of the wrong type is not observed.
const obj = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
const flag = (value: unknown) => value === true;
// An address a page may link to: http or https only.
const web = (value: unknown): string | undefined => {
  const url = text(value);
  return url && /^https?:\/\//i.test(url) && URL.canParse(url)
    ? url
    : undefined;
};
const moment = (value: unknown): string | undefined => {
  const at = text(value);
  return at && !Number.isNaN(Date.parse(at)) ? at : undefined;
};
// A stored image: a path under /media/ that is in public/, of a type the
// deploy knows (tools/delivery-plan.mjs).
const image = (value: unknown): string | undefined => {
  const path = text(value);
  if (
    !path ||
    !/^\/media\/[A-Za-z0-9._/-]+\.(?:jpg|png|webp)$/.test(path) ||
    path.split('/').includes('..')
  )
    return undefined;
  return existsSync(join(publicDir, path)) ? path : undefined;
};

// Dates, in Central, as data.ts shows them; a bare calendar date (RDAP's
// registered, a book's published) is that day wherever you are.
const zone = 'America/Chicago';
const long = (timeZone: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
const centralLong = long(zone);
const utcLong = long('UTC');
const monthYear = new Intl.DateTimeFormat('en-US', {
  timeZone: zone,
  year: 'numeric',
  month: 'long',
});
// Anything else (Open Library's "May 2006", "c1998") is shown as written.
export function calendarLabel(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value))
    return utcLong.format(new Date(`${value}T00:00:00Z`));
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) &&
    !Number.isNaN(Date.parse(value))
  )
    return centralLong.format(new Date(value));
  return value;
}
export const monthYearLabel = (iso: string) => monthYear.format(new Date(iso));

// Hosts: RDAP and the home page (docs/DATA.md; "home" is version 2). Nothing
// from dns or https.
export interface HostFeed {
  type: 'rss' | 'atom' | 'json';
  url: string;
  title?: string;
}
export interface HostFacts {
  domain?: string; // the registrable domain RDAP answered for
  registered?: string;
  registrar?: string;
  expires?: string;
  homeTitle?: string;
  generator?: string;
  feeds: HostFeed[];
  hcard: boolean;
  relMe: boolean;
  webmention: boolean;
}
const feedTypes = new Set(['rss', 'atom', 'json']);

export function hostFacts(host: string): HostFacts | undefined {
  const record = hostRecords.get(host);
  if (!record) return undefined;
  const rdap = obj(record.rdap);
  const home = obj(record.home);
  // A home page that answered with an error (a bot wall, a timeout) tells
  // nothing about the host; its title would be the wall's.
  const seen = home && !text(home.error) ? home : undefined;
  const feeds: HostFeed[] = [];
  for (const feed of Array.isArray(seen?.feeds) ? seen.feeds : []) {
    const f = obj(feed);
    const url = web(f?.url);
    const type = text(f?.type);
    if (f && url && type && feedTypes.has(type))
      feeds.push({
        type: type as HostFeed['type'],
        url,
        title: text(f.title),
      });
  }
  const facts: HostFacts = {
    domain: text(rdap?.domain),
    registered: text(rdap?.registered),
    registrar: text(rdap?.registrar),
    expires: text(rdap?.expires),
    homeTitle: text(seen?.title),
    generator: text(seen?.generator),
    feeds,
    hcard: flag(seen?.hcard),
    relMe: Array.isArray(seen?.rel_me) && seen.rel_me.some((url) => web(url)),
    webmention: !!web(seen?.webmention),
  };
  const any =
    facts.registered ||
    facts.homeTitle ||
    facts.generator ||
    feeds.length ||
    facts.hcard ||
    facts.relMe ||
    facts.webmention;
  return any ? facts : undefined;
}
export const feedLabel = (feed: HostFeed) =>
  feed.title ??
  { rss: 'RSS', atom: 'Atom', json: 'JSON Feed' }[feed.type] ??
  'Feed';

// Pages: the Wayback Machine's captures. Nothing else from the page record
// is read (its status, alive, final_url and redirects are liveness).
export interface Wayback {
  first?: string;
  last?: string;
  count: number;
  capped: boolean;
}
export function waybackOf(id: string): Wayback | undefined {
  const w = obj(pageRecords.get(id)?.wayback);
  const n = count(w?.count);
  if (!w || n === undefined) return undefined;
  return {
    first: moment(w.first),
    last: moment(w.last),
    count: n,
    capped: flag(w.count_capped),
  };
}
// "first captured July 2024, 9 captures"; nothing for none.
export function waybackLabel(w: Wayback | undefined) {
  if (!w || w.count === 0) return undefined;
  const n = w.capped
    ? '10,000 or more captures'
    : `${w.count.toLocaleString('en-US')} ${w.count === 1 ? 'capture' : 'captures'}`;
  return w.first ? `first captured ${monthYearLabel(w.first)}, ${n}` : n;
}

// Facts by kind (data/enrichment/facts/<yyyy>.json), from the YouTube,
// Vimeo, GitHub, Wikipedia and Open Library adapters.
interface Common {
  checked?: string;
  method: string;
}
export interface VideoFacts extends Common {
  kind: 'video';
  provider: 'youtube' | 'vimeo';
  videoId: string;
  title?: string;
  author?: string;
  authorUrl?: string;
  image?: string;
  // The player, loaded only when a visitor asks for the video.
  embed: string;
}
export interface RepositoryFacts extends Common {
  kind: 'repository';
  fullName: string;
  gist: boolean;
  description?: string;
  language?: string;
  stars?: number;
  license?: string;
  archived: boolean;
  fork: boolean;
  pushed?: string;
  homepage?: string;
  files: string[];
  fileCount?: number;
}
export interface ArticleFacts extends Common {
  kind: 'article';
  title?: string;
  description?: string;
  lang?: string;
  url?: string;
}
export interface BookFacts extends Common {
  kind: 'book';
  isbn?: string;
  title?: string;
  authors: string[];
  published?: string;
  image?: string;
  openLibrary?: string;
}
export type Facts = VideoFacts | RepositoryFacts | ArticleFacts | BookFacts;

const videoIds = {
  youtube: /^[A-Za-z0-9_-]{11}$/,
  vimeo: /^\d{1,12}$/,
};
const players = {
  youtube: (id: string) =>
    `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`,
  vimeo: (id: string) => `https://player.vimeo.com/video/${id}?autoplay=1`,
};
const strings = (value: unknown) =>
  (Array.isArray(value) ? value : [value]).flatMap((v) => text(v) ?? []);

function factsFrom(record: Json): Facts | undefined {
  const common = {
    checked: moment(record.checked),
    method: text(record.method) ?? '',
  };
  switch (record.kind) {
    case 'video': {
      const provider = text(record.provider) ?? text(record.method);
      const videoId = text(record.video_id);
      if (
        (provider !== 'youtube' && provider !== 'vimeo') ||
        !videoId ||
        !videoIds[provider].test(videoId)
      )
        return undefined;
      return {
        ...common,
        kind: 'video',
        provider,
        videoId,
        title: text(record.title),
        author: text(record.author),
        authorUrl: web(record.author_url),
        image: image(record.image),
        embed: players[provider](videoId),
      };
    }
    case 'repository': {
      const fullName = text(record.full_name);
      if (!fullName) return undefined;
      const files = Array.isArray(record.files) ? strings(record.files) : [];
      return {
        ...common,
        kind: 'repository',
        fullName,
        gist: fullName.startsWith('gist/'),
        description: text(record.description),
        language: text(record.language),
        stars: count(record.stars),
        license:
          text(record.license) === 'NOASSERTION'
            ? undefined
            : text(record.license),
        archived: flag(record.archived),
        fork: flag(record.fork),
        pushed: moment(record.pushed),
        homepage: web(record.homepage),
        files,
        fileCount: count(record.files) ?? (files.length || undefined),
      };
    }
    case 'article': {
      const facts: ArticleFacts = {
        ...common,
        kind: 'article',
        title: text(record.title),
        description: text(record.description),
        lang: text(record.lang),
        url: web(record.url),
      };
      return facts.title || facts.description ? facts : undefined;
    }
    case 'book': {
      const facts: BookFacts = {
        ...common,
        kind: 'book',
        isbn: text(record.isbn),
        title: text(record.title),
        authors: strings(record.authors),
        published: text(record.published),
        image: image(record.image),
        openLibrary: web(record.openlibrary_url),
      };
      return facts.title ? facts : undefined;
    }
  }
  return undefined;
}

// Facts for public links only: a record whose link has gone is not shown.
export const factsById = new Map<string, Facts>();
for (const [id, record] of factRecords) {
  if (!linkById.has(id)) continue;
  const facts = factsFrom(record);
  if (facts) factsById.set(id, facts);
}
export const factsOf = (id: string) => factsById.get(id);

// One video saved under several addresses: each record names the others.
const byVideo = new Map<string, string[]>();
for (const link of links) {
  const f = factsById.get(link.id);
  if (f?.kind !== 'video') continue;
  const key = `${f.provider}:${f.videoId}`;
  byVideo.set(key, [...(byVideo.get(key) ?? []), link.id]);
}
export function alsoSavedAs(link: Link): Link[] {
  const f = factsById.get(link.id);
  if (f?.kind !== 'video') return [];
  return (byVideo.get(`${f.provider}:${f.videoId}`) ?? [])
    .filter((id) => id !== link.id)
    .map((id) => linkById.get(id)!);
}

export const providerName = { youtube: 'YouTube', vimeo: 'Vimeo' } as const;

// The facts as the JSON twin carries them: the record's own field names,
// image paths made absolute, nothing that was not checked above.
export function factsJson(f: Facts) {
  const at = (path?: string) => (path ? absolute(path) : undefined);
  const base = { kind: f.kind, method: f.method, checked: f.checked };
  switch (f.kind) {
    case 'video':
      return {
        ...base,
        provider: f.provider,
        video_id: f.videoId,
        title: f.title,
        author: f.author,
        author_url: f.authorUrl,
        image: at(f.image),
      };
    case 'repository':
      return {
        ...base,
        full_name: f.fullName,
        description: f.description,
        language: f.language,
        stars: f.stars,
        license: f.license,
        archived: f.archived,
        fork: f.fork,
        pushed: f.pushed,
        homepage: f.homepage,
        ...(f.gist ? { files: f.files.length ? f.files : f.fileCount } : {}),
      };
    case 'article':
      return {
        ...base,
        title: f.title,
        description: f.description,
        lang: f.lang,
        url: f.url,
      };
    case 'book':
      return {
        ...base,
        isbn: f.isbn,
        title: f.title,
        authors: f.authors,
        published: f.published,
        image: at(f.image),
        openlibrary_url: f.openLibrary,
      };
  }
}

// What was read, for the tests and the build log.
export const enrichmentCounts = {
  hosts: hostRecords.size,
  pages: pageRecords.size,
  facts: factsById.size,
};
