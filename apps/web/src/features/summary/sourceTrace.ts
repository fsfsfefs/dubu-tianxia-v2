import type {OcrPage} from '../../api';
import type {SourceTraceLocation} from '../../PdfPages';

function normalizeTraceText(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s，。！？；：、“”‘’（）()【】\[\]《》<>…·—_\-]/g, '');
}

function traceTerms(value: string): string[] {
  const normalized = normalizeTraceText(value);
  const terms = new Set<string>();
  for (const word of value.toLocaleLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g) || []) terms.add(word);
  for (const run of normalized.match(/[\u3400-\u9fff]{2,}/g) || []) {
    if (run.length <= 8) terms.add(run);
    for (const size of [6, 5, 4, 3]) {
      if (run.length < size) continue;
      const step = size >= 5 ? 2 : 3;
      for (let index = 0; index <= run.length - size; index += step) terms.add(run.slice(index, index + size));
    }
  }
  return [...terms].sort((left, right) => right.length - left.length).slice(0, 48);
}

function traceSnippet(source: string, terms: string[]): string {
  const text = source.replace(/\s+/g, ' ').trim();
  const lower = text.toLocaleLowerCase();
  const term = terms.find(item => normalizeTraceText(text).includes(normalizeTraceText(item)));
  let index = term ? lower.indexOf(term.toLocaleLowerCase()) : 0;
  if (term && index < 0) {
    const compactIndex = normalizeTraceText(text).indexOf(normalizeTraceText(term));
    let compactOffset = 0;
    index = 0;
    while (index < text.length && compactOffset < compactIndex) {
      compactOffset += normalizeTraceText(text[index]).length;
      index += 1;
    }
  }
  const start = Math.max(0, index - 42);
  const end = Math.min(text.length, index + Math.max(term?.length || 0, 100));
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export function locateSummarySources(selection: string, pages: OcrPage[], startPage: number, endPage: number): SourceTraceLocation[] {
  const compactSelection = normalizeTraceText(selection);
  const terms = traceTerms(selection);
  const candidates = pages.filter(page => page.page_number >= startPage && page.page_number <= endPage).map(page => {
    const compactPage = normalizeTraceText(page.text);
    const exact = compactSelection.length >= 4 && compactPage.includes(compactSelection);
    const matchedTerms = terms.filter(term => compactPage.includes(normalizeTraceText(term)));
    const score = (exact ? 10000 + compactSelection.length * 20 : 0) + matchedTerms.reduce((total, term) => total + term.length * term.length, 0);
    return {page: page.page_number, snippet: traceSnippet(page.text, matchedTerms), score, exact};
  }).filter(item => item.score > 0);
  const exactMatches = candidates.filter(item => item.exact);
  if (exactMatches.length) return exactMatches.map(({page, snippet, score}) => ({page, snippet, score})).sort((a, b) => a.page - b.page);
  const maximum = Math.max(0, ...candidates.map(item => item.score));
  return candidates.filter(item => item.score >= Math.max(18, maximum * .52)).sort((a, b) => b.score - a.score || a.page - b.page).slice(0, 12).map(({page, snippet, score}) => ({page, snippet, score}));
}
