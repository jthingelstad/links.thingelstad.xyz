// The search box's suggestions on /search/ (src/scripts/suggest.ts shows
// them). For the word at the cursor (tokenAt in search-grammar.ts): the
// sites, years, issues and kinds an operator could name, the operator a word
// starts to spell, and the site, year or issue a plain word names. They come
// from /search/suggest.json (src/pages/search/suggest.json.ts), so the counts
// are the build's: a site's count takes in the hosts under it, as site: does,
// and the year in the box (or the page's year menu), and a year's takes in
// the site. Pagefind's filter counts were measured and left out (2026-10-24):
// they take a "phrase" as either word and know nothing of site: or -word, so
// they disagree with the results the page shows.
//
// No DOM and no Node imports, so npm test runs it.
import { type Kind, kindWords } from './kinds.ts';
import {
  type Operator,
  type Token,
  kindNamed,
  onHost,
  operators,
  parse,
  siteName,
} from './search-grammar.ts';

// /search/suggest.json. Hosts by count, then name, as data.ts sorts them,
// each with its links in each Central year from its first to its last
// ([2006, 3, 0, 12] is 3 in 2006 and 12 in 2008); issues and years newest
// first; kinds in their order.
export interface SuggestData {
  hosts: [
    host: string,
    links: number,
    years: [first: number, ...counts: number[]],
  ][];
  issues: [key: string, title: string, date: string, links: number][];
  years: [year: number, links: number][];
  kinds: [kind: Kind, links: number][];
}

export interface Suggestion {
  // What replaces the word at the cursor: "site:kottke.org", or "site:" to
  // go on to that operator's own suggestions.
  insert: string;
  note: string;
  // For a site, its links in each year of the collection, oldest first; on
  // is the year the count is for (-1 for none), and label says the same in
  // words for a screen reader.
  years?: { counts: number[]; on: number; label: string };
}

// What narrows the search besides the box: the page's year menu, and its
// "in a Weekly Thing" and "has a note" boxes.
export interface Scope {
  year?: string;
  narrowed?: boolean;
}

// A suggestion before its note is written: what it is, its count, the year
// or site that count is for, and whether something else narrows the search
// that the count does not take in.
interface Row {
  insert: string;
  about?: string;
  links?: number;
  year?: string;
  from?: string;
  loose?: boolean;
  site?: Site;
}

export const limit = 8;

// Each host's links in each year of the collection (the index's first year
// onwards), with the hosts under it added in: site:youtube.com finds
// m.youtube.com's links too, so its count does. Worked out once per file.
interface Site {
  host: string;
  order: number;
  counts: number[];
  links: number;
}
interface Index {
  first: number;
  own: { host: string; counts: number[] }[];
  sites: Site[];
  byHost: Map<string, Site>;
}
const indexes = new WeakMap<SuggestData, Index>();
const total = (counts: number[]) => counts.reduce((a, b) => a + b, 0);
function indexOf(data: SuggestData): Index {
  const known = indexes.get(data);
  if (known) return known;
  const years = data.years.map(([year]) => year);
  const first = Math.min(...years);
  const span = Math.max(...years) - first + 1;
  const own = data.hosts.map(([host, , [start, ...counts]]) => {
    const row = new Array<number>(span).fill(0);
    counts.forEach((n, i) => (row[start - first + i] = n));
    return { host, counts: row };
  });
  const sites = own.map(({ host }, order) => ({
    host,
    order,
    counts: new Array<number>(span).fill(0),
    links: 0,
  }));
  const byHost = new Map(sites.map((site) => [site.host, site]));
  for (const { host, counts } of own) {
    const labels = host.split('.');
    for (let i = 0; i < labels.length - 1; i++) {
      const site = byHost.get(labels.slice(i).join('.'));
      if (site) counts.forEach((n, y) => (site.counts[y] += n));
    }
  }
  for (const site of sites) site.links = total(site.counts);
  const index = { first, own, sites, byHost };
  indexes.set(data, index);
  return index;
}

// A site's links by year, for one in the list or a part of one
// (site:example.net with only kottke.example.net saved).
function siteCounts(site: string, data: SuggestData) {
  const index = indexOf(data);
  const known = index.byHost.get(site);
  if (known) return known.counts;
  const counts = new Array<number>(index.own[0]?.counts.length ?? 0).fill(0);
  for (const row of index.own)
    if (onHost(row.host, site)) row.counts.forEach((n, y) => (counts[y] += n));
  return counts;
}

// What else is in the box, beside the word at the cursor, and the page's
// own controls: the site and year a count can take in, and whether anything
// else narrows the search.
interface Around {
  site?: string;
  year?: string;
  issue?: string;
  kind?: Kind;
  words: boolean;
  narrowed: boolean;
}
function around(input: string, token: Token, scope: Scope): Around {
  const rest = parse(
    `${input.slice(0, token.start)} ${input.slice(token.end)}`,
  );
  return {
    site: rest.site,
    year: rest.year ?? (scope.year || undefined),
    issue: rest.issue,
    kind: rest.kind,
    words: !!rest.text || rest.exclude.length > 0,
    narrowed: !!scope.narrowed,
  };
}
// Whether the search is narrower than a count that takes in only these.
const looser = (at: Around, takes: Operator[]) =>
  at.words ||
  at.narrowed ||
  (!!at.site && !takes.includes('site')) ||
  (!!at.year && !takes.includes('year')) ||
  (!!at.issue && !takes.includes('wt')) ||
  (!!at.kind && !takes.includes('kind'));

const about: Record<Operator, string> = {
  site: 'links from one site',
  year: 'links saved in one year',
  wt: 'links in one Weekly Thing',
  kind: 'videos, books, papers and more',
};
const operatorRow = (name: Operator): Row => ({
  insert: `${name}:`,
  about: about[name],
});

// site:kot finds kottke.org: the host itself, then hosts it starts, then a
// part of a host (site:verge finds theverge.com), each by count. With a year
// in the box the counts are that year's, and a site with none is left out.
function sites(value: string, data: SuggestData, at: Around): Row[] {
  const want = siteName(value);
  const { first, sites: list } = indexOf(data);
  const rank = (host: string) =>
    host === want
      ? 0
      : host.startsWith(want)
        ? 1
        : host.includes(`.${want}`)
          ? 2
          : host.includes(want)
            ? 3
            : -1;
  return list
    .map((site) => ({
      site,
      rank: rank(site.host),
      links: inYear(site, at, first),
    }))
    .filter((row) => row.rank >= 0 && row.links > 0)
    .sort(
      (a, b) =>
        a.rank - b.rank || b.links - a.links || a.site.order - b.site.order,
    )
    .slice(0, limit)
    .map(({ site, links }) => siteRow(site, links, at));
}

const inYear = (site: Site, at: Around, first: number) =>
  at.year ? (site.counts[Number(at.year) - first] ?? 0) : site.links;
const siteRow = (site: Site, links: number, at: Around): Row => ({
  insert: `site:${site.host}`,
  links,
  year: at.year,
  loose: looser(at, ['site', 'year']),
  site,
});

const issueRow = (
  [key, title, date, links]: SuggestData['issues'][number],
  at: Around,
): Row => ({
  insert: `wt:${key}`,
  about: `${title} · ${date}`,
  links,
  loose: looser(at, ['wt']),
});

// wt:35 finds WT35, then the issues whose number starts 35, newest first;
// wt:otto finds the issues with Otto in the title.
function issuesFor(value: string, data: SuggestData, at: Around): Row[] {
  const want = value.toLowerCase().replace(/^wt/, '');
  const carrying = data.issues.filter((issue) => issue[3] > 0);
  const exact = /^\d+$/.test(want) ? String(Number(want)) : want;
  const list = !want
    ? carrying
    : [
        ...carrying.filter(([key]) => key === exact),
        ...carrying.filter(
          ([key, title]) =>
            key !== exact &&
            (/^\d+$/.test(want)
              ? key.startsWith(want)
              : key.includes(want) || title.toLowerCase().includes(want)),
        ),
      ];
  return list.slice(0, limit).map((issue) => issueRow(issue, at));
}

// A year's links, from the site in the box when there is one.
function yearCount(year: number, links: number, data: SuggestData, at: Around) {
  return at.site
    ? (siteCounts(at.site, data)[year - indexOf(data).first] ?? 0)
    : links;
}
const yearRow = (year: number, links: number, at: Around): Row => ({
  insert: `year:${year}`,
  links,
  from: at.site,
  loose: looser(at, ['site', 'year']),
});

// year:201 finds 2012 and 2011; with site:kottke.org in the box, only the
// years it has links in, with its count.
const yearsFor = (value: string, data: SuggestData, at: Around): Row[] =>
  data.years
    .filter(([year]) => String(year).startsWith(value))
    .map(([year, links]) => ({ year, links: yearCount(year, links, data, at) }))
    .filter((row) => row.links > 0)
    .slice(0, limit)
    .map(({ year, links }) => yearRow(year, links, at));

// kind:vi and kind:videos both find kind:video.
const kindsFor = (value: string, data: SuggestData, at: Around): Row[] =>
  data.kinds
    .filter(
      ([kind, links]) =>
        links > 0 &&
        [kind, kindWords[kind].title.toLowerCase()].some((name) =>
          name.startsWith(value.toLowerCase()),
        ),
    )
    .map(([kind, links]) => ({
      insert: `kind:${kind}`,
      about: kindWords[kind].title,
      links,
      loose: looser(at, ['kind']),
    }));

const byOperator: Record<
  Operator,
  (value: string, data: SuggestData, at: Around) => Row[]
> = { site: sites, year: yearsFor, wt: issuesFor, kind: kindsFor };

// The name a site goes by: kottke for kottke.org, bbc for bbc.co.uk.
function siteWord(host: string) {
  const labels = host.split('.');
  const n = labels.length;
  const second =
    n >= 3 &&
    labels[n - 1].length === 2 &&
    ['ac', 'co', 'com', 'gov', 'net', 'org'].includes(labels[n - 2]);
  return labels[Math.max(n - (second ? 3 : 2), 0)];
}

// A plain word: the operator it starts to spell (si is site:), and the
// year, issue or site it names (2012, wt352, kottke), offered and never
// put in its place, since the word may be meant as a word.
function plain(text: string, data: SuggestData, at: Around): Row[] {
  const word = text.toLowerCase();
  const found: Row[] = [];
  if (word.length >= 2)
    found.push(
      ...operators.filter((name) => name.startsWith(word)).map(operatorRow),
    );
  const year = /^\d{4}$/.test(word)
    ? data.years.find(([y]) => String(y) === word)
    : undefined;
  const yearLinks = year && yearCount(year[0], year[1], data, at);
  if (year && yearLinks) found.push(yearRow(year[0], yearLinks, at));
  const number = /^wt(\d+)$/.exec(word)?.[1];
  const issue =
    number &&
    data.issues.find(
      ([key, , , links]) => key === String(Number(number)) && links,
    );
  if (issue) found.push(issueRow(issue, at));
  if (/^[a-z0-9-]{3,}$/.test(word)) {
    const { first, sites: list } = indexOf(data);
    found.push(
      ...list
        .filter((site) => site.links >= 2 && siteWord(site.host) === word)
        .map((site) => ({ site, links: inYear(site, at, first) }))
        .filter((row) => row.links > 0)
        .sort((a, b) => b.links - a.links || a.site.order - b.site.order)
        .slice(0, 2)
        .map(({ site, links }) => siteRow(site, links, at)),
    );
  }
  return found;
}

// The bars beside a site: its links in each year, the year counted marked,
// and the same in words ("2006 to 2026, most in 2012").
function yearsOf(site: Site, row: Row, data: SuggestData) {
  const { first } = indexOf(data);
  const held = site.counts.map((n, i) => (n ? first + i : 0)).filter(Boolean);
  const peak = first + site.counts.indexOf(Math.max(...site.counts));
  const label =
    held.length === 1
      ? `all in ${held[0]}`
      : `${held[0]} to ${held[held.length - 1]}, most in ${peak}`;
  return {
    counts: site.counts,
    on: row.year ? Number(row.year) - first : -1,
    label,
  };
}

// The suggestions for the word at the cursor in the box, best first,
// leaving out one that is already what was typed. An empty word gets the
// operators. A count says what it is for ("12 links in 2012" beside a site,
// "45 links from kottke.org" beside a year) and, when something else in the
// box narrows the search, that it is a total ("917 links in all" beside kubb
// year:2019).
export function suggest(
  input: string,
  token: Token | undefined,
  data: SuggestData,
  scope: Scope = {},
): Suggestion[] {
  if (!token) return [];
  const at = around(input, token, scope);
  const rows = token.operator
    ? byOperator[token.operator](token.value, data, at)
    : token.text
      ? plain(token.text, data, at)
      : operators.map(operatorRow);
  const count = (row: Row, n: number) =>
    `${n.toLocaleString('en-US')} ${n === 1 ? 'link' : 'links'}` +
    `${row.year ? ` in ${row.year}` : ''}${row.from ? ` from ${row.from}` : ''}` +
    `${row.loose ? ' in all' : ''}`;
  const typed = token.text.toLowerCase();
  return rows
    .filter((row) => row.insert.toLowerCase() !== typed)
    .map((row) => ({
      insert: row.insert,
      note: [row.about, row.links === undefined ? '' : count(row, row.links)]
        .filter(Boolean)
        .join(' · '),
      ...(row.site ? { years: yearsOf(row.site, row, data) } : {}),
    }));
}

// Whether the word at the cursor is ready to search as it is typed. An
// operator waits until its value names a site, year, issue or kind there is,
// since a half-typed site:kot finds nothing. Before the list has loaded, a
// site is ready once it looks like a host. The search button and Enter
// search regardless.
export function settled(
  token: Token | undefined,
  data: SuggestData | undefined,
) {
  if (!token?.operator) return true;
  const value = token.value.toLowerCase();
  if (token.operator === 'site') {
    const site = siteName(value);
    return data
      ? data.hosts.some(([host]) => onHost(host, site))
      : /\.[a-z]{2,}$/.test(site);
  }
  if (token.operator === 'year') return /^\d{4}$/.test(value);
  if (token.operator === 'kind') return !!kindNamed(value);
  return /^(?:wt)?(?:\d+|(?:140-)?special)$/.test(value);
}

// The box after a suggestion is taken: the word replaced, then a space
// unless it is an operator waiting for its value, and where the cursor goes.
export function complete(input: string, token: Token, insert: string) {
  const open = insert.endsWith(':');
  const after = input.slice(token.end);
  const gap = open || after.startsWith(' ') ? '' : ' ';
  return {
    value: input.slice(0, token.start) + insert + gap + after,
    caret: token.start + insert.length + (open ? 0 : 1),
  };
}
