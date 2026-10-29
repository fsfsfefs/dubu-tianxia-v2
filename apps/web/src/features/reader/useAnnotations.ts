import {useEffect, useRef, useState} from 'react';
import {createHighlight, deleteHighlight, updateHighlight, type Highlight, type HighlightRect} from '../../api';
import type {Dispatch, SetStateAction} from 'react';
import type {AnnotationTool, AnnotationPoint, AnnotationDraft, AnnotationUndoAction, SelectionState} from '../../PdfPages';
import {useDocumentScope} from '../../shared/useDocumentScope';
const INK_TAG = '__ink__';

export function useAnnotations(document: {id: string}, highlights: Highlight[], setHighlights: Dispatch<SetStateAction<Highlight[]>>, initialPageDimensions: {width: number; height: number}, setError: (message: string) => void) {
  const capture = useDocumentScope(document.id);
  const annotationUndoStack = useRef<AnnotationUndoAction[]>([]);
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>(null);
  const [annotationColor, setAnnotationColor] = useState<Highlight['color']>('blue');
  const [annotationWidth, setAnnotationWidth] = useState(.004);
  const [annotationDraft, setAnnotationDraft] = useState<AnnotationDraft | null>(null);
  const [annotationToolbarOpen, setAnnotationToolbarOpen] = useState(false);
  const [annotationUndoDepth, setAnnotationUndoDepth] = useState(0);
  const [highlightQuery, setHighlightQuery] = useState('');
  const [editingHighlight, setEditingHighlight] = useState<string | null>(null);
  const [highlightComment, setHighlightComment] = useState('');
  const [highlightTags, setHighlightTags] = useState('');
  useEffect(() => {annotationUndoStack.current = []; setAnnotationUndoDepth(0); setAnnotationDraft(null); setEditingHighlight(null);}, [document.id]);
  const saveTextHighlight = async (selection: SelectionState, onSaved: () => void) => {
    if (!selection) return;
    const valid = capture();
    try {
      const highlight = await createHighlight(document.id, {page_number: selection.page, text: selection.text, rects: selection.rects, color: 'yellow', comment: '', tags: []});
      if (!valid()) return;
      setHighlights(items => [...items, highlight]); onSaved();
    } catch (reason) {if (valid()) setError(reason instanceof Error ? reason.message : '保存高亮失败');}
  };

  const recolorHighlight = async (item: Highlight, color: Highlight['color']) => {
    const valid = capture();
    try {
      const updated = await updateHighlight(document.id, item.id, {color, comment: item.comment || '', tags: item.tags || []});
      if (!valid()) return;
      setHighlights(items => items.map(value => value.id === item.id ? updated : value));
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : '高亮更新失败'); }
  };

  const saveHighlightDetails = async (item: Highlight) => {
    const valid = capture();
    try {
      const tags = [...new Set(highlightTags.split(/[，,]/).map(tag => tag.trim()).filter(Boolean))].slice(0, 30);
      const updated = await updateHighlight(document.id, item.id, {color: item.color, comment: highlightComment.trim(), tags});
      if (!valid()) return;
      setHighlights(items => items.map(value => value.id === item.id ? updated : value));
      setEditingHighlight(null);
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : '高亮备注保存失败'); }
  };

  const removeHighlight = async (item: Highlight) => {
    const valid = capture();
    try {
      await deleteHighlight(document.id, item.id);
      if (!valid()) return;
      setHighlights(items => items.filter(value => value.id !== item.id));
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : '高亮删除失败'); }
  };

  const pushAnnotationUndo = (action: AnnotationUndoAction) => {
    annotationUndoStack.current.push(action);
    if (annotationUndoStack.current.length > 80) annotationUndoStack.current.shift();
    setAnnotationUndoDepth(annotationUndoStack.current.length);
  };

  const createInkSegment = (page: number, rects: HighlightRect[], color: Highlight['color'], tags: string[]) => createHighlight(document.id, {
    page_number: page,
    text: `手写标注 · PDF 第 ${page} 页`,
    rects,
    color,
    comment: '',
    tags,
  });

  const saveInkAnnotation = async (page: number, points: AnnotationPoint[]) => {
    const kind = annotationTool === 'marker' ? 'marker' : 'pen';
    const sampled = points.length <= 1200 ? points : points.filter((_, index) => index % Math.ceil(points.length / 1200) === 0).slice(0, 1200);
    const valid = capture();
    try {
      const annotation = await createInkSegment(page, sampled.map(point => ({...point, width: annotationWidth, height: annotationWidth})), annotationColor, [INK_TAG, kind]);
      if (!valid()) return;
      setHighlights(items => [...items, annotation]);
      pushAnnotationUndo({type: 'add', addedIds: [annotation.id]});
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : '标注保存失败'); }
  };

  const eraseInkAt = async (item: Highlight, point: AnnotationPoint) => {
    if (!item.rects.length) return;
    const pageRatio = initialPageDimensions.width / Math.max(initialPageDimensions.height, 1);
    const radius = Math.max(.009, (item.rects[0]?.width || .004) * 1.8);
    const segments: HighlightRect[][] = [];
    let segment: HighlightRect[] = [];
    for (const value of item.rects) {
      const distance = Math.hypot((value.x - point.x) * pageRatio, value.y - point.y);
      if (distance <= radius) {
        if (segment.length > 1) segments.push(segment);
        segment = [];
      } else {
        segment.push(value);
      }
    }
    if (segment.length > 1) segments.push(segment);
    if (segments.length === 1 && segments[0].length === item.rects.length) return;
    const valid = capture();
    try {
      await deleteHighlight(document.id, item.id);
      const replacements = await Promise.all(segments.map(rects => createInkSegment(item.page_number, rects, item.color, item.tags)));
      if (!valid()) return;
      setHighlights(items => [...items.filter(value => value.id !== item.id), ...replacements]);
      pushAnnotationUndo({type: 'erase', addedIds: replacements.map(value => value.id), removed: item});
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : '局部擦除失败'); }
  };

  const undoAnnotation = async () => {
    const action = annotationUndoStack.current.pop();
    if (!action) return;
    setAnnotationUndoDepth(annotationUndoStack.current.length);
    const valid = capture();
    try {
      await Promise.all(action.addedIds.map(id => deleteHighlight(document.id, id)));
      let restored: Highlight | null = null;
      if (action.type === 'erase' && action.removed) {
        restored = await createInkSegment(action.removed.page_number, action.removed.rects, action.removed.color, action.removed.tags);
      }
      if (!valid()) return;
      setHighlights(items => {
        const remaining = items.filter(item => !action.addedIds.includes(item.id));
        return restored ? [...remaining, restored] : remaining;
      });
    } catch (reason) {
      if (!valid()) return;
      annotationUndoStack.current.push(action);
      setAnnotationUndoDepth(annotationUndoStack.current.length);
      setError(reason instanceof Error ? reason.message : '撤销标注失败');
    }
  };

  const togglePageMark = async (page: number) => {
    const existing = highlights.find(item => item.page_number === page && item.rects.length === 0);
    const valid = capture();
    try {
      if (existing) {
        await deleteHighlight(document.id, existing.id);
        if (!valid()) return;
      setHighlights(items => items.filter(item => item.id !== existing.id));
      } else {
        const marker = await createHighlight(document.id, {
          page_number: page, text: `整页星标 · PDF 第 ${page} 页`, rects: [], color: 'yellow', comment: '', tags: ['星标'],
        });
        if (!valid()) return;
      setHighlights(items => [...items, marker]);
      }
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : '整页星标更新失败'); }
  };

  useEffect(() => {
    if (!annotationToolbarOpen) return;
    const handleUndoShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      if (event.ctrlKey && !event.shiftKey && event.key.toLocaleLowerCase() === 'z') {
        event.preventDefault();
        void undoAnnotation();
      }
    };
    window.addEventListener('keydown', handleUndoShortcut);
    return () => window.removeEventListener('keydown', handleUndoShortcut);
  }, [document.id, annotationToolbarOpen, annotationUndoDepth]);
  return {annotationTool, setAnnotationTool, annotationColor, setAnnotationColor, annotationWidth, setAnnotationWidth, annotationDraft, setAnnotationDraft, annotationToolbarOpen, setAnnotationToolbarOpen, annotationUndoDepth,
    highlightQuery, setHighlightQuery, editingHighlight, setEditingHighlight, highlightComment, setHighlightComment, highlightTags, setHighlightTags,
    saveTextHighlight, recolorHighlight, saveHighlightDetails, removeHighlight, saveInkAnnotation, eraseInkAt, undoAnnotation, togglePageMark};
}
