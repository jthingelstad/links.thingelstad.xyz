// The sky, on the front page and at /sky/ (docs/DIRECTION.md, "The sky";
// Jamie, 2026-10-30: "Approved: build Sky into links.thingelstad.xyz, with a
// fixed star layout and Doors as the phone and no-WebGL view", and
// 2026-10-31: "Approved: build Linking Things direction A in three phases").
// Loads the stars in two files, where they are (/sky/places.json, about
// 175 KB gzipped) and then their names (/sky/stars.json, about 930 KB), so
// the sky draws before the names arrive. Keeps the walk (the star in view or
// none, the trail behind it, the stars visited) and shows it in one of two
// views: the sky (sky-gl.ts) on a wide screen with WebGL, Doors
// (sky-doors.ts) on a small one or without it, which a wide screen can also
// switch to. Doors always has a star in view; the sky can stand back with
// none, over the whole sky, where its card says what the sky is.
//
// Find lights the stars whose titles or sites have the words as they are
// typed (findStars, lib/sky.ts), with the search box's suggestions and the
// best five under it; one opens on the sky, and a last row takes the words
// to the search page, which reads notes too.
//
// The address is what is on the screen: ?q= what Find holds, ?view=time the
// Time layout, #<id> the star in view.
import { linkPath, skyPlacesPath, skyStarsPath } from '../lib/paths.ts';
import { parse } from '../lib/search-grammar.ts';
import {
  type SkyData,
  type SkyNames,
  type SkyPlaces,
  findStars,
  foundWords,
} from '../lib/sky.ts';
import { element, metaOf } from './sky-card.ts';
import { startDoors } from './sky-doors.ts';
import { type SkyView, type View, type Walk, startSky } from './sky-gl.ts';
import { initSuggest } from './suggest.ts';

async function load<T>(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return (await response.json()) as T;
}

export async function initSky() {
  const root = document.querySelector<HTMLElement>('[data-sky]');
  if (!root) return;
  const stage = root;
  // The front page's plain door, for a reader without the script, gives way
  // to the sky, and comes back if the stars do not load.
  const plain = document.querySelector<HTMLElement>('[data-sky-plain]');
  stage.hidden = false;
  if (plain) plain.hidden = true;
  const fit = () =>
    stage.style.setProperty(
      '--sky-top',
      `${stage.getBoundingClientRect().top + window.scrollY}px`,
    );
  fit();
  const loading = stage.querySelector<HTMLElement>('.sky-loading')!;
  const failed = () => {
    if (plain) {
      plain.hidden = false;
      stage.hidden = true;
    } else
      loading.textContent =
        'The stars did not load. Reload the page to try again.';
  };
  const naming = load<SkyNames>(skyStarsPath);
  naming.catch(() => undefined);
  let places: SkyPlaces;
  try {
    places = await load<SkyPlaces>(skyPlacesPath);
  } catch {
    return failed();
  }
  const sky: SkyData = {
    ...places,
    ids: [],
    titles: [],
    hosts: [],
    host: [],
    kind: [],
    neighbors: [],
    issues: {},
  };
  const N = sky.topic.length;
  const params = new URLSearchParams(location.search);
  const home = stage.querySelector<HTMLElement>('.sky-home')!;
  const about = home.querySelector<HTMLElement>('[data-home-about]')!;
  const findCard = home.querySelector<HTMLElement>('[data-home-find]')!;
  const form = stage.querySelector<HTMLFormElement>('[data-find]')!;
  const input = form.querySelector<HTMLInputElement>('input[name="q"]')!;
  const list = form.querySelector<HTMLUListElement>('[data-results]')!;

  let index = new Map<string, number>();
  let cur = -1;
  const trail: number[] = [];
  const visited = new Set<number>();
  let query = '';
  let found: number[] | null = null;
  let arranged = params.get('view') === 'time' ? 'time' : 'meaning';
  const walk: Walk = {
    sky,
    current: () => cur,
    trail: () => trail,
    visited: () => visited,
    go,
    leave,
    query: () => (found ? query : ''),
  };

  const sky3d: SkyView | null = startSky(stage, walk);
  let doors: View | null = null;
  // The reader's own choice of view on a wide screen with WebGL.
  let chosen: 'sky' | 'doors' = 'sky';
  const small = () => stage.clientWidth <= 700 || window.innerHeight <= 500;
  const toggle = stage.querySelector<HTMLButtonElement>('[data-toggle-view]')!;
  let view: View | null = null;
  const noted = sky.note.flatMap((n, i) => (n ? [i] : []));
  function use(instant = false) {
    const next = !sky3d || small() || chosen === 'doors' ? doors : sky3d;
    toggle.hidden = !sky3d || !doors || small();
    toggle.textContent = next === sky3d ? 'Doors' : 'Sky';
    // Doors waits for the names.
    if (!next || next === view) return;
    view?.pause();
    stage.dataset.view = next === sky3d ? 'sky' : 'doors';
    view = next;
    view.resume();
    // Doors always has a star: the newest link with a note.
    if (view === doors && cur < 0) {
      cur = noted[noted.length - 1] ?? N - 1;
      trail.push(cur);
      visited.add(cur);
      address();
    }
    card();
    if (cur >= 0) view.show(cur, instant);
  }
  toggle.addEventListener('click', () => {
    chosen = view === sky3d ? 'doors' : 'sky';
    use();
  });
  if (sky3d && params.get('view') === 'time') sky3d.arrange('time', true);
  if (sky3d && !small()) {
    loading.remove();
    use();
  }

  function address() {
    const search = new URLSearchParams();
    if (found && query) search.set('q', query);
    if (arranged === 'time') search.set('view', 'time');
    const rest = search.toString();
    history.replaceState(
      null,
      '',
      `${location.pathname}${rest ? `?${rest}` : ''}${cur >= 0 ? `#${sky.ids[cur]}` : ''}`,
    );
  }

  // A star asked for before the names arrive (Surprise me) is where the sky
  // opens once they do.
  let wanted = -1;
  function go(j: number) {
    if (!sky.ids.length) {
      wanted = j;
      return;
    }
    if (j === cur || j < 0) return;
    if (cur >= 0) visited.add(cur);
    if (trail[trail.length - 1] === j) {
      // Already cut back to it (the path in Doors).
    } else if (trail.length > 1 && trail[trail.length - 2] === j) trail.pop();
    else trail.push(j);
    cur = j;
    visited.add(j);
    address();
    card();
    view!.show(j, false);
  }
  // Back out to the whole sky (the sky only; Doors always has a star).
  function leave() {
    if (cur < 0 || view !== sky3d) return;
    visited.add(cur);
    cur = -1;
    trail.length = 0;
    address();
    card();
    sky3d!.whole();
  }

  // The whole sky's card: what the sky is, or what Find lit.
  function card() {
    home.hidden = cur >= 0;
    about.hidden = !!found;
    findCard.hidden = !found;
    if (!found) return findCard.replaceChildren();
    const all = element('a', '', 'Search the notes too');
    all.href = searchHref();
    const clear = element('button', 'sky-out', 'Clear');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      input.value = '';
      run(true);
      input.focus();
    });
    const foot = element('p', 'sky-card-foot');
    foot.append(all, clear);
    findCard.replaceChildren(
      element('p', 'sky-card-topic', 'Find'),
      element('h2', 'sky-home-title', query),
      element('p', 'sky-home-lede', foundWords(sky, found)),
      foot,
    );
  }

  // Find.
  const searchHref = () =>
    `${form.getAttribute('action')}?q=${encodeURIComponent(input.value.trim())}`;
  const starOf = (href: string) => {
    const match = /^\/links\/([0-9a-f]{12})\/$/.exec(
      new URL(href, location.href).pathname,
    );
    return match ? index.get(match[1]) : undefined;
  };
  const suggestions = initSuggest({
    input,
    list,
    url: form.dataset.suggest!,
    taken: () => {
      clearTimeout(typing);
      run(true);
    },
    open(href) {
      const i = starOf(href);
      if (i === undefined) return false;
      stopAndGo(i);
      return true;
    },
  });
  const stopAndGo = (i: number) => {
    view?.stopPlay();
    input.blur();
    go(i);
  };
  // What the words light: the stars, the card, the address, and the best
  // five under the box. Enter (`sure`) takes the words as they stand.
  function run(frame: boolean, sure = false) {
    if (!sky.ids.length) return;
    const text = input.value.trim();
    const next = findStars(sky, parse(text));
    // A half-typed operator (site:kot) holds what is lit while typing.
    if (next && !sure && !suggestions.settled()) return;
    found = next;
    query = next ? text : '';
    sky3d?.light(found, frame);
    suggestions.links(
      found
        ? {
            rows: found.slice(0, 5).map((i) => ({
              href: linkPath(sky.ids[i]),
              title: sky.titles[i],
              meta: metaOf(sky, i),
            })),
            all: `Search the notes for “${text}”`,
            href: searchHref(),
            note: '',
          }
        : undefined,
    );
    if (cur < 0 || view !== sky3d) card();
    address();
  }
  let typing: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => run(true), 160);
  });
  // Enter with nothing chosen stays on the sky: it takes in what is lit, or
  // in Doors goes to the best of it.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    clearTimeout(typing);
    run(true, true);
    if (view === doors && found?.length) stopAndGo(found[0]);
  });

  // Meaning and Time (sky-gl.ts arranges them), in the address.
  for (const button of stage.querySelectorAll<HTMLButtonElement>(
    '[data-layout]',
  ))
    button.addEventListener('click', () => {
      arranged = button.dataset.layout === 'time' ? 'time' : 'meaning';
      address();
    });

  // Surprise me: any star with a note.
  for (const button of stage.querySelectorAll<HTMLButtonElement>(
    '[data-surprise]',
  ))
    button.addEventListener('click', () => {
      view?.stopPlay();
      go(noted[Math.floor(Math.random() * noted.length)]);
    });

  let resizing = 0;
  addEventListener('resize', () => {
    clearTimeout(resizing);
    resizing = window.setTimeout(() => {
      fit();
      use();
      view?.resize();
    }, 120);
  });

  // The names.
  let names: SkyNames;
  try {
    names = await naming;
  } catch {
    return failed();
  }
  if (names.layout !== places.layout || names.ids.length !== N) return failed();
  Object.assign(sky, names);
  index = new Map(sky.ids.map((id, i) => [id, i]));
  doors = startDoors(stage, walk);
  loading.remove();
  addEventListener('hashchange', () => {
    const i = index.get(location.hash.slice(1));
    if (i !== undefined) go(i);
  });

  // The star in the address, or one asked for while the names loaded; else
  // at /sky/ the newest link with a note, and on the front page the whole
  // sky (Doors takes the newest).
  const asked = index.get(location.hash.slice(1));
  const start =
    asked ??
    (wanted >= 0
      ? wanted
      : stage.dataset.start === 'whole'
        ? -1
        : noted[noted.length - 1]);
  if (start >= 0) {
    cur = start;
    trail.push(start);
    visited.add(start);
  }
  if (params.get('q') && !input.value) input.value = params.get('q')!;
  if (input.value.trim()) run(start < 0);
  // The sky is already up on a wide screen, and shows the star itself; Doors
  // starts now, on it.
  // (TypeScript cannot see use() set the view, hence the casts.)
  const was = view as View | null;
  use(true);
  const now = view as View | null;
  if (now && now === was && cur >= 0) now.show(cur, true);
  address();
  card();
}
