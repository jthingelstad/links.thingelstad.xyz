// /sky/ (docs/DIRECTION.md, "The sky"; Jamie, 2026-10-30: "Approved: build
// Sky into links.thingelstad.xyz, with a fixed star layout and Doors as the
// phone and no-WebGL view"). Loads the stars (/sky/stars.json, about 1.1 MB
// gzipped), keeps the walk (the star in view, the trail behind it, the
// stars visited), and shows it in one of two views: the sky (sky-gl.ts) on
// a wide screen with WebGL, Doors (sky-doors.ts) on a small one or without
// it, which a wide screen can also switch to. The address is the star:
// /sky/#<id>. Finding a link by its title and Surprise me work in both.
import { skyStarsPath } from '../lib/paths.ts';
import type { SkyData } from '../lib/sky.ts';
import { metaOf } from './sky-card.ts';
import { startDoors } from './sky-doors.ts';
import { type View, type Walk, startSky } from './sky-gl.ts';

export async function initSky() {
  const root = document.querySelector<HTMLElement>('[data-sky]');
  if (!root) return;
  const stage = root;
  stage.hidden = false;
  const fit = () =>
    stage.style.setProperty(
      '--sky-top',
      `${stage.getBoundingClientRect().top + window.scrollY}px`,
    );
  fit();
  const loading = stage.querySelector<HTMLElement>('.sky-loading')!;
  let sky: SkyData;
  try {
    const response = await fetch(skyStarsPath);
    if (!response.ok) throw new Error(`${response.status}`);
    sky = (await response.json()) as SkyData;
  } catch {
    loading.textContent =
      'The stars did not load. Reload the page to try again.';
    return;
  }
  const index = new Map(sky.ids.map((id, i) => [id, i]));
  let cur = -1;
  const trail: number[] = [];
  const visited = new Set<number>();
  const walk: Walk = {
    sky,
    current: () => cur,
    trail: () => trail,
    visited: () => visited,
    go,
  };

  const doors = startDoors(stage, walk);
  const sky3d = startSky(stage, walk);
  loading.remove();
  // The reader's own choice of view on a wide screen with WebGL.
  let chosen: 'sky' | 'doors' = 'sky';
  const small = () => stage.clientWidth <= 700 || window.innerHeight <= 500;
  const toggle = stage.querySelector<HTMLButtonElement>('[data-toggle-view]')!;
  let view: View | null = null;
  function use() {
    const next = !sky3d || small() || chosen === 'doors' ? doors : sky3d;
    toggle.hidden = !sky3d || small();
    toggle.textContent = next === sky3d ? 'Doors' : 'Sky';
    if (next === view) return;
    view?.pause();
    stage.dataset.view = next === sky3d ? 'sky' : 'doors';
    view = next;
    view.resume();
    if (cur >= 0) view.show(cur, false);
  }
  toggle.addEventListener('click', () => {
    chosen = view === sky3d ? 'doors' : 'sky';
    use();
  });

  function go(j: number) {
    if (j === cur || j < 0) return;
    if (cur >= 0) visited.add(cur);
    if (trail[trail.length - 1] === j) {
      // Already cut back to it (the path in Doors).
    } else if (trail.length > 1 && trail[trail.length - 2] === j) trail.pop();
    else trail.push(j);
    cur = j;
    visited.add(j);
    history.replaceState(null, '', `#${sky.ids[j]}`);
    view!.show(j, false);
  }

  // Find a link by the words of its title.
  const find = stage.querySelector<HTMLInputElement>('[data-find]')!;
  const results = stage.querySelector<HTMLUListElement>('[data-results]')!;
  const lower = sky.titles.map((title) => title.toLowerCase());
  let found: number[] = [];
  let chosenResult = -1;
  const close = () => {
    results.hidden = true;
    find.setAttribute('aria-expanded', 'false');
    find.removeAttribute('aria-activedescendant');
  };
  const mark = () => {
    results.querySelectorAll('[role="option"]').forEach((option, k) => {
      option.setAttribute('aria-selected', String(k === chosenResult));
      if (k === chosenResult)
        find.setAttribute('aria-activedescendant', option.id);
    });
  };
  function search() {
    const words = find.value.toLowerCase().split(/\s+/).filter(Boolean);
    found = [];
    if (words.length)
      for (let i = sky.ids.length - 1; i >= 0 && found.length < 8; i--)
        if (words.every((word) => lower[i].includes(word))) found.push(i);
    chosenResult = found.length ? 0 : -1;
    results.replaceChildren(
      ...found.map((i, k) => {
        const option = document.createElement('li');
        option.id = `sky-result-${k}`;
        option.setAttribute('role', 'option');
        option.append(sky.titles[i]);
        const small = document.createElement('small');
        small.textContent = metaOf(sky, i);
        option.append(small);
        option.addEventListener('pointerdown', (e) => e.preventDefault());
        option.addEventListener('click', () => pick(i));
        return option;
      }),
    );
    if (words.length && !found.length) {
      const none = document.createElement('li');
      none.className = 'none';
      none.textContent = 'No titles have all of those words.';
      results.append(none);
    }
    results.hidden = !words.length;
    find.setAttribute('aria-expanded', String(!results.hidden));
    mark();
  }
  function pick(i: number) {
    find.value = '';
    close();
    find.blur();
    go(i);
  }
  find.addEventListener('input', search);
  find.addEventListener('blur', close);
  find.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return close();
    if (!found.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      chosenResult =
        (chosenResult + (e.key === 'ArrowDown' ? 1 : found.length - 1)) %
        found.length;
      mark();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(found[Math.max(chosenResult, 0)]);
    }
  });

  // Surprise me: any star with a note.
  const noted = sky.note.flatMap((n, i) => (n ? [i] : []));
  stage
    .querySelector<HTMLButtonElement>('[data-surprise]')!
    .addEventListener('click', () =>
      go(noted[Math.floor(Math.random() * noted.length)]),
    );

  addEventListener('hashchange', () => {
    const i = index.get(location.hash.slice(1));
    if (i !== undefined) go(i);
  });
  let resizing = 0;
  addEventListener('resize', () => {
    clearTimeout(resizing);
    resizing = window.setTimeout(() => {
      fit();
      use();
      view!.resize();
    }, 120);
  });

  // The star in the address, else the newest link with a note.
  const start =
    index.get(location.hash.slice(1)) ?? noted[noted.length - 1] ?? 0;
  use();
  cur = start;
  trail.push(start);
  visited.add(start);
  view!.show(start, true);
}
