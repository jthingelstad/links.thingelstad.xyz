// The search grammar, shared by /search/ (src/scripts/search.ts, in the
// browser) and the MCP server's links_search (src/mcp/search.ts), so the two
// read a query the same way and keep the same results.
//
// The grammar: site:host, year:yyyy, wt:n (an issue), kind:video (one of
// src/lib/kinds.ts), "phrases" (passed to Pagefind) and -word (excluded
// here). Host is not a Pagefind filter (7,000 values would bloat the filter
// index); it is metadata that Pagefind matches loosely, so site: is checked
// exactly here, and so is -word.
//
// Pagefind 1.5 falls back to a shorter prefix when a word has no match
// ("zxqvbnmw" finds the ZX Spectrum, "qqqqzzzz" finds "Q"), so a result is
// kept only when each typed word's first three letters start a word in its
// title, host or text. A "quoted" word must appear whole, every word of a
// phrase (Pagefind's own phrase matching lapses when a phrase is mixed with
// bare words), so "EDI" finds EDI and never Editor. wholeWords says whether
// every typed word, quoted or not, appears whole: the MCP server ranks by it.
//
// The search box's suggestions (src/lib/suggest.ts) read the word at the
// cursor with tokenAt, so they name the operators the same way.
//
// No DOM and no Node imports: both sides import this file.
import { type Kind, kindWords, kinds } from './kinds.ts';

// The operators, in the order the help line and the suggestions give them.
export const operators = ['site', 'year', 'wt', 'kind'] as const;
export type Operator = (typeof operators)[number];
const operatorWord = new RegExp(`^(${operators.join('|')}):(.+)$`, 'i');

// site:https://www.example.com/path is example.com.
export const siteName = (value: string) =>
  value
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');

// The host itself or a host under it (m.youtube.com is youtube.com): what
// site: keeps, here, in the MCP server and in the suggestions' counts.
export const onHost = (host: string, site: string) =>
  host === site || host.endsWith(`.${site}`);

export interface Query {
  text: string;
  site?: string;
  year?: string;
  issue?: string;
  kind?: Kind;
  exclude: string[];
}

// kind:video or kind:videos. The kind kept is the list's own constant, so
// what was typed never becomes part of an address.
export function kindNamed(value: string): Kind | undefined {
  const at = kinds.findIndex(
    (kind) => kind === value || kindWords[kind].title.toLowerCase() === value,
  );
  return at === -1 ? undefined : kinds[at];
}

// Splits the operators out of what was typed; the rest goes to Pagefind.
export function parse(input: string): Query {
  const query: Query = { text: '', exclude: [] };
  const kept: string[] = [];
  for (const [, neg, phrase, word] of input.matchAll(
    /(-?)(?:"([^"]*)"|(\S+))/g,
  )) {
    const op = word && operatorWord.exec(word);
    if (op && !neg) {
      const value = op[2].toLowerCase();
      if (op[1].toLowerCase() === 'site') query.site = siteName(value);
      else if (op[1].toLowerCase() === 'year' && /^\d{4}$/.test(value))
        query.year = value;
      else if (op[1].toLowerCase() === 'wt')
        query.issue = value.replace(/^wt/, '');
      else if (op[1].toLowerCase() === 'kind') query.kind = kindNamed(value);
    } else if (neg && (phrase || word)) {
      query.exclude.push((phrase ?? word).toLowerCase());
    } else if (phrase !== undefined) {
      kept.push(`"${phrase}"`);
    } else if (word) {
      kept.push(word);
    }
  }
  query.text = kept.join(' ');
  return query;
}

// The word the cursor is in, for the suggestions: where it starts and ends
// and, for site:kottke.org, the operator and its value. A word inside a
// "phrase" or an -exclusion has none, since neither takes a suggestion.
export interface Token {
  start: number;
  end: number;
  text: string;
  operator?: Operator;
  value: string;
}
export function tokenAt(
  input: string,
  caret = input.length,
): Token | undefined {
  let start = caret;
  while (start > 0 && !/\s/.test(input[start - 1])) start--;
  let end = caret;
  while (end < input.length && !/\s/.test(input[end])) end++;
  const text = input.slice(start, end);
  const quotes = input.slice(0, start).split('"').length - 1;
  if (quotes % 2 || text.startsWith('-') || text.includes('"')) return;
  const op = /^([a-z]+):(.*)$/i.exec(text);
  const operator = operators.find((name) => name === op?.[1].toLowerCase());
  return operator
    ? { start, end, text, operator, value: op![2] }
    : { start, end, text, value: text };
}

// What Pagefind is asked for. The host's words are searched too, so site:
// alone finds its links.
export const searchTerm = (query: Pick<Query, 'text' | 'site'>) =>
  [query.text, query.site?.replace(/\./g, ' ')].filter(Boolean).join(' ');

// Pagefind also matches metadata, loosely (the nnxyz lesson): a word can
// match a date or an issue label. Keep matches in the text, the title or the
// host.
export const isCandidate = (result: {
  words: number[];
  matchedMetaFields?: string[];
}) =>
  result.words.length > 0 ||
  !!result.matchedMetaFields?.some((f) => f === 'title' || f === 'host');

// The fields of a Pagefind result this file reads.
export interface Found {
  content: string;
  meta: { title?: string; host?: string };
}

// The units of a query's text as typed: bare words and "phrases".
export const units = (text: string): string[] =>
  [...text.matchAll(/"[^"]*"|\S+/g)].map((m) => m[0]);

// The words of a text, lower-cased: letters and digits only, so each is
// safe inside a regular expression.
const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
const typed = (text: string) => ({
  bare: wordsOf(text.replace(/"[^"]*"/g, ' ')),
  quoted: wordsOf([...text.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join(' ')),
});
// A word's first three letters start a word; a word appears whole.
const starts = (word: string) =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}])${word.slice(0, 3)}`, 'u');
const whole = (word: string) =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}])${word}(?:$|[^\\p{L}\\p{N}])`, 'u');
const textOf = (data: Found) =>
  `${data.meta.title ?? ''} ${data.meta.host ?? ''} ${data.content}`.toLowerCase();

// The check run on each candidate's data: site: exactly (the host or under
// it), the first three letters of each bare word, each "quoted" word whole,
// and no -word.
export function matcher(
  query: Pick<Query, 'text' | 'site' | 'exclude'>,
): (data: Found) => boolean {
  const { site, exclude } = query;
  const words = typed(query.text);
  const tests = [
    ...words.bare.filter((word) => word.length >= 3).map(starts),
    ...words.quoted.map(whole),
  ];
  return (data) => {
    const host = data.meta.host;
    const text = textOf(data);
    return (
      (!site || (!!host && onHost(host, site))) &&
      tests.every((test) => test.test(text)) &&
      !exclude.some((word) => text.includes(word))
    );
  };
}

// Whether every typed word, bare or quoted, appears whole: what ranks a
// result above one its first letters matched (EDI above Editor).
export function wholeWords(text: string): (data: Found) => boolean {
  const words = typed(text);
  const tests = [...words.bare, ...words.quoted].map(whole);
  return (data) => {
    const text = textOf(data);
    return tests.every((test) => test.test(text));
  };
}
