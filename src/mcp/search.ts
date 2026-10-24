// links_search: the site's own search, run from the server. Words go to the
// Pagefind index the site publishes at /pagefind/ (the same index, ranking
// and grammar as /search/, src/lib/search-grammar.ts); a query with no words
// (a year, a host, a kind, an issue, a tag alone) is answered from the
// dataset in memory, exactly and newest first, since a wordless Pagefind
// search loads the whole index.
//
// Every candidate Pagefind returns is checked the way the browser checks it
// (isCandidate, then the matcher on its data), then against the dataset, so
// a result always agrees with the arguments. Checking costs a fragment fetch
// per candidate, so it stops once the page is full or a budget is spent; the
// total is exact only when every candidate was checked.
import {
  type Query,
  isCandidate,
  kindNamed,
  matcher,
  parse,
  searchTerm,
} from '../lib/search-grammar.ts';
import { type Kind, kinds } from '../lib/kinds.ts';
import { plainNote } from '../lib/markdown.ts';
import {
  type Dataset,
  type Issue,
  type Link,
  hostNamed,
  issueNamed,
  onHost,
} from './dataset.ts';

// The parts of Pagefind 1.5's API the server uses.
export interface PagefindData {
  url: string;
  content: string;
  meta: { title?: string; host?: string };
}
export interface PagefindResult {
  id: string;
  words: number[];
  matchedMetaFields?: string[];
  data(): Promise<PagefindData>;
}
export interface PagefindInstance {
  init(): Promise<void> | void;
  search(
    term: string,
    options: {
      filters?: Record<string, string>;
      sort?: Record<string, 'asc' | 'desc'>;
    },
  ): Promise<{ results: PagefindResult[] } | null>;
  destroy?(): Promise<void> | void;
}
export type CreateInstance = (options: {
  basePath: string;
}) => PagefindInstance;

export class SearchUnavailable extends Error {}

// One Pagefind instance per data generation: a new links.json means a new
// build and a new index, so the next search starts a fresh instance (and a
// fresh cache of fragments). An error starts a fresh instance and tries once
// more.
export class Engine {
  #load: () => Promise<CreateInstance>;
  #basePath: string;
  #cacheSize: number;
  #instance: Promise<PagefindInstance> | undefined;
  #generation = -1;
  #cache = new Map<string, Promise<PagefindData>>();

  constructor(options: {
    load: () => Promise<CreateInstance>;
    basePath: string;
    cacheSize?: number;
  }) {
    this.#load = options.load;
    this.#basePath = options.basePath;
    this.#cacheSize = options.cacheSize ?? 5000;
  }

  #reset() {
    const old = this.#instance;
    this.#instance = undefined;
    this.#cache = new Map();
    old?.then((instance) => instance.destroy?.()).catch(() => {});
  }

  #get(generation: number) {
    if (generation !== this.#generation) {
      this.#reset();
      this.#generation = generation;
    }
    this.#instance ??= (async () => {
      const create = await this.#load();
      const instance = create({ basePath: this.#basePath });
      await instance.init();
      return instance;
    })();
    this.#instance.catch(() => {
      this.#instance = undefined;
    });
    return this.#instance;
  }

  async search(
    generation: number,
    term: string,
    filters: Record<string, string>,
    sort?: Record<string, 'asc' | 'desc'>,
  ): Promise<PagefindResult[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        const instance = await this.#get(generation);
        const found = await instance.search(term, {
          filters,
          ...(sort ? { sort } : {}),
        });
        return found?.results ?? [];
      } catch (error) {
        this.#reset();
        if (attempt > 0)
          throw new SearchUnavailable(
            error instanceof Error ? error.message : String(error),
          );
      }
    }
  }

  // A result's data, kept for the instance's life (the newest few thousand).
  data(result: PagefindResult): Promise<PagefindData> {
    const held = this.#cache.get(result.id);
    if (held) {
      this.#cache.delete(result.id);
      this.#cache.set(result.id, held);
      return held;
    }
    const loading = result.data();
    loading.catch(() => this.#cache.delete(result.id));
    this.#cache.set(result.id, loading);
    if (this.#cache.size > this.#cacheSize)
      this.#cache.delete(this.#cache.keys().next().value!);
    return loading;
  }
}

export type Sort = 'relevance' | 'newest' | 'oldest';
export interface SearchArgs {
  query?: string;
  year?: number;
  host?: string;
  kind?: Kind;
  issue?: string | number;
  tag?: string;
  toread?: boolean;
  in_weekly_thing?: boolean;
  has_note?: boolean;
  sort?: Sort;
  limit: number;
  offset: number;
}
export interface SearchAnswer {
  total: number;
  exact: boolean;
  links: Link[];
  nextOffset: number | null;
  notes: string[];
  mode: 'index' | 'dataset';
  // Set when a result named a record the dataset does not have yet.
  unknown: boolean;
}
export class NoSuchIssue extends Error {}

// What a search asks for once the grammar and the arguments are merged.
interface Wanted {
  words: Query;
  year?: number;
  site?: string;
  kind?: Kind;
  issue?: Issue;
  tag?: string;
  toread?: boolean;
  inWeeklyThing?: boolean;
  hasNote?: boolean;
}

// Arguments win over the same operator in the query, with a note saying so.
export function wanted(
  data: Dataset,
  args: SearchArgs,
  notes: string[],
): Wanted {
  const words = parse(args.query ?? '');
  const typed = args.query ?? '';
  const replaced = (op: string, argument: string) =>
    notes.push(`The query's ${op}: was replaced by the ${argument} argument.`);
  if (/(^|\s)kind:\S/i.test(typed) && !words.kind)
    notes.push(
      `kind: names one of ${kinds.join(', ')}; the one in the query was not recognised, so it was ignored.`,
    );
  if (/(^|\s)year:\S/i.test(typed) && !words.year)
    notes.push('year: takes four digits; the one in the query was ignored.');

  let year = words.year ? Number(words.year) : undefined;
  if (args.year !== undefined) {
    if (year !== undefined && year !== args.year) replaced('year', 'year');
    year = args.year;
  }
  let site = words.site || undefined;
  if (args.host !== undefined) {
    const host = hostNamed(args.host);
    if (site && site !== host) replaced('site', 'host');
    site = host;
  }
  let kind = words.kind;
  if (args.kind !== undefined) {
    if (kind && kind !== args.kind) replaced('kind', 'kind');
    kind = kindNamed(args.kind);
  }
  let issueName: string | number | undefined = words.issue;
  if (args.issue !== undefined) {
    if (issueName && String(issueName) !== String(args.issue))
      replaced('wt', 'issue');
    issueName = args.issue;
  }
  let issue: Issue | undefined;
  if (issueName !== undefined && issueName !== '') {
    issue = issueNamed(data, issueName);
    if (!issue) throw new NoSuchIssue(String(issueName));
  }
  return {
    words,
    year,
    site,
    kind,
    issue,
    tag: args.tag,
    toread: args.toread,
    inWeeklyThing: args.in_weekly_thing,
    hasNote: args.has_note,
  };
}

// The note as plain text, once per link, for -word on the dataset path.
const plainText = new WeakMap<Link, string>();
const textOf = (link: Link) => {
  let text = plainText.get(link);
  if (text === undefined) {
    text =
      `${link.title} ${link.host} ${plainNote(link.note, Infinity)}`.toLowerCase();
    plainText.set(link, text);
  }
  return text;
};

// Everything but the words, checked on the dataset.
function fits(data: Dataset, want: Wanted) {
  return (link: Link) =>
    (want.year === undefined || link.year === want.year) &&
    (!want.site || onHost(link.host, want.site)) &&
    (!want.kind || link.kind === want.kind) &&
    (!want.issue ||
      !!data.appearances.get(link.id)?.some((a) => a.issue === want.issue)) &&
    (want.tag === undefined || link.tags.includes(want.tag)) &&
    (want.toread === undefined || link.toread === want.toread) &&
    (want.inWeeklyThing === undefined ||
      data.appearances.has(link.id) === want.inWeeklyThing) &&
    (want.hasNote === undefined || link.hasNote === want.hasNote);
}

const recordId = (url: string) => /\/links\/([0-9a-f]{12})\/$/.exec(url)?.[1];

export async function searchLinks(
  data: Dataset,
  generation: number,
  engine: Engine,
  args: SearchArgs,
): Promise<SearchAnswer> {
  const notes: string[] = [];
  const want = wanted(data, args, notes);
  const { limit, offset } = args;
  const fit = fits(data, want);

  if (!want.words.text) {
    if (args.sort === 'relevance')
      notes.push('With no words to rank by, the links are newest first.');
    const exclude = want.words.exclude;
    const all = (args.sort === 'oldest' ? data.links : data.newest).filter(
      (link) =>
        fit(link) &&
        (!exclude.length ||
          !exclude.some((word) => textOf(link).includes(word))),
    );
    const links = all.slice(offset, offset + limit);
    return {
      total: all.length,
      exact: true,
      links,
      nextOffset:
        offset + links.length < all.length ? offset + links.length : null,
      notes,
      mode: 'dataset',
      unknown: false,
    };
  }

  const filters: Record<string, string> = {};
  if (want.year !== undefined) filters.year = String(want.year);
  if (want.issue) filters.issue = String(want.issue.number ?? 'special');
  if (want.kind) filters.kind = want.kind;
  if (want.inWeeklyThing) filters.wt = 'yes';
  if (want.hasNote) filters.note = 'yes';
  const sort: Record<string, 'asc' | 'desc'> | undefined =
    args.sort === 'newest'
      ? { date: 'desc' }
      : args.sort === 'oldest'
        ? { date: 'asc' }
        : undefined;
  const term = searchTerm({ text: want.words.text, site: want.site });
  const results = await engine.search(generation, term, filters, sort);
  const candidates = results.filter(isCandidate);
  const matches = matcher({
    text: want.words.text,
    site: want.site,
    exclude: want.words.exclude,
  });

  const need = offset + limit + 1;
  const budget = Math.min(2000, 200 + (offset + limit) * 3);
  const exactUpTo = 120;
  const found: Link[] = [];
  let checked = 0;
  let unknown = false;
  // A short list is checked whole, so its total is exact.
  while (
    checked < candidates.length &&
    checked < budget &&
    (found.length < need || checked < exactUpTo)
  ) {
    const batch = candidates.slice(checked, Math.min(checked + 40, budget));
    const loaded = await Promise.all(
      batch.map((result) => engine.data(result)),
    );
    checked += batch.length;
    for (const item of loaded) {
      const id = recordId(item.url);
      const link = id ? data.byId.get(id) : undefined;
      if (!link) {
        unknown = true;
        continue;
      }
      if (matches(item) && fit(link)) found.push(link);
    }
  }
  const complete = checked >= candidates.length;
  const links = found.slice(offset, offset + limit);
  // An empty page from an unfinished walk means the check budget ran out
  // before the offset: asking again would return the same empty page.
  const more = found.length > offset + limit || (!complete && links.length > 0);
  if (!complete && links.length > 0)
    notes.push(
      `Up to ${found.length + candidates.length - checked} links match: ${checked} of ${candidates.length} candidates were checked, which is enough for this page. Ask with next_offset for more.`,
    );
  else if (!complete)
    notes.push(
      `This search reads at most ${budget} candidates, and fewer than ${offset + 1} of them match. Narrow the words, or add a year, kind or site, to reach further.`,
    );
  return {
    total: complete ? found.length : found.length + candidates.length - checked,
    exact: complete,
    links,
    nextOffset: more ? offset + links.length : null,
    notes,
    mode: 'index',
    unknown,
  };
}
