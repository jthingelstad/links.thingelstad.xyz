// The search box's suggestion list on /search/ (src/lib/suggest.ts decides
// what it holds). The box is an ARIA combobox: the list opens under it for
// the word at the cursor, the arrow keys move through it, Enter or a click
// takes one, and Escape closes it. While it is closed the arrow keys walk
// the results as before (search.ts). An empty box shows the operators on a
// click or the down arrow, never on its own. A site's row carries small
// bars of its links by year. The list's data, /search/suggest.json, loads on
// the first keystroke.
import { tokenAt } from '../lib/search-grammar.ts';
import {
  type Scope,
  type SuggestData,
  type Suggestion,
  complete,
  settled,
  suggest,
} from '../lib/suggest.ts';

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
  let shown: Suggestion[] = [];
  let active = -1;
  // The list was asked for (a click or the down arrow in an empty box, or
  // an operator taken), so an empty word shows the operators.
  let asked = false;

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

  function render() {
    list.replaceChildren(
      ...shown.map((suggestion, i) => {
        const option = document.createElement('li');
        option.id = `search-suggest-${i}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(i === active));
        const insert = document.createElement('span');
        insert.className = 'suggest-insert';
        insert.textContent = suggestion.insert;
        const note = document.createElement('span');
        note.className = 'suggest-note';
        note.textContent = suggestion.note;
        option.append(insert, note);
        if (suggestion.years) option.append(bars(suggestion.years));
        return option;
      }),
    );
    if (active >= 0)
      input.setAttribute('aria-activedescendant', `search-suggest-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function refresh(ask = false) {
    asked = ask;
    load();
    const at = token();
    if (!data || document.activeElement !== input || !at || (!at.text && !ask))
      return close();
    shown = suggest(input.value, at, data, scope());
    if (!shown.length) return close();
    active = -1;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    render();
  }

  function take(i: number) {
    const at = token();
    const suggestion = shown[i];
    if (!at || !suggestion) return;
    const { value, caret } = complete(input.value, at, suggestion.insert);
    input.value = value;
    input.setSelectionRange(caret, caret);
    if (suggestion.insert.endsWith(':')) refresh(true);
    else {
      close();
      taken();
    }
  }

  input.addEventListener('input', () => refresh());
  input.addEventListener('click', () => refresh(!input.value.trim()));
  input.addEventListener('blur', close);
  // The cursor moved to another word.
  input.addEventListener('keyup', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
      refresh();
  });
  input.addEventListener('keydown', (event) => {
    if (list.hidden) {
      if (event.key === 'ArrowDown' && !input.value.trim()) {
        event.preventDefault();
        refresh(true);
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
      close();
    } else if (event.key === 'Enter') close();
  });
  // Keep the focus in the box when an option is pressed.
  list.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const option = (event.target as Element).closest('[role="option"]');
    if (option) take([...list.children].indexOf(option));
  });

  return {
    // Whether the word at the cursor is ready to search as it is typed.
    settled: () => settled(token(), data),
  };
}
