// Search on /search/. Pagefind's index (written after the build over the
// record pages only) is loaded from /pagefind/. The query and the options are
// kept in the address so a search can be shared.
//
// The small grammar: site:host, year:yyyy, wt:n (an issue), "phrases" (passed
// to Pagefind) and -word (excluded here). Year, issue, in-a-Weekly-Thing and
// has-a-note are Pagefind filters. Host is not a filter (7,000 values would
// bloat the filter index); it is metadata that Pagefind matches loosely, so
// site: is checked exactly here, and so is -word.
//
// Two Pagefind 1.5 behaviours shape this file, both found at 16,524 records:
// - a word with no match falls back to a shorter prefix ("zxqvbnmw" finds the
//   ZX Spectrum, "qqqqzzzz" finds "Q"), so a result is kept only when each
//   typed word's first three letters start a word in its title, host or text;
// - a search with no words loads the whole index (143 chunks, 3.8 MB), so a
//   year or an issue alone links to its page, which lists exactly those links.
interface Data {
  url: string;
  excerpt: string;
  content: string;
  meta: { title?: string; host?: string; date?: string; issue?: string };
}
interface Match {
  words: number[];
  matchedMetaFields?: string[];
  data(): Promise<Data>;
}
interface Pagefind {
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

const page = 20;
const index = '/pagefind/pagefind.js';

export interface Query {
  text: string;
  site?: string;
  year?: string;
  issue?: string;
  exclude: string[];
}

// Splits the operators out of what was typed; the rest goes to Pagefind.
export function parse(input: string): Query {
  const query: Query = { text: '', exclude: [] };
  const kept: string[] = [];
  for (const [, neg, phrase, word] of input.matchAll(
    /(-?)(?:"([^"]*)"|(\S+))/g,
  )) {
    const op = word && /^(site|year|wt):(.+)$/i.exec(word);
    if (op && !neg) {
      const value = op[2].toLowerCase();
      if (op[1].toLowerCase() === 'site')
        query.site = value
          .replace(/^https?:\/\//, '')
          .replace(/^www\./, '')
          .replace(/\/.*$/, '');
      else if (op[1].toLowerCase() === 'year' && /^\d{4}$/.test(value))
        query.year = value;
      else if (op[1].toLowerCase() === 'wt')
        query.issue = value.replace(/^wt/, '');
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

// Excerpts are escaped text with <mark> around matches: rebuild them as text
// and mark elements rather than parsing them as HTML.
const entities: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
};
const decode = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (entity) => entities[entity]);
function excerpt(text: string) {
  const p = document.createElement('p');
  p.className = 'snippet';
  text.split(/(<mark>.*?<\/mark>)/).forEach((part) => {
    const marked = /^<mark>(.*)<\/mark>$/.exec(part);
    if (marked) {
      const mark = document.createElement('mark');
      mark.textContent = decode(marked[1]);
      p.append(mark);
    } else if (part) p.append(decode(part));
  });
  return p;
}

function row(result: Data) {
  const item = document.createElement('li');
  const link = document.createElement('a');
  link.className = 'title';
  link.href = result.url;
  link.textContent = result.meta.title ?? result.url;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = [result.meta.host, result.meta.date]
    .filter(Boolean)
    .join(' · ');
  if (result.meta.issue) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = result.meta.issue.split(', ')[0];
    meta.append(' ', chip);
  }
  item.append(link, meta);
  // The excerpt repeats the title when the note is empty; leave it out then.
  const text = result.excerpt.replace(/<\/?mark>/g, '');
  if (text && decode(text) !== result.meta.title)
    item.append(excerpt(result.excerpt));
  return item;
}

export async function initSearch() {
  const root = document.querySelector<HTMLElement>('[data-search]');
  if (!root) return;
  const form = root.querySelector<HTMLFormElement>('[data-search-form]')!;
  const input = root.querySelector<HTMLInputElement>('[data-search-query]')!;
  const yearSelect =
    root.querySelector<HTMLSelectElement>('[data-search-year]')!;
  const wtBox = root.querySelector<HTMLInputElement>('[data-search-wt]')!;
  const noteBox = root.querySelector<HTMLInputElement>('[data-search-note]')!;
  const sortSelect =
    root.querySelector<HTMLSelectElement>('[data-search-sort]')!;
  const status = root.querySelector<HTMLElement>('[data-search-status]')!;
  const issueNumbers = new Set(
    JSON.parse(root.dataset.issues ?? '[]') as number[],
  );
  const list = root.querySelector<HTMLUListElement>('[data-search-results]')!;
  const more = root.querySelector<HTMLButtonElement>('[data-search-more]')!;

  const params = new URLSearchParams(location.search);
  input.value = params.get('q') ?? '';
  yearSelect.value = params.get('year') ?? '';
  wtBox.checked = params.get('wt') === 'yes';
  noteBox.checked = params.get('note') === 'yes';
  sortSelect.value = params.get('sort') ?? '';

  // Pagefind (about 300 kB before the first result) loads on the first
  // search with words, not with the page.
  let loading: Promise<Pagefind> | undefined;
  const pagefind = () =>
    (loading ??= (async () => {
      const module = (await import(/* @vite-ignore */ index)) as Pagefind;
      await module.options({ excerptLength: 26 });
      module.init();
      return module;
    })());

  let candidates: Match[] = [];
  let cursor = 0;
  let shown = 0;
  let run = 0;
  let dropped = 0;
  let query: Query = parse('');
  let exact: (data: Data) => boolean = () => true;
  // The host page offered with a site: query. Its address is taken from a
  // matching result's host, which the build wrote, never from the typed text.
  let siteHost: string | undefined;

  function link(href: string, text: string) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    return a;
  }

  // The count is Pagefind's until every candidate has been checked here.
  function describe() {
    const complete = cursor >= candidates.length;
    const n = complete ? shown : candidates.length;
    const { site, exclude } = query;
    status.textContent = n
      ? `${!complete && dropped ? 'Up to ' : ''}${n.toLocaleString('en-US')} ${n === 1 ? 'link' : 'links'}` +
        `${site ? ` from ${site}` : ''}${exclude.length ? ` without ${exclude.join(', ')}` : ''}.`
      : 'No links match.';
    if (siteHost)
      status.append(
        ' ',
        link(`/hosts/${siteHost}/`, `Every link from ${siteHost}`),
      );
  }

  // Reserve the next range before its data loads, so a second click while a
  // batch is loading takes the range after it.
  async function showMore(current: number) {
    more.disabled = true;
    let added = 0;
    while (added < page && cursor < candidates.length) {
      const batch = candidates.slice(cursor, cursor + page);
      cursor += batch.length;
      const data = await Promise.all(batch.map((match) => match.data()));
      if (current !== run) return;
      const keep = data.filter(exact);
      list.append(...keep.map(row));
      added += keep.length;
      shown += keep.length;
      dropped += batch.length - keep.length;
    }
    more.disabled = false;
    more.hidden = cursor >= candidates.length;
    describe();
  }

  async function update() {
    const current = ++run;
    candidates = [];
    cursor = 0;
    shown = 0;
    dropped = 0;
    siteHost = undefined;
    more.hidden = true;
    const typed = input.value.trim();
    query = parse(typed);
    const year = query.year ?? yearSelect.value;
    const next = new URLSearchParams();
    if (typed) next.set('q', typed);
    if (yearSelect.value) next.set('year', yearSelect.value);
    if (wtBox.checked) next.set('wt', 'yes');
    if (noteBox.checked) next.set('note', 'yes');
    if (sortSelect.value) next.set('sort', sortSelect.value);
    const address = next.toString();
    history.replaceState(null, '', address ? `?${address}` : location.pathname);

    const filters: Record<string, string> = {};
    if (year) filters.year = year;
    if (query.issue) filters.issue = query.issue;
    if (wtBox.checked) filters.wt = 'yes';
    if (noteBox.checked) filters.note = 'yes';
    const sort: Record<string, 'asc' | 'desc'> | undefined =
      sortSelect.value === 'new'
        ? { date: 'desc' }
        : sortSelect.value === 'old'
          ? { date: 'asc' }
          : undefined;
    // The host's words are searched too, so site: alone finds its links.
    const term = [query.text, query.site?.replace(/\./g, ' ')]
      .filter(Boolean)
      .join(' ');
    if (!term) {
      list.replaceChildren();
      // Page addresses are formed from numbers, so no typed text reaches an href.
      const issue = Number(query.issue);
      const yearPage = Number(year);
      const pages = [
        issueNumbers.has(issue) &&
          link(`/issues/${issue}/`, `Every link in WT${issue}`),
        yearPage > 0 &&
          link(`/years/${yearPage}/`, `Every link from ${yearPage}`),
      ].filter((a): a is HTMLAnchorElement => !!a);
      status.replaceChildren(
        pages.length
          ? 'Type a word to search within them.'
          : 'Type a word to search.',
      );
      for (const a of pages) status.append(' ', a);
      return;
    }
    let engine: Pagefind;
    try {
      if (!loading) status.textContent = 'Loading the search…';
      engine = await pagefind();
    } catch {
      loading = undefined;
      status.textContent =
        'Search could not load. Every link is also listed by year, issue and host.';
      return;
    }
    if (current !== run) return;
    const search = await engine.search(term, {
      filters,
      ...(sort ? { sort } : {}),
    });
    if (current !== run || !search) return;
    // Pagefind also matches metadata, loosely (the nnxyz lesson): a word can
    // match a date or an issue label. Keep matches in the text, the title or
    // the host.
    candidates = term
      ? search.results.filter(
          (result) =>
            result.words.length > 0 ||
            result.matchedMetaFields?.some(
              (f) => f === 'title' || f === 'host',
            ),
        )
      : search.results;
    const { site, exclude } = query;
    const starts = query.text
      .replace(/"[^"]*"/g, ' ')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3)
      .map(
        (word) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${word.slice(0, 3)}`, 'u'),
      );
    exact = (data) => {
      const host = data.meta.host;
      if (site && host === site) siteHost = host;
      const text =
        `${data.meta.title ?? ''} ${host ?? ''} ${data.content}`.toLowerCase();
      return (
        (!site || host === site || !!host?.endsWith(`.${site}`)) &&
        starts.every((start) => start.test(text)) &&
        !exclude.some((word) => text.includes(word))
      );
    };
    list.replaceChildren();
    await showMore(current);
  }

  let typing: ReturnType<typeof setTimeout>;
  input.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(update, 250);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    clearTimeout(typing);
    update();
  });
  for (const control of [yearSelect, wtBox, noteBox, sortSelect])
    control.addEventListener('change', update);
  more.addEventListener('click', () => showMore(run));

  // "/" focuses the box; the arrow keys walk the results.
  document.addEventListener('keydown', (event) => {
    const active = document.activeElement as HTMLElement | null;
    if (
      event.key === '/' &&
      active !== input &&
      !(active instanceof HTMLInputElement)
    ) {
      event.preventDefault();
      input.focus();
      input.select();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const links = [...list.querySelectorAll<HTMLAnchorElement>('a.title')];
    if (!links.length) return;
    const at = links.indexOf(active as HTMLAnchorElement);
    if (at === -1 && active !== input) return;
    event.preventDefault();
    const to =
      event.key === 'ArrowDown'
        ? Math.min(at + 1, links.length - 1)
        : at <= 0
          ? -1
          : at - 1;
    if (to === -1) input.focus();
    else links[to].focus();
  });

  await update();
  if (!input.value) input.focus();
}
