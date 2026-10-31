import {useEffect, useRef, useState} from 'react';
import type {Highlight, HighlightRect} from '../../api';
import type {AnnotationDraft, AnnotationPoint, AnnotationTool} from '../../PdfPages';
import {contactTool, penEraser} from './annotationInput';
import {cutInkPolyline, flattenInk} from './eraseInk';
import {smoothAnnotationPath} from './inkPath';

export type InkStyle = {tool: 'pen' | 'marker'; color: Highlight['color']; width: number};
type PreviewStroke = {item: Highlight; rects: HighlightRect[]};
type Gesture = {
  pointerId: number; pointerType: string; tool: NonNullable<AnnotationTool>; points: AnnotationPoint[];
  radius: number; ratio: number; dimensions: {width: number; height: number}; processed: number;
  lines: PreviewStroke[]; revision: number; style: InkStyle;
};
type Props = {
  documentId: string; page: number; dimensions: {width: number; height: number}; zoom: number;
  highlights: Highlight[]; tool: AnnotationTool; color: Highlight['color']; width: number;
  eraserSize: number; penOnly: boolean; draft: AnnotationDraft | null;
  onDraft: (draft: AnnotationDraft | null) => void;
  onSave: (page: number, points: AnnotationPoint[], style: InkStyle) => void;
  onErase: (page: number, points: AnnotationPoint[], dimensions: {width: number; height: number}, radius: number) => Promise<void>;
};

export function AnnotationLayer(props: Props) {
  const {documentId, page, dimensions, zoom, highlights, tool, color, width, eraserSize, penOnly, draft, onDraft, onSave, onErase} = props;
  const svg = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef<number | null>(null);
  const revision = useRef(0), lastPen = useRef(0), lastErase = useRef(0);
  const cursorRef = useRef<AnnotationPoint | null>(null);
  const [cursor, setCursor] = useState<AnnotationPoint | null>(null);
  const [preview, setPreview] = useState<PreviewStroke[] | null>(null);
  const previewRef = useRef<PreviewStroke[] | null>(null);
  const cancelFrame = () => {if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null;};
  const clearPreview = () => {previewRef.current = null; setPreview(null);};
  const cancel = () => {
    const previous = gesture.current;
    gesture.current = null; revision.current++; cancelFrame(); clearPreview(); onDraft(null);
    if (previous && svg.current?.hasPointerCapture(previous.pointerId)) svg.current.releasePointerCapture(previous.pointerId);
  };
  useEffect(() => () => {cancel(); cursorRef.current = null; setCursor(null);}, [documentId, page, tool, zoom, dimensions.width, dimensions.height, eraserSize, penOnly]);

  const pointAt = (event: {clientX: number; clientY: number}): AnnotationPoint => {
    const box = svg.current!.getBoundingClientRect();
    return {x: Math.max(0, Math.min(1, (event.clientX - box.left) / Math.max(1, box.width))), y: Math.max(0, Math.min(1, (event.clientY - box.top) / Math.max(1, box.height)))};
  };
  const advanceEraser = (current: Gesture) => {
    const points = current.points.slice(Math.max(0, current.processed - 1));
    current.lines = current.lines.flatMap(line => {
      const cut = cutInkPolyline(line.rects, points, current.ratio, current.radius);
      return cut ? cut.map(rects => ({item: line.item, rects})) : [line];
    });
    current.processed = current.points.length;
    previewRef.current = current.lines; setPreview(current.lines);
  };
  const schedule = () => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null; setCursor(cursorRef.current);
      const current = gesture.current;
      if (current?.tool === 'eraser') advanceEraser(current);
      else if (current) onDraft({page, points: [...current.points]});
    });
  };
  const append = (current: Gesture, event: React.PointerEvent<SVGSVGElement>) => {
    const coalesced = event.nativeEvent.getCoalescedEvents?.() || [];
    for (const sample of [...coalesced, event.nativeEvent]) {
      const point = pointAt(sample), last = current.points[current.points.length - 1];
      if (Math.hypot(point.x - last.x, point.y - last.y) < .0007) continue;
      // Collinear eraser samples can be collapsed without losing the swept area.
      const previous = current.points[current.points.length - 2];
      if (current.tool === 'eraser' && previous && current.processed < current.points.length) {
        const ax = (last.x - previous.x) * current.ratio, ay = last.y - previous.y;
        const bx = (point.x - last.x) * current.ratio, by = point.y - last.y;
        if (ax * bx + ay * by >= 0 && Math.abs(ax * by - ay * bx) < 1e-9) current.points.pop();
      }
      if (current.tool === 'eraser' || current.points.length < 1200) current.points.push(point);
    }
  };
  const start = (event: React.PointerEvent<SVGSVGElement>, selected: NonNullable<AnnotationTool>) => {
    event.currentTarget.focus({preventScroll: true});
    const box = svg.current!.getBoundingClientRect(), ratio = box.width / Math.max(1, box.height);
    const current: Gesture = {pointerId: event.pointerId, pointerType: event.pointerType, tool: selected,
      points: [pointAt(event)], radius: eraserSize / (2 * Math.max(1, box.height)), ratio,
      dimensions: {width: box.width, height: box.height}, processed: 0, revision: ++revision.current,
      lines: (previewRef.current || highlights.map(item => ({item, rects: item.rects}))).map(line => ({...line, rects: previewRef.current ? line.rects : flattenInk(line.rects, ratio)})),
      style: {tool: selected === 'marker' ? 'marker' : 'pen', color, width}};
    gesture.current = current;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (selected === 'eraser') {lastErase.current = current.revision; advanceEraser(current);}
    else onDraft({page, points: current.points});
  };
  const finish = (current: Gesture) => {
    cancelFrame(); gesture.current = null;
    if (current.tool === 'eraser') {
      advanceEraser(current);
      const clear = () => {if (lastErase.current === current.revision && gesture.current?.tool !== 'eraser') clearPreview();};
      void onErase(page, current.points, current.dimensions, current.radius).then(clear, clear);
    } else {
      if (current.points.length === 1) current.points.push({...current.points[0]});
      onSave(page, current.points, current.style); onDraft(null);
    }
  };
  const observePen = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== 'pen') return;
    lastPen.current = Date.now();
    if (gesture.current?.pointerType === 'touch') cancel();
  };
  const down = (event: React.PointerEvent<SVGSVGElement>) => {
    observePen(event);
    if (event.pointerType === 'touch' && (penOnly || Date.now() - lastPen.current < 750)) {event.preventDefault(); return;}
    const selected = contactTool(event, tool);
    if (!selected || gesture.current) return;
    event.preventDefault(); cursorRef.current = selected === 'eraser' ? pointAt(event) : null; setCursor(cursorRef.current);
    start(event, selected);
  };
  const move = (event: React.PointerEvent<SVGSVGElement>) => {
    observePen(event);
    const current = gesture.current;
    if (current && current.pointerId !== event.pointerId) return;
    const selected = contactTool(event, tool);
    cursorRef.current = tool === 'eraser' || penEraser(event) ? pointAt(event) : null;
    if (current) {
      event.preventDefault();
      // Barrel-button transitions arrive as pointermove, not another pointerdown.
      if (selected && selected !== current.tool) {finish(current); start(event, selected);}
      else if (selected) append(current, event);
    } else if (selected && event.pointerType === 'pen') start(event, selected);
    schedule();
  };
  const up = (event: React.PointerEvent<SVGSVGElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault(); append(current, event); finish(current);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const bounds = svg.current?.getBoundingClientRect();
  const visibleDraft = draft?.page === page ? draft : null;
  return <svg ref={svg} tabIndex={-1} aria-label={`PDF 第 ${page} 页标注`} className={`annotation-layer ${tool ? 'active' : ''} ${tool === 'eraser' ? 'eraser' : ''} ${cursor ? 'erasing-cursor' : ''}`}
    viewBox="0 0 1000 1000" preserveAspectRatio="none" onPointerDown={down} onPointerMove={move} onPointerUp={up}
    onPointerEnter={observePen} onPointerLeave={() => {if (!gesture.current) {cursorRef.current = null; setCursor(null);}}}
    onPointerCancel={event => {if (gesture.current?.pointerId === event.pointerId) cancel();}}
    onLostPointerCapture={event => {if (gesture.current?.pointerId === event.pointerId) cancel();}}
    onContextMenu={event => {if (tool) event.preventDefault();}}>
    {preview ? preview.map((line, index) => <path key={`${line.item.id}-${index}`} className={`annotation-stroke live-erase ${line.item.tags.includes('marker') ? 'marker' : 'pen'} ${line.item.color}`}
      d={line.rects.map((p, i) => `${i ? 'L' : 'M'} ${p.x * 1000} ${p.y * 1000}`).join(' ')} fill="none" strokeWidth={(line.rects[0]?.width || .004) * 1000} strokeLinecap="round" strokeLinejoin="round"/>)
      : highlights.map(item => <path key={item.id} className={`annotation-stroke ${item.tags.includes('marker') ? 'marker' : 'pen'} ${item.color}`} d={smoothAnnotationPath(item.rects)} fill="none" strokeWidth={(item.rects[0]?.width || .004) * 1000} strokeLinecap="round" strokeLinejoin="round"/>)}
    {visibleDraft && <path className={`annotation-stroke draft ${gesture.current?.style.tool || tool} ${gesture.current?.style.color || color}`} d={smoothAnnotationPath(visibleDraft.points)} fill="none" strokeWidth={(gesture.current?.style.width || width) * 1000} strokeLinecap="round" strokeLinejoin="round"/>}
    {cursor && tool && <ellipse className="annotation-eraser-cursor" cx={cursor.x * 1000} cy={cursor.y * 1000} rx={eraserSize * 500 / Math.max(1, bounds?.width || dimensions.width * zoom)} ry={eraserSize * 500 / Math.max(1, bounds?.height || dimensions.height * zoom)}/>}
  </svg>;
}
