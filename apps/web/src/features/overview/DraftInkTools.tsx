import type {ReaderInkTools} from '../reader/useAnnotations';

export function DraftInkTools({tools, onUndo, undoDepth, loaded}: {
  tools: ReaderInkTools; onUndo: () => void; undoDepth: number; loaded: boolean;
}) {
  const {annotationTool: tool} = tools;
  return <div className="chapter-draft-controls" role="group" aria-label="总结 PDF 标注工具">
    {(['pen', 'marker', 'eraser'] as const).map((value, index) => <button type="button" key={value}
      disabled={!loaded} aria-pressed={tool === value} onClick={() => tools.setAnnotationTool(tool === value ? null : value)}>
      {['画笔', '荧光笔', '橡皮擦'][index]}</button>)}
    <label>标注颜色 <select aria-label="总结标注颜色" value={tools.annotationColor}
      onChange={event => tools.setAnnotationColor(event.target.value as ReaderInkTools['annotationColor'])}>
      {(['black', 'red', 'blue', 'pink', 'green', 'yellow'] as const).map((color, index) =>
        <option key={color} value={color}>{['黑', '红', '蓝', '粉', '绿', '黄'][index]}</option>)}
    </select></label>
    <label>笔宽 <input aria-label="总结标注笔宽" type="range" min="2" max="16" value={Math.round(tools.annotationWidth * 1000)}
      onChange={event => tools.setAnnotationWidth(Number(event.target.value) / 1000)}/></label>
    {tool === 'eraser' && <label>橡皮大小 <input type="range" min="8" max="80" step="2" value={tools.eraserSize}
      onChange={event => tools.setEraserSize(Number(event.target.value))}/></label>}
    <label><input type="checkbox" checked={tools.penOnly} onChange={event => tools.setPenOnly(event.target.checked)}/>仅手写笔</label>
    <button type="button" disabled={!undoDepth} onClick={onUndo}>撤销总结标注</button>
    {tool && <button type="button" onClick={() => tools.setAnnotationTool(null)}>结束标注</button>}
  </div>;
}
