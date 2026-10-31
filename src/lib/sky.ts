// The sky at /sky/ (docs/DIRECTION.md, "The sky"), the parts that need no
// page: the shape of /sky/stars.json (src/pages/sky/stars.json.ts writes it),
// where a star stands in each layout and between them, the camera's
// matrices, the sides Doors puts each neighbour on, and what Play does next.
// No DOM and no Node imports: src/scripts/sky.ts loads this in the browser,
// and tests/sky.test.mjs checks it.

// /sky/stars.json: one entry a star in each column, in the links' order
// (oldest saved first), so a star is its index everywhere.
export interface SkyData {
  layout: number;
  ids: string[];
  // The title as pages show it (titles.ts).
  titles: string[];
  hosts: string[];
  // The star's site, an index into hosts.
  host: number[];
  // The Central day saved, as days since 1970-01-01.
  day: number[];
  // 1 when the link has a note.
  note: number[];
  topic: number[];
  // x, y, z a star, one decimal.
  meaning: number[];
  // x, y a star across the Time layout, one decimal; the depth is the day.
  time: number[];
  // Indices of the nearest stars, nearest first.
  neighbors: number[][];
  // The Weekly Thing issues (by number) that carried a star, by its index.
  issues: Record<string, number[]>;
  topics: {
    name: string;
    family: number;
    meaning: [number, number, number];
    time: [number, number, number, number];
    size: number;
  }[];
  families: string[];
}

export type Vec3 = [number, number, number];
// A 4x4 matrix, column-major, as WebGL takes it.
export type Mat4 = Float32Array;

const DAY = 86_400_000;
// The Time layout's depth: this many units a year, the middle year at 0, so
// the depth spans about the same 200 units as the layouts' width.
export const YEAR_DEPTH = 10;

export const dayOf = (iso: string) =>
  Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
// A day as a decimal year, 2015.5 for the start of July.
export function yearOf(day: number) {
  const date = new Date(day * DAY);
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  return year + (day * DAY - start) / (Date.UTC(year + 1, 0, 1) - start);
}
export const dayLabel = (day: number) =>
  new Date(day * DAY).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
export const depthOf = (year: number, middle: number) =>
  (year - middle) * YEAR_DEPTH;

// How far along from Meaning (0) to Time (1) a star is when the whole sky is
// `mix` of the way: each star sets off at its own `delay` (0 to 1, its place
// in time), so the years peel off in order, and all arrive together. The
// shader in src/scripts/sky-gl.ts does the same sum.
export const STAGGER = 0.6;
export function staggered(mix: number, delay: number) {
  const t = Math.min(1, Math.max(0, mix * (1 + STAGGER) - delay * STAGGER));
  return t * t * (3 - 2 * t);
}

export function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

export function perspective(
  fovY: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

// Moves the picture so the point the camera looks at shows at (x, y) on a
// w by h screen rather than in the middle, as a lens shift does: the card
// and the toolbar keep the middle of the screen for themselves.
export function shift(
  projection: Mat4,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const m = projection.slice();
  m[8] = -((2 * x) / w - 1);
  m[9] = -(1 - (2 * y) / h);
  return m;
}

export function lookAt(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Mat4 {
  let zx = eye[0] - target[0],
    zy = eye[1] - target[1],
    zz = eye[2] - target[2];
  let n = Math.hypot(zx, zy, zz) || 1;
  zx /= n;
  zy /= n;
  zz /= n;
  let xx = up[1] * zz - up[2] * zy,
    xy = up[2] * zx - up[0] * zz,
    xz = up[0] * zy - up[1] * zx;
  n = Math.hypot(xx, xy, xz) || 1;
  xx /= n;
  xy /= n;
  xz /= n;
  const yx = zy * xz - zz * xy,
    yy = zz * xx - zx * xz,
    yz = zx * xy - zy * xx;
  const m = new Float32Array(16);
  m[0] = xx;
  m[1] = yx;
  m[2] = zx;
  m[4] = xy;
  m[5] = yy;
  m[6] = zy;
  m[8] = xz;
  m[9] = yz;
  m[10] = zz;
  m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  m[15] = 1;
  return m;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const m = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      m[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
  return m;
}

// Where a point lands on a w by h screen through `vp` (projection times
// view), and its distance in front of the camera (w). A point behind the
// camera is `behind`, its x and y thrown far off in the direction it lies.
export interface Projected {
  x: number;
  y: number;
  w: number;
  behind: boolean;
}
export function project(
  vp: Mat4,
  p: Vec3,
  width: number,
  height: number,
  out: Projected,
) {
  const cx = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
  const cy = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
  const cw = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
  out.w = cw;
  out.behind = cw <= 0.05;
  if (out.behind) {
    const m = Math.hypot(cx, cy) || 1;
    out.x = width / 2 + (cx / m) * 1e5;
    out.y = height / 2 - (cy / m) * 1e5;
  } else {
    out.x = ((cx / cw + 1) / 2) * width;
    out.y = ((1 - cy / cw) / 2) * height;
  }
  return out;
}

// Doors: split the neighbours, in clockwise order from the top, into four
// runs (top, right, bottom, left) that fit each side's room (`caps`) and keep
// as many as possible on the side where they really lie. `angle` is the
// direction to the neighbour on the map, screen-style (y down), in radians.
export function distribute<T extends { angle: number }>(
  items: T[],
  caps: number[],
): T[][] {
  const n = items.length;
  const quarter = Math.PI / 2;
  const tau = Math.PI * 2;
  const placed = items
    .map((item) => {
      const o = (item.angle + (3 * Math.PI) / 4 + 2 * tau) % tau;
      return { item, o, side: Math.min(3, Math.floor(o / quarter)) };
    })
    .sort((a, b) => a.o - b.o);
  let best: { cost: number; sides: T[][] } | null = null;
  for (let r = 0; r < Math.max(1, n); r++) {
    const ring = placed.slice(r).concat(placed.slice(0, r));
    for (let a = 0; a <= Math.min(caps[0], n); a++)
      for (let b = 0; b <= caps[1] && a + b <= n; b++)
        for (let c = 0; c <= caps[2] && a + b + c <= n; c++) {
          const d = n - a - b - c;
          if (d > caps[3]) continue;
          let cost = 0;
          ring.forEach((p, k) => {
            const side = k < a ? 0 : k < a + b ? 1 : k < a + b + c ? 2 : 3;
            if (side !== p.side) cost += 1;
          });
          if (!best || cost < best.cost) {
            const of = (list: typeof ring) => list.map((p) => p.item);
            best = {
              cost,
              sides: [
                of(ring.slice(0, a)),
                of(ring.slice(a, a + b)),
                of(ring.slice(a + b, a + b + c)).reverse(),
                of(ring.slice(a + b + c)).reverse(),
              ],
            };
          }
        }
  }
  if (!best)
    throw new Error(`${n} doors do not fit sides of ${caps.join(', ')}`);
  return best.sides;
}

// Play: what comes after the star in view. A hop goes to a neighbour not yet
// visited, one of the three farthest away (so the flight crosses the sky),
// chosen by `random`; every `every` hops, or when every neighbour has been
// visited, it is time to pull back and cross to another constellation.
export type Stop = { hop: number } | { jump: true };
export function nextStop(
  neighbors: number[],
  visited: ReadonlySet<number>,
  hops: number,
  distance: (star: number) => number,
  random: () => number,
  every = 5,
): Stop {
  if (hops > 0 && hops % every === 0) return { jump: true };
  const open = neighbors.filter((star) => !visited.has(star));
  if (!open.length) return { jump: true };
  const far = open
    .map((star) => ({ star, d: distance(star) }))
    .sort((a, b) => b.d - a.d || a.star - b.star)
    .slice(0, 3);
  return {
    hop: far[Math.min(far.length - 1, Math.floor(random() * far.length))].star,
  };
}

// The constellation Play crosses to: one not visited yet in this flight and
// not the one it leaves, larger ones likelier; when all have been visited,
// any but the one it leaves.
export function nextTopic(
  sizes: number[],
  from: number,
  visited: ReadonlySet<number>,
  random: () => number,
) {
  let open = sizes
    .map((_, t) => t)
    .filter((t) => t !== from && !visited.has(t));
  if (!open.length) open = sizes.map((_, t) => t).filter((t) => t !== from);
  const total = open.reduce((sum, t) => sum + Math.sqrt(sizes[t]), 0);
  let at = random() * total;
  for (const t of open) {
    at -= Math.sqrt(sizes[t]);
    if (at < 0) return t;
  }
  return open[open.length - 1];
}

// Why a neighbour is near, in a few words beside its title: a shared issue,
// or the same site. The year is beside it already.
export function reason(sky: SkyData, i: number, j: number) {
  const mine = sky.issues[i] ?? [];
  const shared = (sky.issues[j] ?? []).find((n) => mine.includes(n));
  if (shared !== undefined) return `same issue, WT${shared}`;
  return sky.host[i] === sky.host[j] ? 'same site' : '';
}

export const cut = (text: string, max: number) =>
  text.length <= max
    ? text
    : `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
