export type ChapterNode = {title: string; page: number; depth: number};

/** Stable across unrelated insertions; subtree/range changes invalidate parent results. */
export function chapterKey(documentId: string, outline: ChapterNode[], index: number): string {
  const node = outline[index];
  let boundary = outline.findIndex((n, j) => j > index && n.depth <= node.depth);
  if (boundary < 0) boundary = outline.length;
  const ancestors: string[] = [];
  let depth = node.depth;
  for (let j = index - 1; j >= 0; j--) {
    if (outline[j].depth < depth) {ancestors.unshift(outline[j].title); depth = outline[j].depth;}
  }
  const scope = outline.slice(index, boundary).map(n => [n.title, n.page, n.depth]);
  const identity = JSON.stringify([ancestors, scope, outline[boundary]?.page ?? null]);
  let digest = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(identity)) digest = BigInt.asUintN(64, (digest ^ BigInt(byte)) * 1099511628211n);
  return `${documentId}:ch-${digest.toString(16).padStart(16, '0')}`;
}

export function chapterPlan(chapters: ChapterNode[], index: number) {
  const chapter = chapters[index];
  if (!chapter) return {boundaryIndex: chapters.length, endPage: undefined as number | undefined, childIndices: [] as number[]};
  const found = chapters.findIndex((n, j) => j > index && n.depth <= chapter.depth);
  const boundaryIndex = found < 0 ? chapters.length : found;
  const descendants = chapters.slice(index + 1, boundaryIndex);
  const depth = descendants.length ? Math.min(...descendants.map(n => n.depth)) : -1;
  return {boundaryIndex, endPage: chapters[boundaryIndex] ? Math.max(chapter.page, chapters[boundaryIndex].page - 1) : undefined,
    childIndices: descendants.flatMap((n, j) => n.depth === depth ? [index + j + 1] : [])};
}
