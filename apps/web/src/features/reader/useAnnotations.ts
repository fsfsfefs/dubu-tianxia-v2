import {useEffect, useRef, useState} from 'react';
import {createHighlight, deleteHighlight, updateHighlight, type Highlight, type HighlightRect} from '../../api';
import type {Dispatch, SetStateAction} from 'react';
import type {AnnotationTool, AnnotationPoint, AnnotationDraft, AnnotationUndoAction, SelectionState} from '../../PdfPages';
import {useDocumentScope} from '../../shared/useDocumentScope';
import {eraseInk} from './eraseInk';
import {readAnnotationInput, saveAnnotationInput} from './annotationInput';
import type {InkStyle} from './AnnotationLayer';
const INK_TAG = '__ink__';

export function useAnnotations(document: {id: string}, highlights: Highlight[], setHighlights: Dispatch<SetStateAction<Highlight[]>>, setError: (message: string) => void) {
  const capture = useDocumentScope(document.id);
  const annotationUndoStack = useRef<AnnotationUndoAction[]>([]);
  const inkQueue = useRef(Promise.resolve());
  const currentHighlights = useRef(highlights);
  currentHighlights.current = highlights;
  const commitInk = (change: (items: Highlight[]) => Highlight[]) => {
    currentHighlights.current = change(currentHighlights.current);
    setHighlights(change);
  };
  const enqueueInk = (valid: () => boolean, operation: () => Promise<void>) => {
    const task = inkQueue.current.then(async () => {if (valid()) await operation();});
    inkQueue.current = task.catch(() => undefined);
    return task;
  };
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>(null);
  const [annotationColor, setAnnotationColor] = useState<Highlight['color']>('blue');
  const [annotationWidth, setAnnotationWidth] = useState(.004);
  const [inputDefaults] = useState(readAnnotationInput);
  const [eraserSize, setEraserSize] = useState(inputDefaults.eraserSize);
  const [penOnly, setPenOnly] = useState(inputDefaults.penOnly);
  useEffect(() => {saveAnnotationInput(eraserSize, penOnly);}, [eraserSize, penOnly]);
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

  const createInkSegment = (page: number, rects: HighlightRect[], color: Highlight['color'], tags: string[], comment = '') => createHighlight(document.id, {
    page_number: page,
    text: `手写标注 · PDF 第 ${page} 页`,
    rects,
    color,
    comment,
    tags,
  });

  const saveInkAnnotation = async (page: number, points: AnnotationPoint[], style?: InkStyle) => {
    const kind = style?.tool || (annotationTool === 'marker' ? 'marker' : 'pen');
    const width = style?.width ?? annotationWidth, color = style?.color ?? annotationColor;
    const sampled = points.length <= 1200 ? points : points.filter((_, index) => index % Math.ceil(points.length / 1200) === 0).slice(0, 1200);
    const valid = capture();
    return enqueueInk(valid, async () => {
      try {
        const annotation = await createInkSegment(page, sampled.map(point => ({...point, width, height: width})), color, [INK_TAG, kind]);
        if (!valid()) return;
        commitInk(items => [...items, annotation]);
        pushAnnotationUndo({type: 'add', addedIds: [annotation.id]});
      } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : '标注保存失败'); }
    });
  };

  const eraseInkAt = async (page: number, points: AnnotationPoint[], dimensions: {width: number; height: number}, radius?: number) => {
    const valid = capture();
    return enqueueInk(valid, async () => {
      const removed: Highlight[] = [], addedIds: string[] = [];
      try {
        for (const item of currentHighlights.current.filter(value => value.page_number === page && value.tags?.includes(INK_TAG))) {
          const segments = eraseInk(item.rects, points, dimensions, radius);
          if (!segments) continue;
          const replacements: Highlight[] = [];
          try {
            // Keep the original until every replacement is saved successfully.
            for (const rects of segments) replacements.push(await createInkSegment(page, rects, item.color, item.tags, item.comment));
            await deleteHighlight(document.id, item.id);
          } catch (reason) {
            await Promise.allSettled(replacements.map(value => deleteHighlight(document.id, value.id)));
            throw reason;
          }
          if (!valid()) return;
          commitInk(items => [...items.filter(value => value.id !== item.id), ...replacements]);
          removed.push(item); addedIds.push(...replacements.map(value => value.id));
        }
      } catch (reason) {if (valid()) setError(reason instanceof Error ? reason.message : '局部擦除失败');}
      finally {if (valid() && removed.length) pushAnnotationUndo({type: 'erase', addedIds, removed});}
    });
  };

  const undoAnnotation = async () => {
    const valid = capture();
    return enqueueInk(valid, async () => {
      const action = annotationUndoStack.current.pop();
      if (!action) return;
      setAnnotationUndoDepth(annotationUndoStack.current.length);
      const restored: Highlight[] = [];
      try {
        for (const item of action.removed || []) restored.push(await createInkSegment(item.page_number, item.rects, item.color, item.tags, item.comment));
        await Promise.all(action.addedIds.map(id => deleteHighlight(document.id, id)));
        if (!valid()) return;
        // Older undo entries refer to the original IDs, which restoration replaces.
        const ids = new Map((action.removed || []).map((item, index) => [item.id, restored[index].id]));
        for (const previous of annotationUndoStack.current) previous.addedIds = previous.addedIds.map(id => ids.get(id) || id);
        commitInk(items => {
          const remaining = items.filter(item => !action.addedIds.includes(item.id));
          return [...remaining, ...restored];
        });
      } catch (reason) {
        await Promise.allSettled(restored.map(item => deleteHighlight(document.id, item.id)));
        if (!valid()) return;
        annotationUndoStack.current.push(action);
        setAnnotationUndoDepth(annotationUndoStack.current.length);
        setError(reason instanceof Error ? reason.message : '撤销标注失败');
      }
    });
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
  return {annotationTool, setAnnotationTool, annotationColor, setAnnotationColor, annotationWidth, setAnnotationWidth, eraserSize, setEraserSize, penOnly, setPenOnly, annotationDraft, setAnnotationDraft, annotationToolbarOpen, setAnnotationToolbarOpen, annotationUndoDepth,
    highlightQuery, setHighlightQuery, editingHighlight, setEditingHighlight, highlightComment, setHighlightComment, highlightTags, setHighlightTags,
    saveTextHighlight, recolorHighlight, saveHighlightDetails, removeHighlight, saveInkAnnotation, eraseInkAt, undoAnnotation, togglePageMark};
}
