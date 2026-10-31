// Doors at /sky/ (docs/DIRECTION.md, "The sky"): the view on a small screen
// or without WebGL, and one a wide screen can switch to. One link at a time
// as a page, its nearest in meaning as doors around it, each on the side
// where it lies on the Time map drawn flat behind; on a narrow screen the
// doors are a list under the page. The walk (sky.ts) is the same as the
// sky's, so switching keeps the star, the trail and the visited.
import { cut, distribute, reason } from '../lib/sky.ts';
import { element, renderCard } from './sky-card.ts';
import type { View, Walk } from './sky-gl.ts';

const TAU = Math.PI * 2;

export function startDoors(stage: HTMLElement, walk: Walk): View {
  const sky = walk.sky;
  const N = sky.ids.length;
  const root = stage.querySelector<HTMLElement>('.doors')!;
  const map = root.querySelector<HTMLCanvasElement>('.doors-map')!;
  const g = map.getContext('2d')!;
  const page = root.querySelector<HTMLElement>('.doors-page')!;
  // In the order distribute (lib/sky.ts) gives the sides.
  const sides = ['top', 'right', 'bottom', 'left'].map((side) =>
    root.querySelector<HTMLElement>(`.doors-side.${side}`)!,
  );
  const path = root.querySelector<HTMLElement>('.doors-path')!;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const narrow = () => root.clientWidth <= 900;
  const x = (i: number) => sky.time[2 * i];
  const y = (i: number) => sky.time[2 * i + 1];

  // The map behind: every star a dot, the doors' lines from the one in view.
  const view = { x: 0, y: 0, s: 1 };
  let W = 0;
  let H = 0;
  let pan = 0;
  const colors: Record<string, string> = {};
  const readColors = () => {
    const style = getComputedStyle(root);
    for (const name of ['ground', 'dot', 'link', 'visited'])
      colors[name] = style.getPropertyValue(`--${name}`).trim();
  };
  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = root.clientWidth;
    H = root.clientHeight;
    map.width = Math.round(W * dpr);
    map.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function draw() {
    // On a phone the map is not shown (sky.css).
    if (narrow()) return;
    const S = (Math.min(W, H) * 3.4 * view.s) / 200;
    const X = (i: number) => W / 2 + (x(i) - view.x) * S;
    const Y = (i: number) => H / 2 + (y(i) - view.y) * S;
    g.clearRect(0, 0, W, H);
    g.globalAlpha = 0.75;
    g.fillStyle = colors.dot;
    g.beginPath();
    for (let i = 0; i < N; i++) {
      const px = X(i);
      const py = Y(i);
      if (px < -3 || py < -3 || px > W + 3 || py > H + 3) continue;
      g.moveTo(px + 1.7, py);
      g.arc(px, py, 1.7, 0, TAU);
    }
    g.fill();
    const cur = walk.current();
    if (cur >= 0) {
      g.globalAlpha = 0.28;
      g.strokeStyle = colors.link;
      g.lineWidth = 1.2;
      for (const j of sky.neighbors[cur]) {
        g.beginPath();
        g.moveTo(X(cur), Y(cur));
        g.lineTo(X(j), Y(j));
        g.stroke();
      }
      const trail = walk.trail();
      if (trail.length > 1) {
        g.globalAlpha = 0.7;
        g.strokeStyle = colors.visited;
        g.lineWidth = 2;
        g.lineCap = 'round';
        g.setLineDash([0.5, 6]);
        g.beginPath();
        trail.forEach((i, n) =>
          n ? g.lineTo(X(i), Y(i)) : g.moveTo(X(i), Y(i)),
        );
        g.stroke();
        g.setLineDash([]);
      }
      g.globalAlpha = 0.85;
      for (const j of sky.neighbors[cur]) {
        g.beginPath();
        g.arc(X(j), Y(j), 3.2, 0, TAU);
        g.fillStyle = walk.visited().has(j) ? colors.visited : colors.link;
        g.fill();
      }
      // A clearing round the page, so the words sit on quiet ground.
      const r = page.getBoundingClientRect();
      const o = root.getBoundingClientRect();
      const px = r.left - o.left + r.width / 2;
      const py = r.top - o.top + r.height / 2;
      const R = Math.max(r.width, r.height) * 0.78;
      const clearing = g.createRadialGradient(px, py, 0, px, py, R);
      clearing.addColorStop(0, colors.ground);
      clearing.addColorStop(0.6, colors.ground);
      clearing.addColorStop(1, 'transparent');
      g.globalAlpha = 0.92;
      g.fillStyle = clearing;
      g.fillRect(0, 0, W, H);
    }
    g.globalAlpha = 1;
  }
  // The ground slides the way you walk; a long walk lifts you and sets you
  // down.
  function panTo(i: number, dur: number) {
    cancelAnimationFrame(pan);
    const from = { x: view.x, y: view.y };
    const to = { x: x(i), y: y(i) };
    const dist = Math.hypot(to.x - from.x, to.y - from.y) / 200;
    if (!dur) {
      Object.assign(view, to, { s: 1 });
      draw();
      return;
    }
    const t0 = performance.now();
    const tick = (now: number) => {
      const u = Math.min(1, (now - t0) / dur);
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      view.x = from.x + (to.x - from.x) * e;
      view.y = from.y + (to.y - from.y) * e;
      view.s = 1 - Math.min(0.7, dist * 2.4) * Math.sin(Math.PI * u);
      draw();
      if (u < 1) pan = requestAnimationFrame(tick);
    };
    pan = requestAnimationFrame(tick);
  }

  // The doors, each on the side where it lies (lib/sky.ts, distribute).
  function renderDoors(i: number) {
    const trail = walk.trail();
    const back = trail.length > 1 ? trail[trail.length - 2] : -1;
    const near = sky.neighbors[i];
    const items = near.map((j, q) => ({
      j,
      s: near.length > 1 ? 1 - q / (near.length - 1) : 1,
      angle: 0,
    }));
    if (back >= 0 && !near.includes(back))
      items.push({ j: back, s: 0.2, angle: 0 });
    for (const item of items)
      item.angle = Math.atan2(y(item.j) - y(i), x(item.j) - x(i));
    const make = (item: (typeof items)[number]) => {
      const j = item.j;
      const door = element('a', `door${walk.visited().has(j) ? ' seen' : ''}`);
      door.href = `#${sky.ids[j]}`;
      door.style.setProperty('--a', `${item.angle.toFixed(3)}rad`);
      door.style.setProperty('--s', item.s.toFixed(2));
      const year = new Date(sky.day[j] * 86_400_000).getUTCFullYear();
      const why = reason(sky, i, j);
      door.append(
        element('span', 'arr', '→'),
        ' ',
        element('span', 't', sky.titles[j]),
        element(
          'span',
          'm',
          j === back
            ? `You came from here · ${year}`
            : [year, cut(sky.hosts[sky.host[j]], 28), why]
                .filter(Boolean)
                .join(' · '),
        ),
      );
      door.addEventListener('click', (e) => {
        e.preventDefault();
        walk.go(j);
      });
      return door;
    };
    const runs = distribute(
      items,
      narrow() ? [items.length, 0, 0, 0] : [5, 3, 5, 3],
    );
    runs.forEach((run, k) => sides[k].replaceChildren(...run.map(make)));
  }

  function renderPath() {
    const trail = walk.trail();
    const cur = walk.current();
    const start = Math.max(0, trail.length - 6);
    path.replaceChildren(element('span', 'lab', 'Your path'));
    trail.slice(start).forEach((i, k) => {
      if (k) path.append(element('span', 'sep', '→'));
      if (i === cur)
        path.append(element('span', 'now', cut(sky.titles[i], 34)));
      else {
        const a = element('a', '', cut(sky.titles[i], 34));
        a.href = `#${sky.ids[i]}`;
        a.addEventListener('click', (e) => {
          e.preventDefault();
          trail.splice(start + k + 1);
          walk.go(i);
        });
        path.append(a);
      }
    });
    path.scrollLeft = path.scrollWidth;
  }

  function render(i: number) {
    const trail = walk.trail();
    const back = trail.length > 1 ? trail[trail.length - 2] : -1;
    renderCard(page, sky, i, back, () => walk.go(back));
    renderDoors(i);
    renderPath();
  }

  // Walking through a door: the page you leave drifts back the way you came,
  // the ground slides the way you go, and the new page arrives from there.
  let prev = -1;
  let busy: Promise<void> | null = null;
  async function show(i: number) {
    const from = prev;
    prev = i;
    const move = !reduced && from >= 0 && !busy;
    const a = from >= 0 ? Math.atan2(y(i) - y(from), x(i) - x(from)) : 0;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    panTo(i, move ? 1000 : 0);
    if (move) {
      busy = page
        .animate(
          [
            { transform: 'none', opacity: 1 },
            {
              transform: `translate(${-ux * 120}px, ${-uy * 80}px) scale(0.96)`,
              opacity: 0,
            },
          ],
          { duration: 300, easing: 'cubic-bezier(.55,0,.75,.2)' },
        )
        .finished.then(
          () => undefined,
          () => undefined,
        );
      await busy;
      busy = null;
    }
    if (prev !== i) return;
    render(i);
    // The stage grows with the page, and the map with it.
    size();
    // On a phone the doors are a list below the page: walking through one
    // brings the new page back up. Arriving does not move the reader.
    if (narrow() && from >= 0)
      root.scrollIntoView({
        block: 'start',
        behavior: reduced ? 'auto' : 'smooth',
      });
    if (move) {
      page.animate(
        [
          {
            transform: `translate(${ux * 120}px, ${uy * 80}px) scale(0.96)`,
            opacity: 0,
          },
          { transform: 'none', opacity: 1 },
        ],
        { duration: 460, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
      root.querySelectorAll('.door').forEach((door, k) =>
        door.animate(
          [
            {
              opacity: 0,
              transform: `translate(${-ux * 20}px, ${-uy * 20}px)`,
            },
            { opacity: 1, transform: 'none' },
          ],
          {
            duration: 380,
            delay: 140 + k * 35,
            easing: 'ease-out',
            fill: 'backwards',
          },
        ),
      );
    }
    draw();
  }

  const retheme = () => {
    readColors();
    draw();
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener(
    'change',
    retheme,
  );

  return {
    show: (i) => void show(i),
    resize() {
      size();
      if (walk.current() >= 0) renderDoors(walk.current());
      draw();
    },
    pause() {
      root.hidden = true;
      cancelAnimationFrame(pan);
    },
    resume() {
      root.hidden = false;
      readColors();
      size();
      prev = -1;
    },
    stopPlay() {},
  };
}
