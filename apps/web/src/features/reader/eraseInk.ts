import type {HighlightRect} from '../../api';

type Point = {x: number; y: number};
type Interval = [number, number];
const EPS = 1e-9;
const interpolate = (a: HighlightRect, b: HighlightRect, t: number): HighlightRect => ({
  ...a, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
});

// Match the quadratic curves used by smoothAnnotationPath before cutting them.
function flatten(rects: HighlightRect[], ratio: number): HighlightRect[] {
  const points = [rects[0]];
  for (let i = 1; i < rects.length - 1; i++) {
    const start = points[points.length - 1], control = rects[i];
    const end = interpolate(control, rects[i + 1], .5);
    const bend = Math.hypot((start.x - 2 * control.x + end.x) * ratio, start.y - 2 * control.y + end.y);
    const steps = Math.max(1, Math.ceil(Math.sqrt(bend / .002)));
    for (let j = 1; j <= steps; j++) {
      const t = j / steps, s = 1 - t;
      points.push({...control, x: s * s * start.x + 2 * s * t * control.x + t * t * end.x, y: s * s * start.y + 2 * s * t * control.y + t * t * end.y});
    }
  }
  if (rects.length > 1) points.push(rects[rects.length - 1]);
  return points;
}

function circle(a: Point, delta: Point, center: Point, radius: number): Interval | null {
  const x = a.x - center.x, y = a.y - center.y;
  const length = delta.x * delta.x + delta.y * delta.y;
  if (length < EPS * EPS) return Math.hypot(x, y) <= radius ? [0, 1] : null;
  const dot = x * delta.x + y * delta.y;
  const discriminant = dot * dot - length * (x * x + y * y - radius * radius);
  if (discriminant <= 0) return null;
  const root = Math.sqrt(discriminant);
  const from = Math.max(0, (-dot - root) / length), to = Math.min(1, (-dot + root) / length);
  return to - from > EPS ? [from, to] : null;
}

function slab(range: Interval, position: number, speed: number, low: number, high: number): boolean {
  if (Math.abs(speed) < EPS) return position >= low && position <= high;
  const a = (low - position) / speed, b = (high - position) / speed;
  range[0] = Math.max(range[0], Math.min(a, b));
  range[1] = Math.min(range[1], Math.max(a, b));
  return range[1] - range[0] > EPS;
}

// A dragged eraser sweeps a capsule, including the space between pointer samples.
function capsule(a: Point, delta: Point, start: Point, end: Point, radius: number): Interval[] {
  const ranges: Interval[] = [];
  const first = circle(a, delta, start, radius), last = circle(a, delta, end, radius);
  if (first) ranges.push(first);
  if (last) ranges.push(last);
  const dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy);
  if (length > EPS) {
    const ux = dx / length, uy = dy / length, x = a.x - start.x, y = a.y - start.y;
    const range: Interval = [0, 1];
    if (slab(range, x * ux + y * uy, delta.x * ux + delta.y * uy, 0, length)
      && slab(range, -x * uy + y * ux, -delta.x * uy + delta.y * ux, -radius, radius)) ranges.push(range);
  }
  return ranges;
}

/** Cut only ink touched by the gesture; null means no change, [] means fully erased. */
export function eraseInk(rects: HighlightRect[], gesture: Point[], dimensions: {width: number; height: number}): HighlightRect[][] | null {
  if (!rects.length || !gesture.length) return null;
  const ratio = dimensions.width / Math.max(1, dimensions.height);
  const radius = Math.max(.009, (rects[0].width || .004) * 1.8);
  const metric = (p: Point): Point => ({x: p.x * ratio, y: p.y});
  const eraser = gesture.map(metric), points = flatten(rects, ratio);
  if (points.length === 1) points.push(points[0]);
  const segments: HighlightRect[][] = [];
  let segment: HighlightRect[] = [], changed = false;
  const flush = () => {
    // Each persisted highlight accepts at most 1200 points. Overlap at boundaries.
    for (let i = 0; i < segment.length - 1; i += 1199) segments.push(segment.slice(i, i + 1200));
    segment = [];
  };
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1], to = points[i], a = metric(from), b = metric(to);
    const delta = {x: b.x - a.x, y: b.y - a.y};
    const ranges: Interval[] = [];
    if (eraser.length === 1) {
      const range = circle(a, delta, eraser[0], radius);
      if (range) ranges.push(range);
    } else for (let j = 1; j < eraser.length; j++) ranges.push(...capsule(a, delta, eraser[j - 1], eraser[j], radius));
    ranges.sort((x, y) => x[0] - y[0]);
    let cursor = 0;
    for (const [start, end] of ranges) {
      if (end <= cursor) continue;
      changed = true;
      if (start > cursor + EPS) {
        segment.push(interpolate(from, to, cursor), interpolate(from, to, start));
        flush();
      } else if (segment.length) flush();
      cursor = Math.max(cursor, end);
    }
    if (cursor < 1 - EPS) segment.push(interpolate(from, to, cursor), to);
    else flush();
  }
  flush();
  return changed ? segments : null;
}
