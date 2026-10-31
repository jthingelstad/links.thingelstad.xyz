// The stars the sky draws, on the front page and at /sky/, in the shape
// src/lib/sky.ts gives as SkyData, as two files (splitSky):
// /sky/places.json (src/pages/sky/places.json.ts), what drawing needs, and
// /sky/stars.json (src/pages/sky/stars.json.ts), the titles, sites, kinds,
// issues and neighbours. Never a note, which the card fetches from the
// link's JSON twin when it opens. A link without a star (the nightly has not
// reached it) is left out, and so are neighbours that are.
import {
  type Link,
  appearances,
  kinds,
  linkById,
  links,
  skyFamilies,
  skyLayout,
  skyTopics,
  stars,
} from './data.ts';
import {
  GLOWS,
  type SkyData,
  type Vec3,
  dayOf,
  lookAt,
  multiply,
  perspective,
  project,
  shift,
  splitSky,
  starLight,
} from './sky.ts';

const tenth = (n: number) => Math.round(n * 10) / 10;
const hundredth = (n: number) => Math.round(n * 100) / 100;

let files: ReturnType<typeof splitSky> | undefined;
export const skyFiles = () => (files ??= splitSky(skyDocument()));

export function skyDocument(): SkyData {
  const shown = links.filter((link) => stars.has(link.id));
  const index = new Map(shown.map((link, i) => [link.id, i]));
  const hosts = [...new Set(shown.map((link) => link.host))].sort();
  const hostIndex = new Map(hosts.map((host, i) => [host, i]));
  const sizes = skyTopics.map(() => 0);
  const issues: Record<string, number[]> = {};
  shown.forEach((link, i) => {
    sizes[stars.get(link.id)!.topic] += 1;
    const numbers = (appearances.get(link.id) ?? [])
      .map((a) => a.issue.number)
      .filter((n): n is number => n !== null);
    if (numbers.length) issues[i] = [...new Set(numbers)];
  });
  return {
    layout: skyLayout,
    ids: shown.map((link) => link.id),
    titles: shown.map((link) => link.shown),
    hosts,
    host: shown.map((link) => hostIndex.get(link.host)!),
    kind: shown.map((link) => kinds.indexOf(link.kind)),
    day: shown.map((link) => dayOf(link.day)),
    note: shown.map((link) => (link.hasNote ? 1 : 0)),
    topic: shown.map((link) => stars.get(link.id)!.topic),
    meaning: shown.flatMap((link) => stars.get(link.id)!.meaning.map(tenth)),
    time: shown.flatMap((link) => stars.get(link.id)!.time.map(tenth)),
    neighbors: shown.map((link) =>
      stars
        .get(link.id)!
        .neighbors.map((id) => index.get(id))
        .filter((i): i is number => i !== undefined),
    ),
    issues,
    topics: skyTopics.map((topic) => ({
      name: topic.name,
      family: topic.family,
      meaning: topic.meaning,
      time: topic.time,
      size: sizes[topic.id],
    })),
    families: skyFamilies,
  };
}

// The constellations as the page lists them for a reader without the sky (and
// for crawlers): each family's topics, largest first, each with its size, the
// star its name sits on, and the links nearest that, those with a note first.
export function constellations(per = 3) {
  const members = new Map<number, Link[]>();
  for (const [id, star] of stars) {
    if (!members.has(star.topic)) members.set(star.topic, []);
    members.get(star.topic)!.push(linkById.get(id)!);
  }
  const away = (link: Link, at: number[]) => {
    const m = stars.get(link.id)!.meaning;
    return (m[0] - at[0]) ** 2 + (m[1] - at[1]) ** 2 + (m[2] - at[2]) ** 2;
  };
  return skyFamilies.map((family, f) => ({
    family,
    topics: skyTopics
      .filter((topic) => topic.family === f)
      .map((topic) => {
        const near = [...(members.get(topic.id) ?? [])].sort(
          (a, b) => away(a, topic.meaning) - away(b, topic.meaning),
        );
        return {
          name: topic.name,
          size: near.length,
          centre: near[0],
          links: [
            ...near.filter((link) => link.hasNote),
            ...near.filter((link) => !link.hasNote),
          ].slice(0, per),
        };
      })
      .filter((topic) => topic.centre)
      .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name)),
  }));
}

// A topic's links, in the links' order (oldest first), and the topics its
// links' nearest neighbours most often fall in: the topics beside it.
let byTopic: Map<number, Link[]> | undefined;
export function topicLinks(topic: number) {
  if (!byTopic) {
    byTopic = new Map();
    for (const link of links) {
      const star = stars.get(link.id);
      if (!star) continue;
      if (!byTopic.has(star.topic)) byTopic.set(star.topic, []);
      byTopic.get(star.topic)!.push(link);
    }
  }
  return byTopic.get(topic) ?? [];
}
export function nearTopics(topic: number, limit = 4) {
  const edges = new Map<number, number>();
  for (const link of topicLinks(topic))
    for (const id of stars.get(link.id)!.neighbors) {
      const other = stars.get(id)?.topic;
      if (other !== undefined && other !== topic)
        edges.set(other, (edges.get(other) ?? 0) + 1);
    }
  return [...edges]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([id]) => skyTopics[id]);
}

// /sky/card.json (src/pages/sky/card.json.ts): the sky as a lens page's share
// card draws it (cards.thingelstad.com, its `sky` layout; Jamie, 2026-10-31:
// "Approved: build Linking Things sky cards ..."). Every star in the Meaning
// layout, seen as the front page first shows it but nearer and set right of
// the card's words, projected onto the card above its band (1200 x 562):
// four numbers a star in the order of `ids` (x, y, its light from
// starLight, its warmth), and each topic's glow as [x, y, r, colour]. The
// card maker turns the view toward the stars a page lists; it never sees a
// title. No build time in it, so it uploads only when the stars change.
export const CARD_SKY = {
  width: 1200,
  height: 562,
  fov: (55 * Math.PI) / 180,
  // The camera, as the sky's own (sky-gl.ts: radius, theta, phi), nearer.
  r: 150,
  th: 0.7,
  ph: 1.15,
  // Where the middle of the sky lands on the card.
  ax: 0.66,
  ay: 0.47,
};

export function cardSky() {
  const { places, names } = skyFiles();
  const { width: W, height: H, fov, r, th, ph, ax, ay } = CARD_SKY;
  const s = Math.sin(ph);
  const eye: Vec3 = [
    r * s * Math.cos(th),
    r * Math.cos(ph),
    r * s * Math.sin(th),
  ];
  const vp = multiply(
    shift(perspective(fov, W / H, 0.1, 3000), W * ax, H * ay, W, H),
    lookAt(eye, [0, 0, 0]),
  );
  const scale = H / (2 * Math.tan(fov / 2));
  const at = { x: 0, y: 0, w: 0, behind: false };
  // A star behind the camera (none, while the sky is smaller than the
  // camera's distance) is left far off the card, never drawn.
  const place = (p: Vec3) => {
    project(vp, p, W, H, at);
    return at.behind
      ? [-10 * W, -10 * H]
      : [
          tenth(Math.max(-10 * W, Math.min(10 * W, at.x))),
          tenth(Math.max(-10 * H, Math.min(10 * H, at.y))),
        ];
  };
  const light = starLight(places.note);
  const stars: number[] = [];
  for (let i = 0; i < names.ids.length; i++) {
    const [x, y] = place(places.meaning.slice(3 * i, 3 * i + 3) as Vec3);
    stars.push(x, y, hundredth(light.bright[i]), hundredth(light.warm[i]));
  }
  const glows = places.topics.map((topic) => {
    const [x, y] = place(topic.meaning);
    const depth = Math.max(at.w, 1);
    return [
      Math.round(x),
      Math.round(y),
      Math.round(((10 + Math.sqrt(topic.size) * 1.4) * scale) / depth),
      GLOWS[topic.family % GLOWS.length],
    ] as [number, number, number, string];
  });
  return {
    layout: places.layout,
    width: W,
    height: H,
    ids: names.ids,
    stars,
    glows,
  };
}
