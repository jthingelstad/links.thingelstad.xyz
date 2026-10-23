// Geometry for the statistics page's charts (src/components/stats/), drawn as
// inline SVG at build: no chart library and no script. These helpers return
// numbers and path strings. Every chart uses one fixed viewBox width that
// scales with its grid column (about 468px on a 500px phone, 512px in the
// two-column desktop grid, at most 640px), so 15-unit text never renders
// below 14px, the family's smallest size.
export const WIDTH = 500;

// Coordinates to one decimal: smaller HTML, no visible difference.
export const r1 = (n: number) => Math.round(n * 10) / 10;

export function niceStep(raw: number) {
  const power = 10 ** Math.floor(Math.log10(raw));
  const f = raw / power;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * power;
}

// Axis ticks from zero to a round number at or above max.
export function ticks(max: number, target = 4) {
  if (!(max > 0)) return [0, 1];
  const step = niceStep(max / target);
  const count = Math.ceil(max / step - 1e-9);
  return Array.from({ length: count + 1 }, (_, i) =>
    Number((i * step).toFixed(10)),
  );
}

// Axis labels: compact from 1,000 up (1K, 1.5K).
export function compact(n: number) {
  if (Math.abs(n) < 1000) return String(n);
  const k = n / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
}

// A column, square at the baseline and 4px round at the data end.
export function columnPath(x: number, y: number, w: number, h: number, r = 4) {
  if (!(h > 0 && w > 0)) return '';
  const q = Math.min(r, w / 2, h);
  return `M${r1(x)},${r1(y + h)}V${r1(y + q)}Q${r1(x)},${r1(y)} ${r1(x + q)},${r1(y)}H${r1(x + w - q)}Q${r1(x + w)},${r1(y)} ${r1(x + w)},${r1(y + q)}V${r1(y + h)}Z`;
}
// A segment inside a stack: square all round.
export function rectPath(x: number, y: number, w: number, h: number) {
  if (!(h > 0 && w > 0)) return '';
  return `M${r1(x)},${r1(y)}H${r1(x + w)}V${r1(y + h)}H${r1(x)}Z`;
}
// A horizontal bar from the baseline at x, 4px round at the data end.
export function barPath(x: number, y: number, w: number, h: number, r = 4) {
  if (!(h > 0 && w > 0)) return '';
  const q = Math.min(r, h / 2, w);
  return `M${r1(x)},${r1(y)}H${r1(x + w - q)}Q${r1(x + w)},${r1(y)} ${r1(x + w)},${r1(y + q)}V${r1(y + h - q)}Q${r1(x + w)},${r1(y + h)} ${r1(x + w - q)},${r1(y + h)}H${r1(x)}Z`;
}

// A generous width for 15-unit Inter text with tabular figures, to keep
// labels inside the viewBox and off each other. Bold text runs a little wider.
const narrow = new Set([
  ',',
  '.',
  ' ',
  ':',
  ';',
  '!',
  'i',
  'l',
  'I',
  'j',
  't',
  'f',
  'r',
]);
export function textWidth(text: string, size = 15, bold = false) {
  let em = 0;
  for (const ch of text) em += ch === '%' ? 0.9 : narrow.has(ch) ? 0.32 : 0.64;
  return em * size * (bold ? 1.06 : 1);
}

// The left margin a y-axis needs for its widest tick label, plus the gap
// between labels and plot.
export const axisLeft = (labels: string[], size = 15) =>
  Math.ceil(Math.max(0, ...labels.map((l) => textWidth(l, size))) + 12);

// Legend labels for heatmap classes from their breaks (stats.ts breaks()).
export function classLabels(cuts: number[], shares = false) {
  if (shares) {
    const p = (v: number) => `${Math.round(v * 100)}%`;
    return [
      `up to ${p(cuts[0])}`,
      ...cuts.slice(1).map((cut, i) => `${p(cuts[i])} to ${p(cut)}`),
      `over ${p(cuts[cuts.length - 1])}`,
    ];
  }
  const n = (v: number) => v.toLocaleString('en-US');
  return [
    cuts[0] === 1 ? '1' : `1 to ${n(cuts[0])}`,
    ...cuts
      .slice(1)
      .map((cut, i) =>
        cut === cuts[i] + 1 ? n(cut) : `${n(cuts[i] + 1)} to ${n(cut)}`,
      ),
    `${n(cuts[cuts.length - 1] + 1)} or more`,
  ];
}
