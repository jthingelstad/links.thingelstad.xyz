// Live results on the home page (Jamie, 2026-10-24: "Approved: build
// links.thingelstad.xyz search typeahead PR 2, live results on the home
// page"). The box suggests as on /search/ (suggest.ts), and once it holds a
// word of three letters or a site, and the word at the cursor is finished,
// the first five links that match come up under the suggestions, then a row
// for all of them on the search page. A result opens its record; Enter with
// nothing chosen searches on /search/, as the plain form did. Pagefind loads
// on the first such search, not with the page.
import {
  isCandidate,
  matcher,
  parse,
  searchTerm,
} from '../lib/search-grammar.ts';
import { type Data, filtersFor, pagefind } from './pagefind.ts';
import { type LinkRow, initSuggest } from './suggest.ts';

const shown = 5;
// A word Pagefind does not know shrinks to a prefix and brings up every
// link that has it, none of which pass the exact check (199 for xqzvjj).
// /search/ checks them all; as you type here, only the closest 25.
const checked = 25;

// Pagefind falls back to a prefix for a short word, so one or two letters
// find more noise than links.
const ready = (text: string, site?: string) =>
  !!site || text.split(/[^\p{L}\p{N}]+/u).some((word) => word.length >= 3);

const linkRow = (data: Data): LinkRow => ({
  href: data.url,
  title: data.meta.title ?? data.url,
  meta: [data.meta.host, data.meta.date].filter(Boolean).join(' · '),
});

export function initHome() {
  const form = document.querySelector<HTMLFormElement>('[data-home-search]');
  if (!form) return;
  const input = form.querySelector<HTMLInputElement>('input[name="q"]')!;
  const status = document.querySelector<HTMLElement>('[data-home-status]')!;
  let typing: ReturnType<typeof setTimeout> | undefined;
  let run = 0;
  const suggestions = initSuggest({
    input,
    list: form.querySelector<HTMLUListElement>('[data-search-suggest]')!,
    url: form.dataset.suggest!,
    taken: () => {
      clearTimeout(typing);
      live();
    },
  });

  // The count is Pagefind's until every candidate has been checked, as on
  // /search/: "Up to" once a candidate has been dropped.
  async function live() {
    const current = ++run;
    const query = parse(input.value.trim());
    if (!ready(query.text, query.site)) {
      suggestions.links(undefined);
      status.textContent = '';
      return;
    }
    // A half-typed operator holds the results where they are.
    if (!suggestions.settled()) return;
    let engine;
    try {
      engine = await pagefind();
    } catch {
      return suggestions.links(undefined);
    }
    if (current !== run) return;
    const search = await engine.search(searchTerm(query), {
      filters: filtersFor(query),
    });
    if (current !== run || !search) return;
    const candidates = search.results.filter(isCandidate);
    const exact = matcher(query);
    const found: Data[] = [];
    let cursor = 0;
    let dropped = 0;
    while (
      found.length < shown &&
      cursor < Math.min(candidates.length, checked)
    ) {
      const batch = candidates.slice(cursor, cursor + shown);
      cursor += batch.length;
      const data = await Promise.all(batch.map((match) => match.data()));
      if (current !== run) return;
      for (const one of data) {
        if (exact(one)) found.push(one);
        else dropped++;
      }
    }
    const complete = cursor >= candidates.length;
    const n = complete ? found.length : candidates.length;
    const count = `${n.toLocaleString('en-US')} ${n === 1 ? 'link' : 'links'}`;
    suggestions.links(
      found.length
        ? {
            rows: found.slice(0, shown).map(linkRow),
            all: `${!complete && dropped ? 'Up to' : 'All'} ${count}`,
          }
        : undefined,
    );
    status.textContent = found.length
      ? `${!complete && dropped ? 'Up to ' : ''}${count} ${n === 1 ? 'matches' : 'match'}.`
      : complete
        ? 'No links match.'
        : 'No close matches. Enter searches them all.';
  }

  input.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(live, 200);
  });
}
