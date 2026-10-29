import type {SearchResult} from '../../PdfPages';
export function matchPageText(page: number, sourceText: string, needle: string): SearchResult | null {
  const text = sourceText.replace(/\s+/g, ' ').trim();
  const normalized = text.toLocaleLowerCase();
  const compactNeedle = needle.replace(/\s+/g, '');
  const directIndex = normalized.indexOf(needle);
  let sourceIndex = directIndex;

  if (sourceIndex < 0 && compactNeedle) {
    const compactIndex = normalized.replace(/\s+/g, '').indexOf(compactNeedle);
    if (compactIndex < 0) return null;
    let compactOffset = 0;
    sourceIndex = 0;
    while (sourceIndex < normalized.length && compactOffset < compactIndex) {
      if (!/\s/.test(normalized[sourceIndex])) compactOffset += 1;
      sourceIndex += 1;
    }
  }

  if (sourceIndex < 0) return null;
  const start = Math.max(0, sourceIndex - 34);
  const end = Math.min(text.length, sourceIndex + Math.max(needle.length, 70));
  return {
    page,
    snippet: `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
  };
}
