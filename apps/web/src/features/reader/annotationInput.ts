import type {AnnotationTool} from '../../PdfPages';

export type PointerInput = {pointerType: string; button: number; buttons: number; pressure: number};

export function penEraser(input: PointerInput): boolean {
  return input.pointerType === 'pen' && (input.button === 5 || (input.buttons & 32) !== 0 || (input.buttons & 2) !== 0);
}

export function contactTool(input: PointerInput, selected: AnnotationTool): AnnotationTool {
  if (!selected || !input.buttons) return null;
  if (input.pointerType === 'pen') {
    // A barrel button can fire pointerdown while the pen is still hovering.
    if (!(input.buttons & 33) && input.pressure <= 0) return null;
    return penEraser(input) ? 'eraser' : selected;
  }
  return (input.buttons & 1) !== 0 ? selected : null;
}

const SETTINGS_KEY = 'reader-next-v2-annotation-input';
export function readAnnotationInput(): {eraserSize: number; penOnly: boolean} {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {eraserSize: typeof value.eraserSize === 'number' && Number.isFinite(value.eraserSize) ? Math.max(8, Math.min(80, Math.round(value.eraserSize))) : 24, penOnly: value.penOnly === true};
  } catch {return {eraserSize: 24, penOnly: false};}
}
export function saveAnnotationInput(eraserSize: number, penOnly: boolean) {
  try {localStorage.setItem(SETTINGS_KEY, JSON.stringify({eraserSize, penOnly}));} catch { /* Storage may be unavailable. */ }
}
