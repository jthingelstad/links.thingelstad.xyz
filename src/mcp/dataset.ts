// The server's copy of the public dataset: /links.json, /issues.json and
// /hosts.json as the site publishes them (docs/DIRECTION.md, "Agents and the
// MCP"), and the indexes the tools read. Built in memory from those three
// files only; data/ is never read, so nothing the files leave out (the
// enrichment, any liveness) can reach a result.
//
// The rows keep only the fields a result shows. links.json also carries hash
// and meta, which no tool returns, so they are dropped here.
//
// Dates stay UTC; the Central calendar day (as the site shows it) is derived
// once per link, the way src/lib/data.ts derives it at build.
import { centralDate } from '../lib/day.ts';
import { type Kind, isKind, kindOf, kinds } from '../lib/kinds.ts';
import { hostOf, normalizeUrl } from '../lib/normalize.ts';
import { issueKey } from '../lib/paths.ts';
import { type Voice, voiceOf } from '../lib/voice.ts';

// The rows of the three files, as published.
export interface LinkRow {
  id: string;
  url: string;
  title: string;
  note: string;
  saved: string;
  tags: string[];
  toread: boolean;
  kind?: string;
}
export interface IssueRow {
  position: number;
  id: string | null;
  url: string;
  text: string | null;
  section: string | null;
}
export interface IssueFile {
  number: number | null;
  slug: string;
  title: string;
  subject: string;
  date: string;
  url: string;
  links: IssueRow[];
}
export interface HostRow {
  host: string;
  count: number;
  first: string;
  last: string;
}
export interface Files {
  links: { generated: string; links: LinkRow[] };
  issues: { generated: string; issues: IssueFile[] };
  hosts: { generated: string; hosts: HostRow[] };
}

export interface Link extends LinkRow {
  kind: Kind;
  host: string;
  day: string; // the Central calendar day, YYYY-MM-DD
  year: number; // Central
  hasNote: boolean;
  voice: Voice | null;
}
export interface Issue extends IssueFile {
  key: string; // the number, or 140-special
}
export interface Appearance {
  issue: Issue;
  position: number;
  section: string | null;
  text: string | null;
}

export interface Dataset {
  generated: string;
  links: Link[]; // oldest first, by saved then id
  newest: Link[];
  byId: Map<string, Link>;
  byUrl: Map<string, string>;
  byNormal: Map<string, string[]>;
  byHost: Map<string, Link[]>; // oldest first
  byTag: Map<string, Link[]>;
  byKind: Map<Kind, Link[]>;
  byYear: Map<number, Link[]>;
  issues: Issue[]; // as issues.json lists them, oldest first
  issueByKey: Map<string, Issue>;
  appearances: Map<string, Appearance[]>;
  savedTwice: Map<string, string[]>;
  hosts: HostRow[]; // most links first
  hostByName: Map<string, HostRow>;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

export function buildDataset(files: Files): Dataset {
  const links: Link[] = files.links.links
    .map((row) => {
      const day = centralDate(new Date(row.saved));
      const year = Number(day.slice(0, 4));
      return {
        id: row.id,
        url: row.url,
        title: row.title,
        note: row.note ?? '',
        saved: row.saved,
        tags: row.tags ?? [],
        toread: !!row.toread,
        kind: row.kind && isKind(row.kind) ? row.kind : kindOf(row.url),
        host: hostOf(row.url),
        day,
        year,
        hasNote: (row.note ?? '').trim() !== '',
        voice: voiceOf(row.note ?? '', year, row.tags ?? []),
      };
    })
    .sort((a, b) => byText(a.saved, b.saved) || byText(a.id, b.id));
  const byId = new Map(links.map((link) => [link.id, link]));

  const byUrl = new Map<string, string>();
  const byNormal = new Map<string, string[]>();
  const byHost = new Map<string, Link[]>();
  const byTag = new Map<string, Link[]>();
  const byKind = new Map<Kind, Link[]>(kinds.map((kind) => [kind, []]));
  const byYear = new Map<number, Link[]>();
  for (const link of links) {
    if (!byUrl.has(link.url)) byUrl.set(link.url, link.id);
    let normal: string;
    try {
      normal = normalizeUrl(link.url);
    } catch {
      normal = link.url;
    }
    push(byNormal, normal, link.id);
    push(byHost, link.host, link);
    for (const tag of new Set(link.tags)) push(byTag, tag, link);
    byKind.get(link.kind)!.push(link);
    push(byYear, link.year, link);
  }

  // Saved twice: two saved URLs that normalise alike (scheme or www only).
  const savedTwice = new Map<string, string[]>();
  for (const ids of byNormal.values()) {
    if (ids.length < 2) continue;
    for (const id of ids)
      savedTwice.set(
        id,
        ids.filter((other) => other !== id),
      );
  }

  // An issue whose address has no archive key is left out rather than
  // failing the load; the build refuses such an issue before it publishes.
  const issues: Issue[] = [];
  for (const issue of files.issues.issues) {
    try {
      issues.push({ ...issue, key: issueKey(issue) });
    } catch {
      continue;
    }
  }
  const issueByKey = new Map(issues.map((issue) => [issue.key, issue]));

  // Appearances: id to the issues that carried it, in issue order.
  const appearances = new Map<string, Appearance[]>();
  for (const issue of issues) {
    for (const row of [...issue.links].sort(
      (a, b) => a.position - b.position,
    )) {
      if (!row.id || !byId.has(row.id)) continue;
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

  const hosts = [...files.hosts.hosts].sort(
    (a, b) => b.count - a.count || byText(a.host, b.host),
  );
  return {
    generated: files.links.generated,
    links,
    newest: [...links].reverse(),
    byId,
    byUrl,
    byNormal,
    byHost,
    byTag,
    byKind,
    byYear,
    issues,
    issueByKey,
    appearances,
    savedTwice,
    hosts,
    hostByName: new Map(hosts.map((host) => [host.host, host])),
  };
}

// When several saved links normalise alike, the rule the site uses
// (src/lib/data.ts, resolveUrl): the one saved under exactly this URL, else
// the earliest. `exact` says which it was.
export function resolveUrl(
  data: Dataset,
  url: string,
): { id: string; exact: boolean } | undefined {
  const exact = data.byUrl.get(url);
  if (exact) return { id: exact, exact: true };
  let normal: string;
  try {
    normal = normalizeUrl(url);
  } catch {
    return undefined;
  }
  const ids = data.byNormal.get(normal);
  return ids ? { id: ids[0], exact: false } : undefined;
}

// The host as typed or as a URL: lower case, no scheme, no www, no path
// (the site: rule in src/lib/search-grammar.ts).
export const hostNamed = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');

// The host itself or a host under it (m.youtube.com is youtube.com): the
// grammar's rule, so a site: argument and a site: query agree.
export { onHost } from '../lib/search-grammar.ts';

// An issue as an argument: 351, "351", "WT351", "140-special" or "special".
export function issueNamed(data: Dataset, value: string | number) {
  const text = String(value).trim().toLowerCase().replace(/^wt/, '');
  if (text === 'special' || text === '140-special')
    return data.issueByKey.get('140-special');
  return /^\d+$/.test(text)
    ? data.issueByKey.get(String(Number(text)))
    : undefined;
}
