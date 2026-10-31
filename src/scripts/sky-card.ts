// The card on a star at /sky/ (Doors' big type, docs/DIRECTION.md, "The
// sky"): its topic, title, day and site at once from the stars file, then
// its kind, issues and note from the link's JSON twin, rendered as the search
// preview renders them (preview.ts, loaded with markdown-it the first time a
// card opens), and the way to its record page. The Doors view shows the same
// card larger, as its page.
import { linkPath } from '../lib/paths.ts';
import { type SkyData, cut, dayLabel } from '../lib/sky.ts';

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function anchor(href: string, text: string, className?: string) {
  const a = element('a', className, text);
  a.href = href;
  return a;
}

export const metaOf = (sky: SkyData, i: number) =>
  `${dayLabel(sky.day[i])} · ${sky.hosts[sky.host[i]]}`;

let shown = 0;

// Fills `card` with star i. `back` is the star before it on the walk, if
// any, and `goBack` takes the reader there; `out`, in the sky, steps back
// out to the whole sky (or to what Find lit).
export async function renderCard(
  card: HTMLElement,
  sky: SkyData,
  i: number,
  back: number,
  goBack: () => void,
  out?: { label: string; go: () => void },
) {
  const mine = ++shown;
  const record = linkPath(sky.ids[i]);
  const title = element('h2', 'sky-card-title');
  title.append(anchor(record, sky.titles[i]));
  if (sky.titles[i].length > 80) title.classList.add('long');
  const foot = element('p', 'sky-card-foot');
  foot.append(anchor(record, 'Its record'));
  if (back >= 0) {
    const button = element(
      'button',
      'sky-back',
      `← Back to ${cut(sky.titles[back], 40)}`,
    );
    button.type = 'button';
    button.addEventListener('click', goBack);
    foot.append(button);
  }
  if (out) {
    const button = element('button', 'sky-out', out.label);
    button.type = 'button';
    button.addEventListener('click', out.go);
    foot.append(button);
  }
  card.replaceChildren(
    element('p', 'sky-card-topic', sky.topics[sky.topic[i]].name),
    title,
    element('p', 'sky-card-meta', metaOf(sky, i)),
    foot,
  );
  card.scrollTop = 0;
  try {
    const { twinOf, facts, note } = await import('./preview.ts');
    const twin = await twinOf(sky.ids[i]);
    if (mine !== shown) return;
    const extra: Node[] = [facts(twin)];
    if (twin.note.trim()) extra.push(note(twin));
    foot.before(...extra);
  } catch {
    if (mine !== shown) return;
    foot.before(
      element(
        'p',
        'sky-card-failed',
        'Its note did not load. Its record has it.',
      ),
    );
  }
}
