// The search box's suggestions on /search/ (src/scripts/suggest.ts shows
// them). For the word at the cursor (tokenAt in search-grammar.ts): the
// sites, years, issues and kinds an operator could name, the operator a word
// starts to spell, and the site, year or issue a plain word names. They come
// from /search/suggest.json (src/pages/search/suggest.json.ts), so the counts
// are the build's totals. Pagefind's filter counts were measured and left
// out (2026-10-24): they take a "phrase" as either word and know nothing of
// site: or -word, so they disagree with the results the page shows.
//
// No DOM and no Node imports, so npm test runs it.
import { type Kind, kindWords } from './kinds.ts';
import {
  type Operator,
  type Token,
  kindNamed,
  operators,
  siteName,
} from './search-grammar.ts';

// /search/suggest.json. Hosts by count, then name, as data.ts sorts them;
// issues and years newest first; kinds in their order.
export interface SuggestData {
  hosts: [host: string, links: number][];
  issues: [key: string, title: string, date: string, links: number][];
  years: [year: number, links: number][];
  kinds: [kind: Kind, links: number][];
}

export interface Suggestion {
  // What replaces the word at the cursor: "site:kottke.org", or "site:" to
  // go on to that operator's own suggestions.
  insert: string;
  note: string;
}

// A suggestion before its note is written: what it is, and its count.
interface Row {
  insert: string;
  about?: string;
  links?: number;
}

export const limit = 8;

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
// part of a host (site:verge finds theverge.com), each by count.
function sites(value: string, data: SuggestData): Row[] {
  const want = siteName(value);
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
  return data.hosts
    .map(([host, links], order) => ({ host, links, order, rank: rank(host) }))
    .filter((row) => row.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, limit)
    .map(({ host, links }) => ({ insert: `site:${host}`, links }));
}

const issueRow = ([
  key,
  title,
  date,
  links,
]: SuggestData['issues'][number]) => ({
  insert: `wt:${key}`,
  about: `${title} · ${date}`,
  links,
});

// wt:35 finds WT35, then the issues whose number starts 35, newest first;
// wt:otto finds the issues with Otto in the title.
function issuesFor(value: string, data: SuggestData): Row[] {
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
  return list.slice(0, limit).map(issueRow);
}

const yearsFor = (value: string, data: SuggestData): Row[] =>
  data.years
    .filter(([year]) => String(year).startsWith(value))
    .slice(0, limit)
    .map(([year, links]) => ({ insert: `year:${year}`, links }));

// kind:vi and kind:videos both find kind:video.
const kindsFor = (value: string, data: SuggestData): Row[] =>
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
    }));

const byOperator: Record<
  Operator,
  (value: string, data: SuggestData) => Row[]
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
function plain(text: string, data: SuggestData): Row[] {
  const word = text.toLowerCase();
  const found: Row[] = [];
  if (word.length >= 2)
    found.push(
      ...operators.filter((name) => name.startsWith(word)).map(operatorRow),
    );
  const year = /^\d{4}$/.test(word)
    ? data.years.find(([y]) => String(y) === word)
    : undefined;
  if (year) found.push({ insert: `year:${word}`, links: year[1] });
  const number = /^wt(\d+)$/.exec(word)?.[1];
  const issue =
    number &&
    data.issues.find(
      ([key, , , links]) => key === String(Number(number)) && links,
    );
  if (issue) found.push(issueRow(issue));
  if (/^[a-z0-9-]{3,}$/.test(word)) {
    let named = 0;
    for (const [host, links] of data.hosts) {
      if (links < 2 || named === 2) break;
      if (siteWord(host) !== word) continue;
      found.push({ insert: `site:${host}`, links });
      named++;
    }
  }
  return found;
}

// The suggestions for the word at the cursor in the box, best first,
// leaving out one that is already what was typed. An empty word gets the
// operators. The counts are the whole collection's, so with other words in
// the box they say so ("917 links in all" beside kubb year:2019).
export function suggest(
  input: string,
  token: Token | undefined,
  data: SuggestData,
): Suggestion[] {
  if (!token) return [];
  const rows = token.operator
    ? byOperator[token.operator](token.value, data)
    : token.text
      ? plain(token.text, data)
      : operators.map(operatorRow);
  const others = !!(
    input.slice(0, token.start) + input.slice(token.end)
  ).trim();
  const count = (n: number) =>
    `${n.toLocaleString('en-US')} ${n === 1 ? 'link' : 'links'}${others ? ' in all' : ''}`;
  const typed = token.text.toLowerCase();
  return rows
    .filter((row) => row.insert.toLowerCase() !== typed)
    .map((row) => ({
      insert: row.insert,
      note: [row.about, row.links === undefined ? '' : count(row.links)]
        .filter(Boolean)
        .join(' · '),
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
      ? data.hosts.some(([host]) => host === site || host.endsWith(`.${site}`))
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
