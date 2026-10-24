// Pagefind's index, written after the build over the record pages only and
// loaded from /pagefind/ on the first search with words, not with the page
// (about 300 kB before the first result). /search/ (search.ts) and the home
// page's live results (home.ts) share it, and the filters a query asks for.
import { type Query } from '../lib/search-grammar.ts';

export interface Data {
  url: string;
  excerpt: string;
  content: string;
  meta: { title?: string; host?: string; date?: string; issue?: string };
}
export interface Match {
  words: number[];
  matchedMetaFields?: string[];
  data(): Promise<Data>;
}
export interface Pagefind {
  options(options: Record<string, unknown>): Promise<void>;
  init(): void;
  search(
    term: string | null,
    options: {
      filters?: Record<string, string>;
      sort?: Record<string, 'asc' | 'desc'>;
    },
  ): Promise<{ results: Match[] } | null>;
}

const index = '/pagefind/pagefind.js';

// One load per page; a failed one is forgotten, so the next search tries
// again.
let loading: Promise<Pagefind> | undefined;
export const pagefindStarted = () => loading !== undefined;
export const pagefind = () =>
  (loading ??= (async () => {
    const module = (await import(/* @vite-ignore */ index)) as Pagefind;
    await module.options({ excerptLength: 26 });
    module.init();
    return module;
  })().catch((error: unknown) => {
    loading = undefined;
    throw error;
  }));

// Year, issue, kind, in-a-Weekly-Thing and has-a-note are Pagefind filters.
// The year is the query's, else the page's year menu.
export function filtersFor(
  query: Query,
  page: { year?: string; wt?: boolean; note?: boolean } = {},
) {
  const filters: Record<string, string> = {};
  const year = query.year ?? page.year;
  if (year) filters.year = year;
  if (query.issue) filters.issue = query.issue;
  if (query.kind) filters.kind = query.kind;
  if (page.wt) filters.wt = 'yes';
  if (page.note) filters.note = 'yes';
  return filters;
}
