// The search box's suggestion list, on /search/ and the home page
// (src/lib/suggest.ts decides what it holds). The box is an ARIA combobox:
// the list opens under it for the word at the cursor, the arrow keys move
// through it, Enter or a click takes one, and Escape closes it. While it is
// closed the arrow keys walk the results on /search/ as before (search.ts).
// An empty box shows the operators on a click or the down arrow, never on
// its own. A site's row carries small bars of its links by year. The list's
// data, /search/suggest.json, loads on the first keystroke.
//
// The home page adds live results (home.ts): up to five links after the
// suggestions, each a link to its record, then a row for all of them on the
// search page, which submits the form.
import { tokenAt } from '../lib/search-grammar.ts';
import {
  type Scope,
  type SuggestData,
  type Suggestion,
  complete,
  settled,
  suggest,
} from '../lib/suggest.ts';

// The home page's live results: each a record's page, its title and where
// it is from, then a row for all of them ("All 12 links").
export interface LinkRow {
  href: string;
  title: string;
  meta: string;
}
export interface Links {
  rows: LinkRow[];
  all: string;
}
type Option = { suggestion: Suggestion } | { link: LinkRow } | { all: string };
const keyOf = (option?: Option) =>
  !option
    ? undefined
    : 'suggestion' in option
      ? `suggestion ${option.suggestion.insert}`
      : 'link' in option
        ? `link ${option.link.href}`
        : 'all';

// A site's links by year, the year counted marked: aria-hidden bars, with
// the same in words for a screen reader.
function bars(years: NonNullable<Suggestion['years']>) {
  const box = document.createElement('span');
  box.className = 'suggest-years';
  const drawn = document.createElement('span');
  drawn.className = 'suggest-bars';
  drawn.setAttribute('aria-hidden', 'true');
  const peak = Math.max(1, ...years.counts);
  drawn.append(
    ...years.counts.map((n, i) => {
      const bar = document.createElement('span');
      bar.className = `bar${n ? '' : ' zero'}${i === years.on ? ' on' : ''}`;
      bar.style.height = `${n ? Math.max(2, Math.round((n / peak) * 16)) : 1}px`;
      return bar;
    }),
  );
  const words = document.createElement('span');
  words.className = 'sr-only';
  words.textContent = `, ${years.label}`;
  box.append(drawn, words);
  return box;
}

export function initSuggest(options: {
  input: HTMLInputElement;
  list: HTMLUListElement;
  url: string;
  // A suggestion was taken that completes a word: search now.
  taken: () => void;
  // What else on the page narrows the search, for the counts.
  scope?: () => Scope;
}) {
  const { input, list, url, taken, scope = () => ({}) } = options;
  let data: SuggestData | undefined;
  let loading: Promise<void> | undefined;
  let suggestions: Suggestion[] = [];
  let links: Links | undefined;
  let shown: Option[] = [];
  let active = -1;
  // The list was asked for (a click or the down arrow in an empty box, or
  // an operator taken), so an empty word shows the operators.
  let asked = false;
  // Escape closed the list: live results that arrive after it stay closed
  // until the next keystroke.
  let dismissed = false;

  const token = () =>
    tokenAt(input.value, input.selectionStart ?? input.value.length);

  // Without the file there are no suggestions; the search works without them.
  const load = () =>
    (loading ??= fetch(url)
      .then((response) =>
        response.ok ? (response.json() as Promise<SuggestData>) : undefined,
      )
      .then(
        (found) => {
          data = found;
          refresh(asked);
        },
        () => undefined,
      ));

  function close() {
    shown = [];
    active = -1;
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function row(option: Option, i: number) {
    const item = document.createElement('li');
    item.id = `${list.id}-${i}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(i === active));
    const note = document.createElement('span');
    note.className = 'suggest-note';
    if ('suggestion' in option) {
      const insert = document.createElement('span');
      insert.className = 'suggest-insert';
      insert.textContent = option.suggestion.insert;
      note.textContent = option.suggestion.note;
      item.append(insert, note);
      if (option.suggestion.years) item.append(bars(option.suggestion.years));
    } else if ('link' in option) {
      // A real link, so it can open in a new tab; Enter follows it too.
      item.className = 'suggest-link';
      const title = document.createElement('a');
      title.className = 'suggest-title';
      title.href = option.link.href;
      title.tabIndex = -1;
      title.textContent = option.link.title;
      note.textContent = option.link.meta;
      item.append(title, note);
    } else {
      item.className = 'suggest-all';
      const all = document.createElement('span');
      all.className = 'suggest-insert';
      all.textContent = option.all;
      note.textContent = 'on the search page';
      item.append(all, note);
    }
    return item;
  }

  function render() {
    list.replaceChildren(...shown.map(row));
    if (active >= 0)
      input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  // Shows what there is: the suggestions, then the live results. When the
  // results change under the list, the option chosen stays chosen.
  function show(keep = false) {
    const chosen = keep ? keyOf(shown[active]) : undefined;
    if (document.activeElement !== input || dismissed) return close();
    shown = [
      ...suggestions.map((suggestion) => ({ suggestion })),
      ...(links?.rows.length
        ? [...links.rows.map((link) => ({ link })), { all: links.all }]
        : []),
    ];
    if (!shown.length) return close();
    active = chosen
      ? shown.findIndex((option) => keyOf(option) === chosen)
      : -1;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    render();
  }

  function refresh(ask = false) {
    asked = ask;
    load();
    const at = token();
    suggestions =
      data && at && (at.text || ask)
        ? suggest(input.value, at, data, scope())
        : [];
    show();
  }

  function take(i: number) {
    const option = shown[i];
    if (!option) return;
    if ('link' in option) return location.assign(option.link.href);
    if ('all' in option) return input.form?.requestSubmit();
    const at = token();
    if (!at) return;
    const { value, caret } = complete(
      input.value,
      at,
      option.suggestion.insert,
    );
    input.value = value;
    input.setSelectionRange(caret, caret);
    if (option.suggestion.insert.endsWith(':')) refresh(true);
    else {
      close();
      taken();
    }
  }

  input.addEventListener('input', () => {
    dismissed = false;
    refresh();
  });
  input.addEventListener('click', () => {
    dismissed = false;
    refresh(!input.value.trim());
  });
  input.addEventListener('blur', close);
  // The cursor moved to another word.
  input.addEventListener('keyup', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
      refresh();
  });
  input.addEventListener('keydown', (event) => {
    if (list.hidden) {
      if (event.key === 'ArrowDown' && (!input.value.trim() || links)) {
        event.preventDefault();
        dismissed = false;
        refresh(!input.value.trim());
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const last = shown.length - 1;
      active =
        event.key === 'ArrowDown'
          ? active >= last
            ? -1
            : active + 1
          : active < 0
            ? last
            : active - 1;
      render();
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      take(active);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      dismissed = true;
      close();
    } else if (event.key === 'Enter') close();
  });
  // Keep the focus in the box when an option is pressed.
  list.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const target = event.target as Element;
    // A result's own link follows itself (and opens a new tab when asked).
    if (target.closest('a')) return;
    const option = target.closest('[role="option"]');
    if (option) take([...list.children].indexOf(option));
  });

  return {
    // Whether the word at the cursor is ready to search as it is typed.
    settled: () => settled(token(), data),
    // The live results under the suggestions, or none.
    links: (next: Links | undefined) => {
      links = next;
      show(true);
    },
  };
}
