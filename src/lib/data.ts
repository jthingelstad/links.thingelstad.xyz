// The one module that reads data/ (docs/DATA.md) and the one place the site's
// URLs are formed. Everything "derived at build" is derived here, in memory,
// and nothing is written back to data/.
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
import { noteLinks, plainNote, prepare, renderNote } from './markdown.ts';
import { hostOf, normalizeUrl } from './normalize.ts';

export { hostOf, normalizeUrl };

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

// Who the note speaks for, by heuristic, never asserted (docs/DIRECTION.md,
// "Voice"): "jamie" is Jamie's commentary; "mixed" is commentary around a
// quotation; "excerpt" is most likely a passage from the page, which is what
// the bookmarklet captured before the Weekly Thing years.
export type Voice = 'jamie' | 'mixed' | 'excerpt';

export interface Link extends MirrorLink {
  host: string;
  year: number; // Central
  month: number; // Central, 1 to 12
  day: string; // Central, YYYY-MM-DD
  week: string; // the Monday of the Central week, YYYY-MM-DD
  hasNote: boolean;
  voice: Voice | null;
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
const clock = new Intl.DateTimeFormat('en-US', {
  timeZone: zone,
  hour: 'numeric',
  minute: '2-digit',
});
export const dateLabel = (iso: string) => longDate.format(new Date(iso));
export const shortDateLabel = (iso: string) => shortDate.format(new Date(iso));
export const timeLabel = (iso: string) => clock.format(new Date(iso));
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
export function weekOf(day: string) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

export function voiceOf(note: string, year: number): Voice | null {
  const text = prepare(note);
  if (!text) return null;
  const blocks = text.split(/\n\s*\n/).filter((block) => block.trim());
  const quoted = blocks.filter((block) => block.trimStart().startsWith('>'));
  if (quoted.length === blocks.length) return 'excerpt';
  // A quotation set inside other text is Jamie quoting something.
  if (quoted.length) return 'mixed';
  if (/^["“‘«„]/.test(text)) return blocks.length > 1 ? 'mixed' : 'excerpt';
  // Before the Weekly Thing (2017) the bookmarklet saved the page's own words;
  // the earliest years (2005 and 2006, from del.icio.us) are short
  // descriptions in Jamie's words.
  if (year >= 2007 && year <= 2016) return 'excerpt';
  return 'jamie';
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const mirror: MirrorLink[] = readdirSync(join(root, 'data/links'))
  .filter((name) => /^\d{4}\.json$/.test(name))
  .sort()
  .flatMap((name) => read<MirrorLink[]>(`data/links/${name}`));

// Every public link, oldest first.
export const links: Link[] = mirror
  .map((link) => {
    const day = centralDay(link.saved);
    const year = Number(day.slice(0, 4));
    return {
      ...link,
      host: hostOf(link.url),
      year,
      month: Number(day.slice(5, 7)),
      day,
      week: weekOf(day),
      hasNote: link.note.trim() !== '',
      voice: voiceOf(link.note, year),
    };
  })
  .sort((a, b) => byText(a.saved, b.saved) || byText(a.id, b.id));
export const newest = [...links].reverse();
export const linkById = new Map(links.map((link) => [link.id, link]));

export const issues: Issue[] = read<{ issues: Issue[] }>(
  'data/derived/issues.json',
).issues;
// An issue's key is its segment on weekly.thingelstad.com (/archive/<key>/):
// the number, or 140-special for the one special issue. /issues/<key>/ mirrors
// it (DIRECTION.md, "Pages").
export function issueKey(issue: Issue) {
  const key = /^https:\/\/weekly\.thingelstad\.com\/archive\/([^/]+)\/$/.exec(
    issue.url,
  )?.[1];
  if (!key || (issue.number !== null && key !== String(issue.number)))
    throw new Error(`issue ${issue.slug}: url ${issue.url} has no archive key`);
  return key;
}
export const issueByKey = new Map(
  issues.map((issue) => [issueKey(issue), issue]),
);

// Canonical paths. Permalinks and twins depend on these never changing.
export const site = 'https://links.thingelstad.xyz';
export const linkPath = (id: string) => `/links/${id}/`;
export const linkJsonPath = (id: string) => `/links/${id}.json`;
export const linkMarkdownPath = (id: string) => `/links/${id}.md`;
export const hostPath = (host: string) => `/hosts/${host}/`;
export const issuePath = (issue: Issue) => `/issues/${issueKey(issue)}/`;
export const yearPath = (year: number | string) => `/years/${year}/`;
export const monthAnchor = (year: number, month: number) =>
  `${year}-${String(month).padStart(2, '0')}`;
export const monthPath = (year: number, month: number) =>
  `${yearPath(year)}#${monthAnchor(year, month)}`;
export const absolute = (path: string) => new URL(path, site).href;

// Elsewhere. Pinboard's own bookmark ids are private (DIRECTION.md, "The id"),
// so a record offers a search for its URL in Jamie's account instead.
export const pinboardSearchUrl = (url: string) =>
  `https://pinboard.in/search/u:jthingelstad?query=${encodeURIComponent(url)}`;
export const waybackUrl = (url: string) =>
  `https://web.archive.org/web/*/${url}`;

// Issues are named like WT350; the one special issue has no number.
export const issueLabel = (issue: Issue) =>
  issue.number === null ? 'Special' : `WT${issue.number}`;
// The issue as it was titled when it went out: its subject line, from
// "Weekly Thing for May 13, 2017" to "WT350 — Builders Puzzlers And Agents".
export const issueTitle = (issue: Issue) => issue.subject || issue.title;

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

export const noteHtml = (link: Link) =>
  renderNote(link.note, (href) => {
    const id = resolveUrl(href, link.saved);
    const target = id && id !== link.id ? linkById.get(id) : undefined;
    return target ? { path: linkPath(target.id), title: target.title } : null;
  });
export const noteText = (link: Link, max?: number) => plainNote(link.note, max);

// The URL as a reader would type it: no scheme, no trailing slash.
export const displayUrl = (url: string) =>
  url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '');

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

// One link for the home page, chosen at build: the same all day (Central),
// different the next. Drawn from the notes in Jamie's own words.
export function linkOfTheDay(now = new Date()) {
  const pool = links.filter(
    (link) => link.voice === 'jamie' || link.voice === 'mixed',
  );
  let seed = 0;
  for (const char of centralDay(now.toISOString()))
    seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  return pool[seed % pool.length];
}
