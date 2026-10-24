// Search on /search/. Pagefind's index is loaded by pagefind.ts, which the
// home page's live results share. The query and the options are kept in the
// address so a search can be shared.
//
// The grammar (site:, year:, wt:, kind:, "phrases", -word), the term sent to
// Pagefind and the exact check on each result live in
// src/lib/search-grammar.ts, which the MCP server's links_search shares.
// The box suggests sites, years, issues and kinds as an operator is typed
// (src/scripts/suggest.ts), and a half-typed operator waits for its value
// before the results follow it.
//
// A search with no words loads the whole index (143 chunks, 3.8 MB, found at
// 16,524 records), so a year, an issue or a kind alone links to its page,
// which lists exactly those links.
//
// On a wide screen the result moved to shows beside the list (preview.ts,
// loaded then and only then).
import { kindWords, kinds } from '../lib/kinds.ts';
import {
  type Query,
  isCandidate,
  matcher,
  parse,
  searchTerm,
} from '../lib/search-grammar.ts';
import {
  type Data,
  type Match,
  type Pagefind,
  filtersFor,
  pagefind,
  pagefindStarted,
} from './pagefind.ts';
import { initSuggest } from './suggest.ts';

const page = 20;

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

// The search's data for each result row, for the preview pane.
const rows = new WeakMap<Element, Data>();

function row(result: Data) {
  const item = document.createElement('li');
  rows.set(item, result);
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
  const pane = root.querySelector<HTMLElement>('[data-search-preview]')!;
  // The width the pane has room at (global.css).
  const wide = matchMedia('(min-width: 60rem)');
  let typing: ReturnType<typeof setTimeout> | undefined;
  const suggestions = initSuggest({
    input,
    list: root.querySelector<HTMLUListElement>('[data-search-suggest]')!,
    url: root.dataset.suggest!,
    taken: () => {
      clearTimeout(typing);
      update();
    },
    scope: () => ({
      year: yearSelect.value,
      narrowed: wtBox.checked || noteBox.checked,
    }),
  });

  const params = new URLSearchParams(location.search);
  input.value = params.get('q') ?? '';
  yearSelect.value = params.get('year') ?? '';
  wtBox.checked = params.get('wt') === 'yes';
  noteBox.checked = params.get('note') === 'yes';
  sortSelect.value = params.get('sort') ?? '';

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

  // The result in the pane, and a count so a slow twin does not replace a
  // later one.
  let previewed: Element | undefined;
  let previews = 0;
  async function preview(item: Element | null | undefined) {
    // A row the list no longer holds (a hover that rested as the results
    // were replaced) is not shown.
    if (!wide.matches || !item || item === previewed || !list.contains(item))
      return;
    const data = rows.get(item);
    if (!data) return;
    previewed?.classList.remove('previewing');
    previewed = item;
    item.classList.add('previewing');
    const current = ++previews;
    let module: typeof import('./preview.ts');
    try {
      module = await import('./preview.ts');
    } catch {
      return;
    }
    if (current === previews)
      await module.showPreview(pane, data, () => current === previews);
  }
  function clearPreview() {
    previews++;
    previewed?.classList.remove('previewing');
    previewed = undefined;
    pane.hidden = true;
    pane.replaceChildren();
  }

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
    const { site, kind, exclude } = query;
    status.textContent = n
      ? `${!complete && dropped ? 'Up to ' : ''}${n.toLocaleString('en-US')} ${n === 1 ? 'link' : 'links'}` +
        `${kind ? ` of the kind ${kindWords[kind].name.toLowerCase()}` : ''}` +
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
    if (!previewed) preview(list.firstElementChild);
  }

  async function update() {
    const current = ++run;
    candidates = [];
    cursor = 0;
    shown = 0;
    dropped = 0;
    siteHost = undefined;
    more.hidden = true;
    clearPreview();
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

    const filters = filtersFor(query, {
      year: yearSelect.value,
      wt: wtBox.checked,
      note: noteBox.checked,
    });
    const sort: Record<string, 'asc' | 'desc'> | undefined =
      sortSelect.value === 'new'
        ? { date: 'desc' }
        : sortSelect.value === 'old'
          ? { date: 'asc' }
          : undefined;
    const term = searchTerm(query);
    if (!term) {
      list.replaceChildren();
      // Page addresses are formed from numbers and from the kinds list, so no
      // typed text reaches an href.
      const issue = Number(query.issue);
      const yearPage = Number(year);
      const kindPage = query.kind && kinds[kinds.indexOf(query.kind)];
      const pages = [
        issueNumbers.has(issue) &&
          link(`/issues/${issue}/`, `Every link in WT${issue}`),
        yearPage > 0 &&
          link(`/years/${yearPage}/`, `Every link from ${yearPage}`),
        kindPage &&
          link(
            `/kinds/${kindPage}/`,
            `All ${kindWords[kindPage].title.toLowerCase()}`,
          ),
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
      if (!pagefindStarted()) status.textContent = 'Loading the search…';
      engine = await pagefind();
    } catch {
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
    candidates = term ? search.results.filter(isCandidate) : search.results;
    const { site } = query;
    const matches = matcher(query);
    exact = (data) => {
      if (site && data.meta.host === site) siteHost = data.meta.host;
      return matches(data);
    };
    list.replaceChildren();
    // A result moved to while this search loaded belonged to the last one.
    clearPreview();
    await showMore(current);
  }

  input.addEventListener('input', () => {
    clearTimeout(typing);
    if (suggestions.settled()) typing = setTimeout(update, 250);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    clearTimeout(typing);
    update();
  });
  for (const control of [yearSelect, wtBox, noteBox, sortSelect])
    control.addEventListener('change', update);
  more.addEventListener('click', () => showMore(run));

  // The pane follows the arrow keys and a pointer that rests on a result.
  list.addEventListener('focusin', (event) =>
    preview((event.target as Element).closest('li')),
  );
  let resting: ReturnType<typeof setTimeout> | undefined;
  list.addEventListener('pointerover', (event) => {
    if (event.pointerType !== 'mouse') return;
    clearTimeout(resting);
    const item = (event.target as Element).closest('li');
    resting = setTimeout(() => preview(item), 120);
  });
  list.addEventListener('pointerleave', () => clearTimeout(resting));
  wide.addEventListener('change', () => {
    if (wide.matches && !previewed) preview(list.firstElementChild);
  });

  // "/" focuses the box; the arrow keys walk the results, unless the
  // suggestion list has taken them.
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
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
