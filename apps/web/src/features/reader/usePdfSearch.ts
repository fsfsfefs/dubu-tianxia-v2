import {useEffect, useRef, useState} from 'react';
import type {PDFDocumentProxy} from 'pdfjs-dist';
import {saveOcrPage} from '../../api';
import {recognizeCanvas} from '../../ocr';
import {useDocumentScope} from '../../shared/useDocumentScope';
import {matchPageText} from './searchText';
import type {SearchResult} from '../../PdfPages';

export function usePdfSearch(documentId: string, pdf: PDFDocumentProxy | null, setError: (message: string) => void) {
  const document = {id: documentId};
  const capture = useDocumentScope(documentId);
  const searchRun = useRef(0);
  const pageTextCache = useRef(new Map<number, string>());
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchedPages, setSearchedPages] = useState(0);
  const [lastSearchQuery, setLastSearchQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  useEffect(() => {
    pageTextCache.current.clear(); setResults([]); setQuery(''); setSearching(false); setSearchedPages(0); setLastSearchQuery('');
    return () => {searchRun.current++;};
  }, [documentId]);
  const searchDocument = async () => {
    const searchTerm = query.trim();
    const needle = searchTerm.toLocaleLowerCase();
    if (!pdf || !needle) { setResults([]); return; }
    const runId = ++searchRun.current;
    const scopeValid = capture();
    const valid = () => scopeValid() && runId === searchRun.current;
    const matches: SearchResult[] = [];
    const cachedPages = Array.from(pageTextCache.current.entries())
      .filter(([page]) => page >= 1 && page <= pdf.numPages)
      .sort(([left], [right]) => left - right);
    for (const [page, text] of cachedPages) {
      const match = matchPageText(page, text, needle);
      if (match && matches.length < 80) matches.push(match);
    }
    const missingPages = Array.from({length: pdf.numPages}, (_, index) => index + 1)
      .filter(page => !pageTextCache.current.has(page));
    setError(''); setResults(matches); setSearchedPages(cachedPages.length); setLastSearchQuery(searchTerm);
    if (!missingPages.length) { setSearching(false); return; }
    setSearching(true);
    try {
      for (const pageIndex of missingPages) {
        if (!valid()) return;
        const page = await pdf.getPage(pageIndex);
        if (!valid()) return;
        const content = await page.getTextContent();
        if (!valid()) return;
        let text = content.items.map(item => 'str' in item ? item.str : '').join(' ');
        if (text.replace(/\s/g, '').length < 8) {
          const viewport = page.getViewport({scale: 1.2});
          const searchCanvas = window.document.createElement('canvas');
          searchCanvas.width = Math.ceil(viewport.width);
          searchCanvas.height = Math.ceil(viewport.height);
          const context = searchCanvas.getContext('2d');
          if (context) {
            await page.render({canvas: searchCanvas, canvasContext: context, viewport}).promise;
            if (!valid()) return;
            const words = await recognizeCanvas(searchCanvas, () => undefined);
            text = words.map(word => word.text).join(' ');
          }
        }
        if (!valid()) return;
        pageTextCache.current.set(pageIndex, text);
        void saveOcrPage(document.id, pageIndex, text).catch(() => undefined);
        const match = matchPageText(pageIndex, text, needle);
        if (match && matches.length < 80) {
          matches.push(match);
          matches.sort((left, right) => left.page - right.page);
          setResults([...matches]);
        }
        setSearchedPages(pageTextCache.current.size);
      }
      setResults(matches);
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : '搜索失败'); }
    finally { if (valid()) setSearching(false); }
  };

  const cancelSearch = () => {
    searchRun.current += 1;
    setSearching(false);
  };

  return {query, setQuery, searching, searchedPages, setSearchedPages, lastSearchQuery, setLastSearchQuery, results, setResults, searchDocument, cancelSearch, pageTextCache};
}
