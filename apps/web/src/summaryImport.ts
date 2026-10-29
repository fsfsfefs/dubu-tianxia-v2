import {chapterKey} from './chapters';
import type {ChapterSummary} from './api';
import type {OutlineEntry} from './pdfOutline';

type Section = {
  title: string;
  depth: number;
  startPage?: number;
  endPage?: number;
  content: string;
};

export type LearningStructureImport = {
  outline: OutlineEntry[];
  summaries: Array<Omit<ChapterSummary, 'updated_at'>>;
  recognizedChapters: number;
  importedSummaries: number;
};

const genericSummaryHeading = /^(?:全书定位|总体知识地图|各大章内容与关系|核心主线|学习与复习路线|本章定位|大章定位|子章结构与关系|核心知识体系|本节定位|知识结构|核心概念与关系|重点与易混点|复习提纲|复习路径|总结|摘要)$/i;
const numberedChapter = /^(?:PART\s+[IVXLC\d]+|第[一二三四五六七八九十百零〇\d]+[篇部章节]|(?:\d+\.)+\d*|\d+[、.])\s*/i;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
    if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed);
  }
  return undefined;
}

function pageRange(value: string): {start?: number; end?: number} {
  const patterns = [
    /\bPDF\s*(?:第\s*)?(\d+)\s*(?:[-–—~至到]\s*(\d+))?/i,
    /第\s*(\d+)\s*(?:[-–—~至到]\s*(\d+))?\s*页/,
    /[（(\[]\s*(\d+)\s*(?:[-–—~至到]\s*(\d+))?\s*页?\s*[）)\]]\s*$/,
  ];
  for (const pattern of patterns) {
    const matched = value.match(pattern);
    if (matched) return {start: Number(matched[1]), end: matched[2] ? Number(matched[2]) : undefined};
  }
  return {};
}

function cleanTitle(value: string): string {
  return value
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/\s*\bPDF\s*(?:第\s*)?\d+\s*(?:[-–—~至到]\s*\d+)?\s*$/i, '')
    .replace(/\s*第\s*\d+\s*(?:[-–—~至到]\s*\d+)?\s*页\s*$/, '')
    .replace(/\s*[（(\[]\s*\d+\s*(?:[-–—~至到]\s*\d+)?\s*页?\s*[）)\]]\s*$/, '')
    .trim();
}

function normalizedTitle(value: string): string {
  return cleanTitle(value).toLocaleLowerCase().replace(/[\s，。！？；：、“”‘’（）()【】\[\]《》<>…·—_\-]/g, '');
}

function titleCore(value: string): string {
  return normalizedTitle(value).replace(/^(?:part[ivxlc\d]+|第[一二三四五六七八九十百零〇\d]+[篇部章节]|(?:\d+\.)+\d*|\d+[、.]?)/i, '');
}

function outlineMatch(title: string, outline: OutlineEntry[], used = new Set<number>()): number {
  const normalized = normalizedTitle(title);
  const core = titleCore(title);
  let best = -1;
  let score = 0;
  outline.forEach((item, index) => {
    if (used.has(index)) return;
    const candidate = normalizedTitle(item.title);
    const candidateCore = titleCore(item.title);
    const nextScore = normalized === candidate ? 1000
      : core.length >= 2 && core === candidateCore ? 900
        : Math.min(normalized.length, candidate.length) >= 4 && (normalized.includes(candidate) || candidate.includes(normalized)) ? 600 + Math.min(normalized.length, candidate.length)
          : 0;
    if (nextScore > score) { score = nextScore; best = index; }
  });
  return best;
}

function inferredDepth(title: string, headingDepth: number): number {
  const compact = cleanTitle(title);
  const dotted = compact.match(/^(\d+(?:\.\d+)+)/)?.[1];
  if (dotted) return Math.max(0, dotted.split('.').length - 1);
  if (/^第.+节/.test(compact)) return 1;
  if (/^(?:PART\s+|第.+[篇部章])/.test(compact)) return 0;
  return Math.max(0, headingDepth);
}

function parseMarkdown(text: string, existingOutline: OutlineEntry[]): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  const flush = () => {
    if (!current) return;
    current.content = current.content.trim();
    sections.push(current);
    current = null;
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    const plain = !heading && line.trim().length <= 160 && numberedChapter.test(line.trim()) ? line.trim() : '';
    if (heading || plain) {
      const rawTitle = heading ? heading[2] : plain;
      const title = cleanTitle(rawTitle);
      const range = pageRange(rawTitle);
      const matchesOutline = outlineMatch(title, existingOutline) >= 0;
      const structural = numberedChapter.test(title) || matchesOutline || (Boolean(range.start) && !genericSummaryHeading.test(title));
      if (structural && !genericSummaryHeading.test(title)) {
        flush();
        const headingDepth = heading ? heading[1].length - 1 : 0;
        current = {title, depth: inferredDepth(title, headingDepth), startPage: range.start, endPage: range.end, content: ''};
        continue;
      }
    }
    if (current) current.content += `${line}\n`;
  }
  flush();
  return sections;
}

function parseJson(text: string): {sections: Section[]; bookContent: string} | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const root = record(parsed);
  if (!root) return null;
  const sections: Section[] = [];
  const flatten = (items: unknown, parentDepth = 0) => {
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      const item = record(raw);
      if (!item) continue;
      const title = String(item.title ?? item.name ?? item.chapter ?? '').trim();
      if (!title) continue;
      const depth = Math.max(0, Number.isFinite(Number(item.depth)) ? Number(item.depth) : parentDepth);
      const content = String(item.summary ?? item.content ?? item.description ?? '').trim();
      sections.push({
        title: cleanTitle(title), depth,
        startPage: numberValue(item.start_page, item.startPage, item.page, item.page_number),
        endPage: numberValue(item.end_page, item.endPage),
        content,
      });
      flatten(item.children ?? item.sections ?? item.chapters, depth + 1);
    }
  };
  flatten(root.chapters ?? root.sections ?? root.outline ?? root.summaries);
  const book = record(root.book);
  const bookContent = String(root.book_summary ?? root.bookSummary ?? book?.content ?? book?.summary ?? root.content ?? '').trim();
  return {sections, bookContent};
}

function locallyBuildBookContent(sections: Section[]): string {
  return sections.map(section => {
    const page = section.startPage ? `（PDF ${section.startPage}${section.endPage && section.endPage !== section.startPage ? `-${section.endPage}` : ''}）` : '';
    return `${'#'.repeat(Math.min(6, section.depth + 2))} ${section.title}${page}\n\n${section.content}`.trim();
  }).join('\n\n');
}

export function parseLearningStructureImport(
  text: string,
  documentId: string,
  existingOutline: OutlineEntry[],
): LearningStructureImport {
  const json = parseJson(text);
  const rawSections = json?.sections.length ? json.sections : parseMarkdown(text, existingOutline);
  const used = new Set<number>();
  let previousPage = 1;
  const resolved = rawSections.map(section => {
    const matchedIndex = outlineMatch(section.title, existingOutline, used);
    if (matchedIndex >= 0) used.add(matchedIndex);
    const matched = matchedIndex >= 0 ? existingOutline[matchedIndex] : undefined;
    const page = section.startPage || matched?.page || previousPage;
    previousPage = Math.max(previousPage, page);
    return {...section, startPage: page, depth: matched?.depth ?? section.depth};
  });
  const useImportedOutline = resolved.length >= 2 || existingOutline.length === 0 && resolved.length > 0;
  const outline: OutlineEntry[] = useImportedOutline
    ? resolved.map(item => ({title: item.title, page: item.startPage || 1, depth: item.depth}))
    : existingOutline;
  const summaries: Array<Omit<ChapterSummary, 'updated_at'>> = [];
  const importedIndex = (section: Section, position: number) => useImportedOutline
    ? position
    : outlineMatch(section.title, outline);
  resolved.forEach((section, position) => {
    const index = importedIndex(section, position);
    if (index < 0 || !section.content.trim()) return;
    const startPage = outline[index]?.page || section.startPage || 1;
    const boundary = outline.slice(index + 1).find(item => item.depth <= outline[index].depth && item.page > startPage);
    const endPage = Math.max(startPage, section.endPage || (boundary ? boundary.page - 1 : Math.max(...outline.map(item => item.page), startPage)));
    summaries.push({chapter_key: chapterKey(documentId, outline, index), title: outline[index].title, start_page: startPage, end_page: endPage, depth: outline[index].depth, content: section.content.trim()});
  });
  const bookContent = (json?.bookContent || (json ? locallyBuildBookContent(resolved) : text)).trim();
  if (bookContent) {
    const startPage = Math.min(...outline.map(item => item.page), 1);
    const endPage = Math.max(...outline.map(item => item.page), ...resolved.map(item => item.endPage || item.startPage || 1), 1);
    summaries.push({chapter_key: `${documentId}:__book__`, title: '全书知识结构', start_page: startPage, end_page: endPage, depth: 0, content: bookContent});
  }
  if (!bookContent && !summaries.length) throw new Error('文件中没有识别到可导入的全书结构或章节总结。');
  return {outline, summaries, recognizedChapters: resolved.length, importedSummaries: summaries.filter(item => !item.chapter_key.endsWith(':__book__')).length};
}
