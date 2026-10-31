// The sky itself at /sky/ (docs/DIRECTION.md, "The sky"): every link a star,
// drawn with WebGL directly. Two layouts, Meaning (three dimensions of what
// the links say) and Time (meaning across, the day saved as depth), with the
// stars flying between them a year at a time; the ten nearest of the star in
// view as lines and named doors; topic names where each is densest; the
// titles of the stars nearest the camera as it closes in; and Play, which
// flies the sky by itself. sky.ts owns the walk (the star in view, the
// trail, the visited) and gives this view the star to show.
import {
  type Mat4,
  type Projected,
  type SkyData,
  type Vec3,
  cut,
  depthOf,
  lookAt,
  multiply,
  nextStop,
  nextTopic,
  perspective,
  project,
  reason,
  shift,
  staggered,
  yearOf,
} from '../lib/sky.ts';
import { element, renderCard } from './sky-card.ts';

export interface Walk {
  sky: SkyData;
  current: () => number;
  trail: () => number[];
  visited: () => ReadonlySet<number>;
  go: (star: number) => void;
}

export interface View {
  show: (star: number, arrive: boolean) => void;
  resize: () => void;
  pause: () => void;
  resume: () => void;
  stopPlay: () => void;
}

const VERTEX = `
attribute vec3 aMeaning;
attribute vec3 aTime;
attribute float aDelay;
attribute vec3 aColor;
attribute vec3 aSize;
uniform mat4 uView, uProj;
uniform float uMix, uScale, uDpr, uMax, uNear, uFar;
// The fragment shader reads it too, so both must give it one precision.
uniform mediump float uGlow;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float t = clamp(uMix * 1.6 - aDelay * 0.6, 0.0, 1.0);
  vec3 p = mix(aMeaning, aTime, t * t * (3.0 - 2.0 * t));
  vec4 mv = uView * vec4(p, 1.0);
  float d = max(-mv.z, 0.001);
  float px = aSize.x * uScale / d, minPx = aSize.y * uDpr;
  float a;
  if (uGlow > 0.5) {
    a = clamp((d - aSize.x * 0.4) / aSize.x, 0.0, 1.0);
  } else {
    a = (1.0 - smoothstep(uNear, uFar, d)) * smoothstep(0.3, 2.5, d);
    a *= mix(clamp(px / minPx, 0.7, 1.0), 1.0, aSize.z);
    a = max(a, aSize.z * 0.9);
  }
  vAlpha = a;
  vColor = aColor;
  gl_PointSize = min(max(px, minPx), uMax);
  gl_Position = uProj * mv;
}`;
const FRAGMENT = `
precision mediump float;
uniform float uGlow;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float s = uGlow > 0.5
    ? (1.0 - r) * (1.0 - r) * 0.07
    : smoothstep(0.5, 0.0, r) + (1.0 - r) * (1.0 - r) * 0.4;
  gl_FragColor = vec4(vColor, s * vAlpha);
}`;

// The stars' own light, and the colours of what the walk marks: the star in
// view, its neighbours, and those already visited.
const HERE: Vec3 = [1, 0.81, 0.48];
const LINK: Vec3 = [0.62, 0.71, 1];
const SEEN: Vec3 = [0.82, 0.69, 1];
// The glow under each topic, by family.
const GLOWS = [
  '#5d7bff',
  '#b07cff',
  '#4fb8c9',
  '#7f9dff',
  '#9b6bff',
  '#46a6ff',
  '#c58cff',
  '#5fc4b0',
];
const FOV = (55 * Math.PI) / 180;
const WHOLE = 175;
const NEAR_LABELS = 14;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const ease = (u: number) =>
  u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
const hex = (h: string): Vec3 =>
  [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255) as Vec3;

function compile(gl: WebGLRenderingContext) {
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
    return s;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? 'program');
  return program;
}

export function startSky(stage: HTMLElement, walk: Walk): View | null {
  const canvas = stage.querySelector<HTMLCanvasElement>('.sky-gl')!;
  const gl = canvas.getContext('webgl', { alpha: true, antialias: false });
  if (!gl) return null;
  let program: WebGLProgram;
  try {
    program = compile(gl);
  } catch (error) {
    console.warn(
      'The sky has no WebGL program, so Doors shows instead.',
      error,
    );
    return null;
  }
  const sky = walk.sky;
  const N = sky.ids.length;
  const T = sky.topics.length;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = <E extends Element>(selector: string) =>
    stage.querySelector<E>(selector)!;
  const fx = $<HTMLCanvasElement>('.sky-fx');
  const fxg = fx.getContext('2d')!;
  const box = $<HTMLElement>('.sky-labels');
  const ring = $<HTMLElement>('.sky-ring');
  const tip = $<HTMLElement>('.sky-tip');
  const card = $<HTMLElement>('.sky-card');
  const bar = $<HTMLElement>('.sky-bar');
  const playButton = $<HTMLButtonElement>('[data-play]');

  // Places. Time's depth is the day saved, the middle of the years at 0;
  // each star sets off for the other layout at its own moment in time.
  const years = sky.day.map(yearOf);
  const first = Math.min(...years);
  const last = Math.max(...years);
  const middle = (first + last) / 2;
  const meaning = new Float32Array(sky.meaning);
  const time = new Float32Array(N * 3);
  const delay = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    time[3 * i] = sky.time[2 * i];
    time[3 * i + 1] = sky.time[2 * i + 1];
    time[3 * i + 2] = depthOf(years[i], middle);
    delay[i] = (years[i] - first) / (last - first || 1);
  }
  const topicDelay = sky.topics.map(
    (t) => ((t.time[2] + t.time[3]) / 2 - first) / (last - first || 1),
  );
  let mix = 0;
  const posOf = (i: number, out: Vec3 = [0, 0, 0]): Vec3 => {
    const t = staggered(mix, delay[i]);
    for (let k = 0; k < 3; k++)
      out[k] = meaning[3 * i + k] + (time[3 * i + k] - meaning[3 * i + k]) * t;
    return out;
  };
  // A topic's name: where it is densest in Meaning; across Time, riding its
  // tube at the depth the camera looks at, within the years most of it spans.
  const topicPos = (k: number, out: Vec3 = [0, 0, 0]): Vec3 => {
    const t = staggered(mix, topicDelay[k]);
    const topic = sky.topics[k];
    const z = clamp(
      target[2],
      depthOf(topic.time[2], middle),
      depthOf(topic.time[3], middle),
    );
    const to: Vec3 = [topic.time[0], topic.time[1], z];
    for (let n = 0; n < 3; n++)
      out[n] = topic.meaning[n] + (to[n] - topic.meaning[n]) * t;
    return out;
  };

  // Buffers: the places once, the light on each move.
  let seed = 7;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const baseColor = new Float32Array(N * 3);
  const baseSize = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const warm = random();
    const b =
      (0.55 + 0.45 * Math.pow(random(), 1.4)) * (sky.note[i] ? 1 : 0.65);
    baseColor.set(
      [
        b * (0.78 + 0.22 * warm),
        b * (0.85 + 0.05 * warm),
        b * (1 - 0.22 * warm),
      ],
      3 * i,
    );
    baseSize.set([0.1, 1.8, 0], 3 * i);
  }
  const color = baseColor.slice();
  const size = baseSize.slice();
  const buffer = (data: Float32Array, usage: GLenum = gl.STATIC_DRAW) => {
    const b = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    return b;
  };
  const stars = {
    meaning: buffer(meaning),
    time: buffer(time),
    delay: buffer(delay),
    color: buffer(color, gl.DYNAMIC_DRAW),
    size: buffer(size, gl.DYNAMIC_DRAW),
  };
  const glow = {
    meaning: buffer(new Float32Array(sky.topics.flatMap((t) => t.meaning))),
    time: buffer(
      new Float32Array(
        sky.topics.flatMap((t) => [
          t.time[0],
          t.time[1],
          depthOf((t.time[2] + t.time[3]) / 2, middle),
        ]),
      ),
    ),
    delay: buffer(new Float32Array(topicDelay)),
    color: buffer(
      new Float32Array(
        sky.topics.flatMap((t) => hex(GLOWS[t.family % GLOWS.length])),
      ),
    ),
    size: buffer(
      new Float32Array(
        sky.topics.flatMap((t) => [10 + Math.sqrt(t.size) * 1.4, 0, 0]),
      ),
    ),
  };
  const attribute = (name: string) => gl.getAttribLocation(program, name);
  const at = {
    meaning: attribute('aMeaning'),
    time: attribute('aTime'),
    delay: attribute('aDelay'),
    color: attribute('aColor'),
    size: attribute('aSize'),
  };
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  const u = {
    view: uniform('uView'),
    proj: uniform('uProj'),
    mix: uniform('uMix'),
    scale: uniform('uScale'),
    dpr: uniform('uDpr'),
    max: uniform('uMax'),
    near: uniform('uNear'),
    far: uniform('uFar'),
    glow: uniform('uGlow'),
  };
  const pointRange = gl.getParameter(
    gl.ALIASED_POINT_SIZE_RANGE,
  ) as Float32Array;
  const maxPoint = pointRange?.[1] || 64;
  gl.useProgram(program);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  // Light adds up; the canvas stays premultiplied over the night behind it.
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE);
  gl.clearColor(0, 0, 0, 0);
  const bind = (set: typeof stars) => {
    for (const key of ['meaning', 'time', 'delay', 'color', 'size'] as const) {
      gl.bindBuffer(gl.ARRAY_BUFFER, set[key]);
      gl.enableVertexAttribArray(at[key]);
      gl.vertexAttribPointer(
        at[key],
        key === 'delay' ? 1 : 3,
        gl.FLOAT,
        false,
        0,
        0,
      );
    }
  };

  function paint() {
    color.set(baseColor);
    size.set(baseSize);
    const lit = (j: number, c: Vec3, world: number, min: number) => {
      color.set(c, 3 * j);
      size.set([world, min, 1], 3 * j);
    };
    const cur = walk.current();
    for (const j of walk.visited()) lit(j, SEEN, 0.14, 4.5);
    for (const j of sky.neighbors[cur])
      lit(j, walk.visited().has(j) ? SEEN : LINK, 0.2, 7.5);
    lit(cur, HERE, 0.3, 11);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, stars.color);
    gl!.bufferSubData(gl!.ARRAY_BUFFER, 0, color);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, stars.size);
    gl!.bufferSubData(gl!.ARRAY_BUFFER, 0, size);
  }

  // The camera turns about `target`, `r` away. The point it looks at shows
  // at the anchor, clear of the card and the toolbar.
  const target: Vec3 = [0, 0, 0];
  const sph = { r: WHOLE + 40, th: 0.7, ph: 1.15 };
  let W = 0;
  let H = 0;
  let dpr = 1;
  let ax = 0;
  let ay = 0;
  let vp: Mat4 = new Float32Array(16);
  let eye: Vec3 = [0, 0, 0];
  let projection: Mat4 = new Float32Array(16);
  let dirty = true;
  let dragging = false;
  let idleUntil = 0;
  let follow = -1;
  interface Flight {
    from: Vec3;
    to: () => Vec3;
    r0: number;
    r1: number;
    lift: number;
    swirl: number;
    e: number;
    t0: number;
    dur: number;
    done?: () => void;
  }
  let fly: Flight | null = null;
  interface Morph {
    from: number;
    to: number;
    t0: number;
    dur: number;
    th?: [number, number];
    ph?: [number, number];
  }
  let morph: Morph | null = null;

  function anchor(): [number, number] {
    const top = bar.offsetTop + bar.offsetHeight;
    return [W * 0.6, top + (H - top) * 0.42];
  }
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = stage.clientWidth;
    H = stage.clientHeight;
    if (!W || !H) return;
    for (const c of [canvas, fx]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    fxg.setTransform(dpr, 0, 0, dpr, 0, 0);
    gl!.viewport(0, 0, canvas.width, canvas.height);
    [ax, ay] = anchor();
    projection = shift(perspective(FOV, W / H, 0.1, 3000), ax, ay, W, H);
    obstacles = measure();
    for (const node of topicNodes) {
      node.dataset.w = String(node.offsetWidth);
      node.dataset.h = String(node.offsetHeight);
    }
    dirty = true;
  }
  function place() {
    const s = Math.sin(sph.ph);
    eye = [
      target[0] + sph.r * s * Math.cos(sph.th),
      target[1] + sph.r * Math.cos(sph.ph),
      target[2] + sph.r * s * Math.sin(sph.th),
    ];
    const view = lookAt(eye, target);
    vp = multiply(projection, view);
    gl!.uniformMatrix4fv(u.view, false, view);
    gl!.uniformMatrix4fv(u.proj, false, projection);
  }
  function render() {
    gl!.clear(gl!.COLOR_BUFFER_BIT);
    const scale = (H * dpr) / (2 * Math.tan(FOV / 2));
    gl!.uniform1f(u.mix, mix);
    gl!.uniform1f(u.scale, scale);
    gl!.uniform1f(u.dpr, dpr);
    gl!.uniform1f(u.glow, 1);
    gl!.uniform1f(u.max, Math.min(maxPoint, 2048));
    bind(glow);
    gl!.drawArrays(gl!.POINTS, 0, T);
    gl!.uniform1f(u.glow, 0);
    gl!.uniform1f(u.max, Math.min(maxPoint, 56 * dpr));
    gl!.uniform1f(u.near, sph.r * 0.5 + 30);
    gl!.uniform1f(u.far, sph.r * 1.4 + 160);
    bind(stars);
    gl!.drawArrays(gl!.POINTS, 0, N);
  }
  const pr: Projected = { x: 0, y: 0, w: 0, behind: false };
  const proj = (p: Vec3) => project(vp, p, W, H, pr);

  // How far back to stand: enough to take in the nearer neighbours; the rest
  // lie farther out and wait at the edges, pointing the way.
  const distance = (a: Vec3, b: Vec3) =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  function frameRadius(i: number) {
    const p = posOf(i);
    const d = sky.neighbors[i]
      .map((j) => distance(p, posOf(j)))
      .sort((a, b) => a - b);
    return clamp((d[Math.min(5, d.length - 1)] ?? 10) * 1.6, 8, 70);
  }
  function flyTo(to: () => Vec3, r1: number, done?: () => void, dur?: number) {
    const end = to();
    const dist = distance(target, end);
    if (reduced) {
      target.splice(0, 3, ...end);
      sph.r = r1;
      dirty = true;
      done?.();
      return;
    }
    fly = {
      from: [...target] as Vec3,
      to,
      r0: sph.r,
      r1,
      lift: Math.min(70, dist * 0.5),
      swirl: dist > 4 ? 0.4 : 0,
      e: 0,
      t0: performance.now(),
      dur: dur ?? Math.min(2600, 1000 + dist * 16),
      done,
    };
  }

  // Labels: the ten nearest as doors, the topics' names, and the titles of
  // the stars nearest the camera.
  interface Door {
    j: number;
    s: number;
    back?: boolean;
    node: HTMLButtonElement;
    w: number;
    h: number;
    // Its size waiting at the edge, where the arrow shows and may wrap it.
    pw: number;
    ph: number;
  }
  let doors: Door[] = [];
  const centres = new Map<number, number>();
  function centreOf(k: number) {
    if (!centres.has(k)) {
      let best = -1;
      let bd = Infinity;
      const m = sky.topics[k].meaning;
      for (let i = 0; i < N; i++) {
        if (sky.topic[i] !== k) continue;
        const d =
          (meaning[3 * i] - m[0]) ** 2 +
          (meaning[3 * i + 1] - m[1]) ** 2 +
          (meaning[3 * i + 2] - m[2]) ** 2;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      centres.set(k, best);
    }
    return centres.get(k)!;
  }
  const topicNodes = sky.topics.map((topic, k) => {
    const node = element('button', 'sky-topic', topic.name);
    node.type = 'button';
    node.tabIndex = -1;
    node.style.opacity = '0';
    node.addEventListener('click', () => {
      stopPlay();
      walk.go(centreOf(k));
    });
    return node;
  });
  const nearNodes = Array.from({ length: NEAR_LABELS }, () => {
    const node = element('button', 'sky-near');
    node.type = 'button';
    node.tabIndex = -1;
    node.style.opacity = '0';
    node.addEventListener('click', () => {
      stopPlay();
      const j = Number(node.dataset.star);
      if (j >= 0) walk.go(j);
    });
    return node;
  });
  box.append(...topicNodes, ...nearNodes);

  function buildDoors(i: number) {
    for (const door of doors) door.node.remove();
    const trail = walk.trail();
    const back = trail.length > 1 ? trail[trail.length - 2] : -1;
    const near = sky.neighbors[i];
    const items: Omit<Door, 'node' | 'w' | 'h' | 'pw' | 'ph'>[] = near.map(
      (j, q) => ({
        j,
        s: near.length > 1 ? 1 - q / (near.length - 1) : 1,
      }),
    );
    if (back >= 0 && !near.includes(back))
      items.push({ j: back, s: 0, back: true });
    doors = items.map((item) => {
      const node = element(
        'button',
        `sky-door${walk.visited().has(item.j) ? ' seen' : ''}`,
      );
      node.type = 'button';
      node.style.opacity = '0';
      const title = element('span', 't');
      title.append(element('span', 'arr', '→'), cut(sky.titles[item.j], 90));
      const why = reason(sky, i, item.j);
      const meta = item.back
        ? `You came from here · ${new Date(sky.day[item.j] * 86_400_000).getUTCFullYear()}`
        : [
            new Date(sky.day[item.j] * 86_400_000).getUTCFullYear(),
            cut(sky.hosts[sky.host[item.j]], 26),
            why,
          ]
            .filter(Boolean)
            .join(' · ');
      node.append(title, element('span', 'm', meta));
      node.addEventListener('click', () => {
        stopPlay();
        walk.go(item.j);
      });
      box.append(node);
      const w = node.offsetWidth;
      const h = node.offsetHeight;
      node.classList.add('pin');
      const door = {
        ...item,
        node,
        w,
        h,
        pw: node.offsetWidth,
        ph: node.offsetHeight,
      };
      node.classList.remove('pin');
      return door;
    });
    doors.sort((a, b) => b.s - a.s);
  }

  interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
  }
  let obstacles: Box[] = [];
  function measure() {
    const out: Box[] = [];
    const origin = stage.getBoundingClientRect();
    // The hint, while it shows, is in the way too.
    const hint = stage.querySelector<HTMLElement>('.sky-hint')!;
    const shown = hint.style.opacity === '0' ? [] : [hint];
    for (const node of [...bar.children, card, ...shown]) {
      const r = node.getBoundingClientRect();
      if (r.width)
        out.push({
          x: r.left - origin.left - 8,
          y: r.top - origin.top - 8,
          w: r.width + 16,
          h: r.height + 16,
        });
    }
    return out;
  }
  const hits = (a: Box, b: Box) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const show = (node: HTMLElement, b: Box | null, scale = 1, opacity = 1) => {
    if (b) {
      node.style.transform = `translate(${b.x}px, ${b.y}px) scale(${scale})`;
      node.style.opacity = String(opacity);
      node.style.pointerEvents = 'auto';
    } else {
      node.style.opacity = '0';
      node.style.pointerEvents = 'none';
    }
  };
  function layout() {
    const placed = obstacles.slice();
    const free = (b: Box) => !placed.some((p) => hits(p, b));
    const cur = walk.current();
    const top = bar.offsetTop + bar.offsetHeight + 8;
    const inner = { x0: 14, y0: top, x1: W - 14, y1: H - 12 };
    const c = proj(posOf(cur));
    const cx = c.x;
    const cy = c.y;
    const on = !c.behind;
    ring.style.opacity = on ? '1' : '0';
    ring.style.transform = `translate(${cx}px, ${cy}px)`;
    if (on) placed.push({ x: cx - 16, y: cy - 16, w: 32, h: 32 });
    for (const door of doors) {
      const p = proj(posOf(door.j));
      const inView =
        !p.behind &&
        p.x > inner.x0 &&
        p.x < inner.x1 &&
        p.y > inner.y0 &&
        p.y < inner.y1;
      let b: Box | null = null;
      let scale = 1;
      let opacity = 1;
      if (inView) {
        scale = clamp(sph.r / p.w, 0.85, 1.1);
        opacity = clamp(1.25 - p.w / (sph.r * 3), 0.6, 1);
        const w = door.w * scale;
        const h = door.h * scale;
        for (const [x, y] of [
          [p.x + 9, p.y - h / 2],
          [p.x - 9 - w, p.y - h / 2],
          [p.x - w / 2, p.y - h - 8],
          [p.x - w / 2, p.y + 8],
        ]) {
          const cand = { x, y, w, h };
          if (
            x >= 4 &&
            y >= 4 &&
            x + w <= W - 4 &&
            y + h <= H - 4 &&
            free(cand)
          ) {
            b = cand;
            break;
          }
        }
      } else {
        // Out of view: wait at the edge where the line to it leaves.
        let dx = p.x - ax;
        let dy = p.y - ay;
        const m = Math.hypot(dx, dy) || 1;
        dx /= m;
        dy /= m;
        const t = Math.min(
          dx > 0
            ? (inner.x1 - ax) / dx
            : dx < 0
              ? (inner.x0 - ax) / dx
              : Infinity,
          dy > 0
            ? (inner.y1 - ay) / dy
            : dy < 0
              ? (inner.y0 - ay) / dy
              : Infinity,
        );
        const w = door.pw * 0.92;
        const h = door.ph * 0.92;
        const cand = {
          x: clamp(ax + dx * t - w / 2, inner.x0, inner.x1 - w),
          y: clamp(ay + dy * t - h / 2, inner.y0, inner.y1 - h),
          w,
          h,
        };
        if (free(cand)) {
          b = cand;
          scale = 0.92;
          opacity = 0.8;
          door.node.style.setProperty(
            '--a',
            `${Math.atan2(dy, dx).toFixed(3)}rad`,
          );
        }
      }
      door.node.classList.toggle('pin', !inView);
      show(door.node, b, scale, opacity);
      if (b) placed.push(b);
    }

    // Topic names: the nearby ones when close, the big ones from far away.
    const mine = sky.topic[cur];
    const far = sph.r > 95;
    const order = sky.topics.map((_, k) => k);
    const spots = order.map((k) => topicPos(k));
    if (far) order.sort((a, b) => sky.topics[b].size - sky.topics[a].size);
    else
      order.sort(
        (a, b) => distance(target, spots[a]) - distance(target, spots[b]),
      );
    const named = new Set([mine, ...order.slice(0, far ? 30 : 12)]);
    topicNodes.forEach((node, k) => {
      let b: Box | null = null;
      let opacity = 0;
      if (named.has(k)) {
        const p = proj(spots[k]);
        const w = Number(node.dataset.w);
        const h = Number(node.dataset.h);
        const cand = { x: p.x - w / 2, y: p.y - h / 2, w, h };
        if (
          !p.behind &&
          cand.x > 4 &&
          cand.y > top &&
          cand.x + w < W - 4 &&
          cand.y + h < H - 4 &&
          free(cand)
        ) {
          b = cand;
          opacity =
            k === mine ? 0.95 : clamp(1.3 - p.w / (sph.r * 2.2), 0.4, 0.8);
        }
      }
      node.classList.toggle('mine', k === mine);
      show(node, b, 1, opacity);
      if (b) placed.push(b);
    });

    // Titles of the stars nearest the camera, as it closes in on them.
    const labelled = new Set([cur, ...doors.map((d) => d.j)]);
    const near: { i: number; d: number }[] = [];
    const within = sph.r * 1.2;
    const p: Vec3 = [0, 0, 0];
    for (let i = 0; i < N && sph.r < 60; i++) {
      if (labelled.has(i)) continue;
      const d = distance(eye, posOf(i, p));
      if (d > within) continue;
      if (near.length < 40 || d < near[near.length - 1].d) {
        near.push({ i, d });
        near.sort((a, b) => a.d - b.d);
        if (near.length > 40) near.pop();
      }
    }
    let used = 0;
    for (const { i, d } of near) {
      if (used >= NEAR_LABELS) break;
      const q = proj(posOf(i, p));
      if (
        q.behind ||
        q.x < inner.x0 ||
        q.x > inner.x1 ||
        q.y < inner.y0 ||
        q.y > inner.y1
      )
        continue;
      const node = nearNodes[used];
      if (node.dataset.star !== String(i)) {
        node.dataset.star = String(i);
        node.textContent = cut(sky.titles[i], 60);
        node.dataset.w = String(node.offsetWidth);
        node.dataset.h = String(node.offsetHeight);
      }
      const cand = {
        x: q.x + 7,
        y: q.y - Number(node.dataset.h) / 2,
        w: Number(node.dataset.w),
        h: Number(node.dataset.h),
      };
      if (cand.x + cand.w > W - 4 || !free(cand)) continue;
      show(node, cand, 1, clamp(1.1 - d / within, 0.25, 0.75));
      placed.push(cand);
      used += 1;
    }
    for (let k = used; k < NEAR_LABELS; k++) show(nearNodes[k], null);
  }

  // Lines to the ten and the trail behind; in Time, a ring and the year at
  // the start of every year.
  function drawFx() {
    fxg.clearRect(0, 0, W, H);
    if (mix > 0.01) {
      fxg.font = '600 14px Inter, system-ui, sans-serif';
      fxg.textAlign = 'center';
      for (let year = Math.ceil(first); year <= last; year++) {
        const a = 0.14 * staggered(mix, (year - first) / (last - first || 1));
        const z = depthOf(year, middle);
        fxg.strokeStyle = `rgba(160, 175, 220, ${a})`;
        fxg.lineWidth = 1;
        fxg.beginPath();
        let started = false;
        for (let k = 0; k <= 48; k++) {
          const q = proj([
            Math.cos((k / 48) * Math.PI * 2) * 115,
            Math.sin((k / 48) * Math.PI * 2) * 115,
            z,
          ]);
          if (q.behind) {
            started = false;
            continue;
          }
          if (started) fxg.lineTo(q.x, q.y);
          else fxg.moveTo(q.x, q.y);
          started = true;
        }
        fxg.stroke();
        const q = proj([0, 122, z]);
        if (!q.behind) {
          fxg.fillStyle = `rgba(195, 201, 218, ${Math.min(1, a * 5)})`;
          fxg.fillText(String(year), q.x, q.y);
        }
      }
    }
    const cur = walk.current();
    const c = proj(posOf(cur));
    if (c.behind) return;
    const cx = c.x;
    const cy = c.y;
    fxg.lineCap = 'round';
    for (const door of doors) {
      if (door.back) continue;
      const p = proj(posOf(door.j));
      if (p.behind) continue;
      const a = 0.25 + 0.45 * door.s;
      const g = fxg.createLinearGradient(cx, cy, p.x, p.y);
      g.addColorStop(0, `rgba(159, 180, 255, ${a})`);
      g.addColorStop(1, `rgba(159, 180, 255, ${a * 0.35})`);
      fxg.strokeStyle = g;
      fxg.lineWidth = 0.8 + door.s * 0.9;
      fxg.beginPath();
      fxg.moveTo(cx, cy);
      fxg.lineTo(p.x, p.y);
      fxg.stroke();
    }
    const trail = walk.trail();
    if (trail.length > 1) {
      fxg.strokeStyle = 'rgba(210, 176, 255, 0.75)';
      fxg.lineWidth = 2;
      fxg.setLineDash([0.5, 6]);
      fxg.beginPath();
      let started = false;
      for (const i of trail) {
        const p = proj(posOf(i));
        if (p.behind) {
          started = false;
          continue;
        }
        if (started) fxg.lineTo(p.x, p.y);
        else fxg.moveTo(p.x, p.y);
        started = true;
      }
      fxg.stroke();
      fxg.setLineDash([]);
    }
  }

  // The frame loop runs only while something moves.
  let running = false;
  let raf = 0;
  let then = performance.now();
  function frame(now: number) {
    raf = 0;
    if (!running) return;
    const dt = Math.min(64, now - then);
    then = now;
    if (morph) {
      const u = Math.min(1, (now - morph.t0) / morph.dur);
      const e = ease(u);
      mix = morph.from + (morph.to - morph.from) * e;
      if (morph.th) sph.th = morph.th[0] + (morph.th[1] - morph.th[0]) * e;
      if (morph.ph) sph.ph = morph.ph[0] + (morph.ph[1] - morph.ph[0]) * e;
      if (u >= 1) morph = null;
      dirty = true;
    }
    if (fly) {
      const u = Math.min(1, (now - fly.t0) / fly.dur);
      const e = ease(u);
      const to = fly.to();
      for (let k = 0; k < 3; k++)
        target[k] = fly.from[k] + (to[k] - fly.from[k]) * e;
      sph.r = fly.r0 + (fly.r1 - fly.r0) * e + fly.lift * Math.sin(Math.PI * u);
      sph.th += fly.swirl * (e - fly.e);
      fly.e = e;
      if (u >= 1) {
        const done = fly.done;
        fly = null;
        done?.();
      }
      dirty = true;
    } else if (follow >= 0 && morph) {
      posOf(follow, target);
    }
    if (!reduced && !dragging && now > idleUntil && !morph) {
      sph.th += dt * 0.00005;
      dirty = true;
    }
    if (dirty) {
      place();
      render();
      drawFx();
      layout();
      dirty = false;
    }
    raf = requestAnimationFrame(frame);
  }
  const wake = () => {
    if (running && !raf) {
      then = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };

  // Play: the sky flies itself (lib/sky.ts, nextStop and nextTopic).
  interface Tour {
    timer: number;
    hops: number;
    topics: Set<number>;
  }
  let play: Tour | null = null;
  const dwell = () => 6000 + Math.random() * 2000;
  function schedule(ms: number) {
    if (!play) return;
    clearTimeout(play.timer);
    play.timer = window.setTimeout(step, ms);
  }
  function landed() {
    if (play) schedule(dwell());
  }
  function step() {
    if (!play) return;
    if (document.hidden || fly || morph) return schedule(1000);
    const cur = walk.current();
    const here = posOf(cur);
    const stop = nextStop(
      sky.neighbors[cur],
      walk.visited(),
      play.hops,
      (j) => distance(here, posOf(j)),
      Math.random,
    );
    if ('hop' in stop) {
      play.hops += 1;
      walk.go(stop.hop);
      return;
    }
    // Pull back over the whole sky, then cross to another constellation.
    const from = sky.topic[cur];
    const to = nextTopic(
      sky.topics.map((t) => t.size),
      from,
      play.topics,
      Math.random,
    );
    play.topics.add(to);
    play.hops = 0;
    const middle_: Vec3 = [
      (here[0] + topicPos(to)[0]) / 2,
      (here[1] + topicPos(to)[1]) / 2,
      (here[2] + topicPos(to)[2]) / 2,
    ];
    follow = -1;
    flyTo(
      () => middle_,
      WHOLE * 0.8,
      () => {
        if (!play) return;
        play.timer = window.setTimeout(
          () => {
            if (!play) return;
            // Somewhere near its middle, a link with a note.
            const c = posOf(centreOf(to));
            const members: { i: number; d: number }[] = [];
            for (let i = 0; i < N; i++)
              if (sky.topic[i] === to && sky.note[i] && !walk.visited().has(i))
                members.push({ i, d: distance(c, posOf(i)) });
            members.sort((a, b) => a.d - b.d);
            const pick = members.length
              ? members[
                  Math.floor(Math.random() * Math.min(20, members.length))
                ].i
              : centreOf(to);
            walk.go(pick);
          },
          reduced ? 0 : 900,
        );
      },
      2400,
    );
  }
  function startPlay() {
    play = { timer: 0, hops: 0, topics: new Set([sky.topic[walk.current()]]) };
    playButton.setAttribute('aria-pressed', 'true');
    playButton.textContent = 'Pause';
    card.setAttribute('aria-live', 'off');
    quiet();
    idleUntil = 0;
    schedule(reduced ? 3000 : 1200);
  }
  function stopPlay() {
    if (!play) return;
    clearTimeout(play.timer);
    play = null;
    playButton.setAttribute('aria-pressed', 'false');
    playButton.textContent = 'Play';
    card.setAttribute('aria-live', 'polite');
  }
  playButton.addEventListener('click', () => (play ? stopPlay() : startPlay()));

  // Meaning and Time.
  const layoutButtons = [
    ...stage.querySelectorAll<HTMLButtonElement>('[data-layout]'),
  ];
  function setLayout(name: string) {
    const to = name === 'time' ? 1 : 0;
    for (const b of layoutButtons)
      b.setAttribute('aria-pressed', String(b.dataset.layout === name));
    if (to === mix && !morph) return;
    // Time is seen down its length, the oldest years farthest away.
    const angles = to
      ? { th: [sph.th, Math.PI / 2 + 0.45], ph: [sph.ph, 1.3] }
      : {};
    if (reduced) {
      mix = to;
      if (angles.th) {
        sph.th = angles.th[1];
        sph.ph = angles.ph![1];
      }
      if (follow >= 0) posOf(follow, target);
      dirty = true;
      wake();
      return;
    }
    morph = {
      from: mix,
      to,
      t0: performance.now(),
      dur: 2600,
      ...(angles as Pick<Morph, 'th' | 'ph'>),
    };
    wake();
  }
  for (const b of layoutButtons)
    b.addEventListener('click', () => setLayout(b.dataset.layout!));
  $<HTMLButtonElement>('[data-whole]').addEventListener('click', () => {
    stopPlay();
    quiet();
    follow = -1;
    flyTo(() => [0, 0, 0], mix > 0.5 ? WHOLE + 60 : WHOLE);
    wake();
  });

  // Turning, moving closer, and choosing a star.
  const pointers = new Map<number, [number, number]>();
  let downAt: [number, number] = [0, 0];
  let moved = 0;
  let pinch = 0;
  const hint = $<HTMLElement>('.sky-hint');
  const quiet = () => {
    idleUntil = performance.now() + 4000;
    if (hint.style.opacity === '0') return;
    hint.style.opacity = '0';
    obstacles = measure();
  };
  function nearest(x: number, y: number, within: number) {
    let best = -1;
    let bd = within * within;
    const p: Vec3 = [0, 0, 0];
    for (let i = 0; i < N; i++) {
      const q = proj(posOf(i, p));
      if (q.behind) continue;
      const d = (q.x - x) ** 2 + (q.y - y) ** 2 - (size[3 * i + 2] ? 60 : 0);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }
  const local = (e: PointerEvent | WheelEvent): [number, number] => {
    const r = stage.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const zoom = (f: number) => {
    sph.r = clamp(sph.r * f, 2, 320);
    if (fly) {
      fly.r1 = clamp(fly.r1 * f, 2, 320);
      fly.r0 = clamp(fly.r0 * f, 2, 320);
    }
  };
  canvas.addEventListener('pointerdown', (e) => {
    stopPlay();
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    downAt = [e.clientX, e.clientY];
    moved = 0;
    dragging = true;
    canvas.classList.add('drag');
    tip.style.opacity = '0';
    quiet();
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType !== 'mouse' || fly || morph) return;
      const [x, y] = local(e);
      const i = nearest(x, y, 12);
      if (i < 0) {
        tip.style.opacity = '0';
        return;
      }
      tip.replaceChildren(
        cut(sky.titles[i], 80),
        element(
          'small',
          '',
          `${new Date(sky.day[i] * 86_400_000).getUTCFullYear()} · ${sky.hosts[sky.host[i]]} · ${sky.topics[sky.topic[i]].name}`,
        ),
      );
      tip.style.transform = `translate(${Math.min(x + 14, W - tip.offsetWidth - 8)}px, ${y + 16}px)`;
      tip.style.opacity = '1';
      return;
    }
    const [px, py] = pointers.get(e.pointerId)!;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    moved = Math.max(
      moved,
      Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]),
    );
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) zoom(pinch / d);
      pinch = d;
      moved = 99;
    } else {
      sph.th += (e.clientX - px) * 0.0055;
      sph.ph = clamp(sph.ph - (e.clientY - py) * 0.0055, 0.15, Math.PI - 0.15);
    }
    dirty = true;
    quiet();
    wake();
  });
  const up = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (!pointers.size) {
      dragging = false;
      canvas.classList.remove('drag');
      if (e.type === 'pointerup' && moved < 6) {
        const [x, y] = local(e);
        const i = nearest(x, y, e.pointerType === 'mouse' ? 14 : 22);
        if (i >= 0) walk.go(i);
      }
    }
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', () => {
    tip.style.opacity = '0';
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      stopPlay();
      zoom(Math.exp(clamp(e.deltaY, -120, 120) * 0.0016));
      dirty = true;
      quiet();
      wake();
    },
    { passive: false },
  );
  // Any touch, click or key hands the controls back from Play, except on
  // Play's own button. On the sky itself, the arrows turn it and + and -
  // move closer and back.
  stage.addEventListener(
    'pointerdown',
    (e) => {
      if (!(e.target as Element).closest('[data-play]')) stopPlay();
    },
    true,
  );
  stage.addEventListener('keydown', (e) => {
    const target = e.target as Element;
    if (target.closest('[data-play]') || ['Tab', 'Shift'].includes(e.key))
      return;
    stopPlay();
    if (target !== canvas || e.metaKey || e.ctrlKey || e.altKey) return;
    const turn: Record<string, [number, number]> = {
      ArrowLeft: [-0.12, 0],
      ArrowRight: [0.12, 0],
      ArrowUp: [0, -0.1],
      ArrowDown: [0, 0.1],
    };
    if (turn[e.key]) {
      sph.th += turn[e.key][0];
      sph.ph = clamp(sph.ph + turn[e.key][1], 0.15, Math.PI - 0.15);
    } else if (['+', '=', '-'].includes(e.key))
      zoom(e.key === '-' ? 1.15 : 1 / 1.15);
    else return;
    e.preventDefault();
    dirty = true;
    quiet();
    wake();
  });
  document.addEventListener('visibilitychange', () => {
    if (play && !document.hidden) schedule(dwell());
  });
  if (document.fonts)
    document.fonts.ready.then(() => {
      if (!running) return;
      resize();
      if (walk.current() >= 0) buildDoors(walk.current());
      wake();
    });
  // The note arrives after the card opens, and the card grows.
  new ResizeObserver(() => {
    obstacles = measure();
    dirty = true;
    wake();
  }).observe(card);

  let shown = false;
  return {
    show(i, arrive) {
      paint();
      const trail = walk.trail();
      const back = trail.length > 1 ? trail[trail.length - 2] : -1;
      renderCard(card, sky, i, back, () => {
        stopPlay();
        walk.go(back);
      });
      buildDoors(i);
      obstacles = measure();
      follow = i;
      const go = () => flyTo(() => posOf(i), frameRadius(i), landed);
      // The first star: the whole sky first, then down to it.
      if (!shown && arrive && !reduced) setTimeout(go, 900);
      else go();
      shown = true;
      dirty = true;
      wake();
    },
    resize() {
      resize();
      wake();
    },
    pause() {
      stopPlay();
      running = false;
    },
    resume() {
      running = true;
      resize();
      wake();
    },
    stopPlay,
  };
}
