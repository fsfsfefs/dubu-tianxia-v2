import {useEffect, useRef} from 'react';

export function useAutoDismiss(value: unknown, clear: () => void, delay = 6000) {
  const clearRef = useRef(clear);
  clearRef.current = clear;

  useEffect(() => {
    if (!value) return;
    const timer = window.setTimeout(() => clearRef.current(), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
}
