import type {HighlightRect} from '../../api';

export function smoothAnnotationPath(points: Array<Pick<HighlightRect, 'x' | 'y'>>): string {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x * 1000} ${points[0].y * 1000}`;
  let path = `M ${points[0].x * 1000} ${points[0].y * 1000}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    path += ` Q ${point.x * 1000} ${point.y * 1000} ${(point.x + next.x) * 500} ${(point.y + next.y) * 500}`;
  }
  const last = points[points.length - 1];
  return `${path} L ${last.x * 1000} ${last.y * 1000}`;
}
