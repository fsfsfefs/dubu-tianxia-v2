import {useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject} from 'react';

const WIDTH_KEY = 'reader-summary-panel-width';

function initialWidth() {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= 100 && stored <= 1000) return stored;
  } catch {}
  return 420;
}

export function useSummaryWidth(root: RefObject<HTMLDivElement | null>, active: boolean) {
  const [preferred, setPreferred] = useState(initialWidth);
  const [available, setAvailable] = useState(0);
  const cleanup = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const host = root.current;
    if (!host) return;
    const measure = () => setAvailable(host.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    try {localStorage.setItem(WIDTH_KEY, String(preferred));} catch {}
  }, [preferred]);
  useEffect(() => {
    if (!active) cleanup.current();
    return () => cleanup.current();
  }, [active]);

  const maximum = available > 0 ? Math.max(1, Math.min(1000, Math.floor(available * .9))) : 1000;
  const minimum = Math.min(260, maximum);
  const clamp = (value: number) => Math.round(Math.min(maximum, Math.max(minimum, value)));
  const width = clamp(preferred);
  const resize = (value: number) => setPreferred(clamp(value));
  const reset = () => setPreferred(420);
  const begin = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !active) return;
    cleanup.current();
    event.preventDefault();
    const handle = event.currentTarget, pointerId = event.pointerId;
    const start = event.clientX, startWidth = width;
    const oldCursor = document.body.style.cursor, oldSelection = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    handle.setPointerCapture(pointerId);
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      next.preventDefault();
      resize(startWidth + next.clientX - start);
    };
    const finish = (next: globalThis.PointerEvent) => {
      if (next.pointerId === pointerId) stop();
    };
    const stop = () => {
      cleanup.current = () => {};
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', stop);
      handle.removeEventListener('lostpointercapture', finish);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      document.body.style.cursor = oldCursor;
      document.body.style.userSelect = oldSelection;
    };
    cleanup.current = stop;
    window.addEventListener('pointermove', move, {passive: false});
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', stop);
    handle.addEventListener('lostpointercapture', finish);
  };
  return {width, minimum, maximum, resize, reset, begin};
}
export type SummaryPanelResize = ReturnType<typeof useSummaryWidth>;
