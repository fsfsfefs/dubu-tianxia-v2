import {useEffect, useRef, useState, type CSSProperties, type PointerEvent} from 'react';
import type {PDFDocumentProxy} from 'pdfjs-dist';
import type {useDraftInk} from './useDraftInk';
import {AnnotationLayer} from '../reader/AnnotationLayer';
import type {DraftLink, DraftRect} from './chapterDrafts';

export const defaultDraftRect: DraftRect = {x: .05, y: .05, width: .28, height: .06};
export const draftLinkLabel = (link: {label: string; page: number}) => link.label || `教材 PDF 第 ${link.page} 页`;
type Point = {x: number; y: number};

function locate(event: PointerEvent<HTMLDivElement>): Point {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))};
}

function dragRect(start: Point, end: Point, size: DraftRect): DraftRect {
  const width = Math.abs(start.x - end.x), height = Math.abs(start.y - end.y);
  if (width < .012 && height < .012) {
    return {x: Math.min(start.x, 1 - size.width), y: Math.min(start.y, 1 - size.height), width: size.width, height: size.height};
  }
  const w = Math.max(.01, width), h = Math.max(.01, height);
  return {x: Math.min(start.x, end.x, 1 - w), y: Math.min(start.y, end.y, 1 - h), width: w, height: h};
}

function rectStyle(rect: DraftRect): CSSProperties {
  return {left: rect.x * 100 + '%', top: rect.y * 100 + '%', width: rect.width * 100 + '%', height: rect.height * 100 + '%'};
}

export function DraftPdfSheet({pdf, number, aspect, renderWidth, visible, links, editing, rect, ink, onAspect, onPlace, onJump}: {
  pdf: PDFDocumentProxy; number: number; aspect: number; renderWidth: number; visible: boolean;
  links: DraftLink[]; editing: boolean; rect?: DraftRect; ink: ReturnType<typeof useDraftInk>;
  onAspect: (number: number, aspect: number) => void; onPlace: (rect: DraftRect) => void;
  onJump: (page: number, label: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stroke = useRef<{id: number; start: Point} | null>(null);
  const [preview, setPreview] = useState<DraftRect>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!visible) return;
    let live = true;
    let render: ReturnType<Awaited<ReturnType<typeof pdf.getPage>>['render']> | undefined;
    void pdf.getPage(number).then(page => {
      if (!live || !canvas.current) return;
      const base = page.getViewport({scale: 1});
      onAspect(number, base.width / base.height);
      const pixels = renderWidth * (window.devicePixelRatio || 1);
      const viewport = page.getViewport({scale: Math.min(pixels / base.width || 1, 3200 / Math.max(base.width, base.height))});
      canvas.current.width = Math.ceil(viewport.width);
      canvas.current.height = Math.ceil(viewport.height);
      render = page.render({canvas: canvas.current, viewport});
      return render.promise;
    }).catch(reason => {if (live) setError(reason instanceof Error ? reason.message : '无法预览此页。');});
    return () => {live = false; render?.cancel();};
  }, [pdf, number, visible, onAspect, renderWidth]);

  const drawing = editing && visible;
  const box = preview ?? rect;
  return <div className={`chapter-draft-sheet${drawing ? ' placing' : ''}`} data-page-number={number} style={{aspectRatio: aspect}}
    onPointerDown={event => {
      if (!drawing || event.button !== 0 || stroke.current) return;
      stroke.current = {id: event.pointerId, start: locate(event)};
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const active = stroke.current;
      if (active?.id === event.pointerId) setPreview(dragRect(active.start, locate(event), rect ?? defaultDraftRect));
    }}
    onPointerUp={event => {
      const active = stroke.current;
      if (active?.id !== event.pointerId) return;
      stroke.current = null;
      setPreview(undefined);
      onPlace(dragRect(active.start, locate(event), rect ?? defaultDraftRect));
    }}
    onLostPointerCapture={event => {
      if (stroke.current?.id !== event.pointerId) return;
      stroke.current = null;
      setPreview(undefined);
    }}>
    {visible && (error ? <p role="alert">{error}</p> : <canvas ref={canvas} aria-label={`导入稿第 ${number} 页`}/>)}
    {visible && links.map(link => link.rect && <button key={link.id} type="button" className="chapter-draft-overlay" style={rectStyle(link.rect)}
      title={`${draftLinkLabel(link)} · 教材 PDF ${link.page}`} disabled={drawing}
      onClick={() => onJump(link.page, draftLinkLabel(link))}>{draftLinkLabel(link)}</button>)}
    {visible && <AnnotationLayer documentId={ink.id} page={number}
      dimensions={{width: 1000, height: 1000 / aspect}} zoom={renderWidth / 1000}
      highlights={ink.highlights.filter(item => item.page_number === number)}
      tool={ink.loaded && !editing ? ink.tools.annotationTool : null}
      color={ink.tools.annotationColor} width={ink.tools.annotationWidth}
      eraserSize={ink.tools.eraserSize} penOnly={ink.tools.penOnly}
      draft={ink.annotations.annotationDraft} onDraft={ink.annotations.setAnnotationDraft}
      onSave={(page, points, style) => {void ink.annotations.saveInkAnnotation(page, points, style);}}
      onErase={(page, points, dimensions, radius) => ink.annotations.eraseInkAt(page, points, dimensions, radius)}/>}
    {visible && box && <span className="chapter-draft-outline" style={rectStyle(box)} aria-hidden="true"/>}
  </div>;
}
