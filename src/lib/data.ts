// The one module that reads data/ (docs/DATA.md); the site's URLs are formed
// in paths.ts and re-exported here. Everything "derived at build" is derived
// here, in memory, and nothing is written back to data/.
//
// Data stays UTC; every date shown, and every year, month and week a link is
// grouped by, is US Central (America/Chicago), the way Pinboard's own pages
// show them.
//
// Files are read with node:fs from the working directory (the repository root
// for npm run build, dev and test), so node --test can import this module
// directly.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { noteLinks, plainNote, renderNote } from './markdown.ts';
import { type Kind, kindOf, kinds } from './kinds.ts';
import { hostOf, normalizeUrl } from './normalize.ts';
import { AGENT_TAG, type Voice, voiceOf } from './voice.ts';
import { shownTitle, titleEndings } from './titles.ts';
import { absolute, hostPath, issueKey, linkPath } from './paths.ts';

export { hostOf, normalizeUrl };
export { type Kind, kinds };
export { AGENT_TAG, type Voice, voiceOf };
// The site's URLs are formed in paths.ts; the pages import them from here.
export * from './paths.ts';

// data/links/<yyyy>.json, as the sync writes it.
export interface MirrorLink {
  id: string;
  hash: string;
  url: string;
  title: string;
  note: string;
  saved: string;
  tags: string[];
  toread: boolean;
  meta: string;
}
// data/derived/issues.json
export interface IssueLink {
  position: number;
  id: string | null;
  url: string;
  // null is absent: never shown as "null".
  text: string | null;
  section: string | null;
  heading_context: string | null;
}
export interface Issue {
  number: number | null;
  slug: string;
  title: string;
  subject: string;
  date: string;
  url: string;
  links: IssueLink[];
}

export interface Link extends MirrorLink {
  host: string;
  year: number; // Central
  month: number; // Central, 1 to 12
  day: string; // Central, YYYY-MM-DD
  week: string; // the Monday of the Central week, YYYY-MM-DD
  hasNote: boolean;
  voice: Voice | null;
  kind: Kind; // from host and path (kinds.ts)
  shown: string; // the title as pages and feeds show it (titles.ts)
  clock: boolean; // whether the time of day saved is real (below)
}

export interface Appearance {
  issue: Issue;
  position: number;
  section: string | null;
  text: string | null;
}

const root = process.env.LINKS_ROOT || process.cwd();
const read = <T>(path: string): T =>
  JSON.parse(readFileSync(join(root, path), 'utf8')) as T;

// Dates, in Central.
const zone = 'America/Chicago';
const partsOf = new Intl.DateTimeFormat('en-US', {
  timeZone: zone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const longDate = new Intl.DateTimeFormat('en-US', {
  timeZone: zone,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});
const shortDate = new Intl.DateTimeFormat('en-US', {
  timeZone: zone,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});
const weekdayDate = new Intl.DateTimeFormat('en-US', {
  timeZone: zone,
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});
const clock = new Intl.DateTimeFormat('en-US', {
  timeZone: zone,
  hour: 'numeric',
  minute: '2-digit',
});
export const dateLabel = (iso: string) => longDate.format(new Date(iso));
export const shortDateLabel = (iso: string) => shortDate.format(new Date(iso));
export const timeLabel = (iso: string) => clock.format(new Date(iso));
// "Thursday, September 17, 2026": the record's saved line and an issue's send.
export const weekdayDateLabel = (iso: string) =>
  weekdayDate.format(new Date(iso));
export const monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function centralDay(iso: string) {
  const parts = Object.fromEntries(
    partsOf.formatToParts(new Date(iso)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
// A UTC timestamp as Central wall time with its real offset (-05:00 in
// daylight time, -06:00 in standard time), for feeds: RFC 3339 for JSON Feed,
// RFC 822 with a four-digit year (as RFC 1123 has it) for RSS.
const wallClock = new Intl.DateTimeFormat('en-US', {
  timeZone: zone,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
function centralWall(iso: string) {
  const date = new Date(iso);
  const p = Object.fromEntries(
    wallClock.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const wall = new Date(
    Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second),
  );
  const minutes = Math.round(
    (wall.getTime() - Math.floor(date.getTime() / 1000) * 1000) / 60000,
  );
  const sign = minutes < 0 ? '-' : '+';
  const hh = String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0');
  const mm = String(Math.abs(minutes) % 60).padStart(2, '0');
  return { p, wall, sign, hh, mm };
}
export function rfc3339Central(iso: string) {
  const { p, sign, hh, mm } = centralWall(iso);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function rfc822Central(iso: string) {
  const { p, wall, sign, hh, mm } = centralWall(iso);
  const month = monthNames[+p.month - 1].slice(0, 3);
  return `${weekdays[wall.getUTCDay()]}, ${p.day} ${month} ${p.year} ${p.hour}:${p.minute}:${p.second} ${sign}${hh}${mm}`;
}
export function weekOf(day: string) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const mirror: MirrorLink[] = readdirSync(join(root, 'data/links'))
  .filter((name) => /^\d{4}\.json$/.test(name))
  .sort()
  .flatMap((name) => read<MirrorLink[]>(`data/links/${name}`));

// A saved time on the hour exactly, or one that many links share (67 were
// stamped 2010-12-05 12:21:18 UTC by an import), is a made-up clock: those
// records show the date alone (Jamie, 2026-10-24).
const stamps = new Map<string, number>();
for (const link of mirror)
  stamps.set(link.saved, (stamps.get(link.saved) ?? 0) + 1);
const realClock = (saved: string) =>
  !/T\d\d:00:00/.test(saved) && (stamps.get(saved) ?? 0) < 10;

const isHome = (url: string) => {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') === '';
  } catch {
    return false;
  }
};
const endings = titleEndings(
  mirror.map((link) => ({ host: hostOf(link.url), title: link.title })),
);

// Every public link, oldest first.
export const links: Link[] = mirror
  .map((link) => {
    const day = centralDay(link.saved);
    const host = hostOf(link.url);
    const year = Number(day.slice(0, 4));
    return {
      ...link,
      host,
      year,
      month: Number(day.slice(5, 7)),
      day,
      week: weekOf(day),
      hasNote: link.note.trim() !== '',
      voice: voiceOf(link.note, year, link.tags),
      kind: kindOf(link.url),
      shown: shownTitle(link.title, host, endings, isHome(link.url)),
      clock: realClock(link.saved),
    };
  })
  .sort((a, b) => byText(a.saved, b.saved) || byText(a.id, b.id));
export const newest = [...links].reverse();
export const linkById = new Map(links.map((link) => [link.id, link]));

export const issues: Issue[] = read<{ issues: Issue[] }>(
  'data/derived/issues.json',
).issues;
export const issueByKey = new Map(
  issues.map((issue) => [issueKey(issue), issue]),
);

// Lookups by URL: exactly as saved first, then by the normalised form.
const byUrl = new Map(links.map((link) => [link.url, link.id]));
const byNormal = new Map<string, string[]>();
for (const link of links) {
  const key = normalizeUrl(link.url);
  if (!byNormal.has(key)) byNormal.set(key, []);
  byNormal.get(key)!.push(link.id);
}
// When several saved links normalise alike, the rule join_issues.py uses
// (tools/README.md): the one saved under exactly this URL, else the latest
// saved at or before `at`, else the earliest.
export function resolveUrl(url: string, at?: string): string | undefined {
  const exact = byUrl.get(url);
  if (exact) return exact;
  const ids = byNormal.get(normalizeUrl(url));
  if (!ids) return undefined;
  if (at)
    for (const id of [...ids].reverse())
      if (linkById.get(id)!.saved <= at) return id;
  return ids[0];
}

// Saved twice: two saved URLs that normalise alike (scheme or www only).
export const savedTwice = new Map<string, string[]>();
for (const ids of byNormal.values()) {
  if (ids.length < 2) continue;
  for (const id of ids)
    savedTwice.set(
      id,
      ids.filter((other) => other !== id),
    );
}

// Appearances: id to the issues that carried it, in issue order.
export const appearances = new Map<string, Appearance[]>();
for (const issue of issues) {
  for (const row of [...issue.links].sort((a, b) => a.position - b.position)) {
    if (!row.id || !linkById.has(row.id)) continue;
    const list = appearances.get(row.id) ?? [];
    if (list.some((a) => a.issue === issue)) continue;
    list.push({
      issue,
      position: row.position,
      section: row.section || null,
      text: row.text || null,
    });
    appearances.set(row.id, list);
  }
}

// Note mentions: links inside a note that resolve to another saved link.
export const mentions = new Map<string, string[]>();
export const mentionedBy = new Map<string, string[]>();
for (const link of links) {
  if (!link.hasNote) continue;
  const found = [
    ...new Set(
      noteLinks(link.note)
        .map((url) => resolveUrl(url, link.saved))
        .filter((id): id is string => !!id && id !== link.id),
    ),
  ];
  if (!found.length) continue;
  mentions.set(link.id, found);
  for (const id of found) {
    const list = mentionedBy.get(id) ?? [];
    list.push(link.id);
    mentionedBy.set(id, list);
  }
}

// Hosts, each with its links oldest first.
export const linksByHost = new Map<string, Link[]>();
for (const link of links) {
  const list = linksByHost.get(link.host) ?? [];
  list.push(link);
  linksByHost.set(link.host, list);
}
export interface Host {
  host: string;
  count: number;
  first: string;
  last: string;
}
export const hosts: Host[] = [...linksByHost]
  .map(([host, list]) => ({
    host,
    count: list.length,
    first: list[0].saved,
    last: list[list.length - 1].saved,
  }))
  .sort((a, b) => b.count - a.count || byText(a.host, b.host));
export const hostByName = new Map(hosts.map((host) => [host.host, host]));
// A host's links per Central year, from the host's first year to the
// collection's newest year, years with none included: the record's little
// chart of a site.
export function hostYears(host: string): { year: number; count: number }[] {
  const list = linksByHost.get(host);
  if (!list) return [];
  const last = links[links.length - 1].year;
  const counts = new Map<number, number>();
  for (const link of list)
    counts.set(link.year, (counts.get(link.year) ?? 0) + 1);
  return Array.from({ length: last - list[0].year + 1 }, (_, i) => ({
    year: list[0].year + i,
    count: counts.get(list[0].year + i) ?? 0,
  }));
}

// Years and weeks, in Central.
export const linksByYear = new Map<number, Link[]>();
const linksByWeek = new Map<string, Link[]>();
for (const link of links) {
  const year = linksByYear.get(link.year) ?? [];
  year.push(link);
  linksByYear.set(link.year, year);
  const week = linksByWeek.get(link.week) ?? [];
  week.push(link);
  linksByWeek.set(link.week, week);
}
export const years = [...linksByYear.keys()].sort((a, b) => a - b);

// Kinds, each with its links oldest first; every kind is listed, even one
// with no links (it has a page saying so).
export const linksByKind = new Map<Kind, Link[]>(
  kinds.map((kind) => [kind, []]),
);
for (const link of links) linksByKind.get(link.kind)!.push(link);

// The others nearest in time to a link, from a list it belongs to.
function nearest(link: Link, list: Link[], limit: number) {
  const t = Date.parse(link.saved);
  return list
    .filter((other) => other.id !== link.id)
    .sort(
      (a, b) =>
        Math.abs(Date.parse(a.saved) - t) - Math.abs(Date.parse(b.saved) - t),
    )
    .slice(0, limit)
    .sort((a, b) => byText(a.saved, b.saved));
}

const linksOf = (ids: string[] | undefined) =>
  (ids ?? []).map((id) => linkById.get(id)!).filter(Boolean);

// Every connection a record shows (DIRECTION.md, "Connections"), phase 1: the
// ones that need no new data. Each row is empty when there is nothing to say.
export function connectionsOf(link: Link, limit = 5) {
  const host = linksByHost.get(link.host) ?? [];
  const week = linksByWeek.get(link.week) ?? [];
  return {
    sameHost: { total: host.length - 1, nearest: nearest(link, host, limit) },
    sameWeek: { total: week.length - 1, nearest: nearest(link, week, limit) },
    mentions: linksOf(mentions.get(link.id)),
    mentionedBy: linksOf(mentionedBy.get(link.id)),
    savedTwice: linksOf(savedTwice.get(link.id)),
  };
}

// `full` makes record links absolute, for feeds, where a reader has no page
// to resolve a path against.
export const noteHtml = (link: Link, full = false) =>
  renderNote(link.note, (href) => {
    const id = resolveUrl(href, link.saved);
    const target = id && id !== link.id ? linkById.get(id) : undefined;
    if (!target) return null;
    const path = linkPath(target.id);
    return { path: full ? absolute(path) : path, title: target.title };
  });
export const noteText = (link: Link, max?: number) => plainNote(link.note, max);

// The URL as a reader would type it: no scheme, no trailing slash.
export const displayUrl = (url: string) =>
  url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '');

// Pages search engines may index (Jamie, 2026-10-24: "there isn't enough for
// a crawler to get any value" in the rest). A record is indexed when it holds
// Jamie's own words or ran in a Weekly Thing; a host page when it lists more
// than one link. The rest stay up for readers, marked noindex and left out of
// the sitemap, and crawlers still follow their links.
export const indexedRecord = (link: Link) =>
  link.voice === 'jamie' || link.voice === 'mixed' || appearances.has(link.id);
export const indexedHost = (host: Host) => host.count > 1;
export const unindexed = new Set([
  ...links
    .filter((link) => !indexedRecord(link))
    .map((link) => absolute(linkPath(link.id))),
  ...hosts
    .filter((host) => !indexedHost(host))
    .map((host) => absolute(hostPath(host.host))),
]);

export const counts = {
  links: links.length,
  hosts: hosts.length,
  years: years.length,
  withNote: links.filter((link) => link.hasNote).length,
  inIssues: appearances.size,
  issues: issues.length,
  first: links[0]?.saved,
  last: links[links.length - 1]?.saved,
};

export const number = (n: number) => n.toLocaleString('en-US');
export const plural = (n: number, one: string, many = `${one}s`) =>
  `${number(n)} ${n === 1 ? one : many}`;
