import React, {useEffect, useRef, useState} from 'react';
function clampPanelSize(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function storedPanelSize(key: string, fallback: number): number {
  const value = Number(window.localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function storedPanelCollapsed(key: string): boolean {
  return window.localStorage.getItem(key) === 'true';
}

export function usePanelLayout() {
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => {cleanup.current?.();}, []);
  const [assistantWidth, setAssistantWidth] = useState(() => storedPanelSize('reader-layout-assistant-width', 430));
  const [excerptHeight, setExcerptHeight] = useState(() => storedPanelSize('reader-layout-excerpt-height', 150));
  const [composerHeight, setComposerHeight] = useState(() => storedPanelSize('reader-layout-composer-height', 92));
  const [assistantSetupCollapsed, setAssistantSetupCollapsed] = useState(() => storedPanelCollapsed('reader-layout-setup-collapsed'));
  const [questionContextCollapsed, setQuestionContextCollapsed] = useState(() => storedPanelCollapsed('reader-layout-context-collapsed'));
  const [excerptPanelCollapsed, setExcerptPanelCollapsed] = useState(() => storedPanelCollapsed('reader-layout-excerpt-collapsed'));
  useEffect(() => { window.localStorage.setItem('reader-layout-assistant-width', String(assistantWidth)); }, [assistantWidth]);
  useEffect(() => { window.localStorage.setItem('reader-layout-excerpt-height', String(excerptHeight)); }, [excerptHeight]);
  useEffect(() => { window.localStorage.setItem('reader-layout-composer-height', String(composerHeight)); }, [composerHeight]);
  useEffect(() => { window.localStorage.setItem('reader-layout-setup-collapsed', String(assistantSetupCollapsed)); }, [assistantSetupCollapsed]);
  useEffect(() => { window.localStorage.setItem('reader-layout-context-collapsed', String(questionContextCollapsed)); }, [questionContextCollapsed]);
  useEffect(() => { window.localStorage.setItem('reader-layout-excerpt-collapsed', String(excerptPanelCollapsed)); }, [excerptPanelCollapsed]);

  const resizePanelByKeyboard = (panel: 'assistant' | 'excerpt' | 'composer', amount: number) => {
    if (panel === 'assistant') setAssistantWidth(value => clampPanelSize(value + amount, 340, Math.min(760, Math.max(340, window.innerWidth - 520))));
    if (panel === 'excerpt') setExcerptHeight(value => clampPanelSize(value + amount, 112, 360));
    if (panel === 'composer') setComposerHeight(value => clampPanelSize(value + amount, 76, 260));
  };

  const beginPanelResize = (event: React.PointerEvent<HTMLDivElement>, panel: 'assistant' | 'excerpt' | 'composer') => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = panel === 'assistant' ? assistantWidth : panel === 'excerpt' ? excerptHeight : composerHeight;
    document.body.classList.add('panel-resizing', panel === 'assistant' ? 'panel-resizing-horizontal' : 'panel-resizing-vertical');
    const onMove = (moveEvent: PointerEvent) => {
      if (panel === 'assistant') {
        const maximum = Math.min(760, Math.max(340, window.innerWidth - 520));
        setAssistantWidth(clampPanelSize(startSize + startX - moveEvent.clientX, 340, maximum));
      } else if (panel === 'excerpt') {
        setExcerptHeight(clampPanelSize(startSize + moveEvent.clientY - startY, 112, 360));
      } else {
        setComposerHeight(clampPanelSize(startSize + startY - moveEvent.clientY, 76, 260));
      }
    };
    const onEnd = () => {
      cleanup.current = null;
      document.body.classList.remove('panel-resizing', 'panel-resizing-horizontal', 'panel-resizing-vertical');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
    cleanup.current?.(); cleanup.current = onEnd;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  };

  return {assistantWidth, setAssistantWidth, excerptHeight, setExcerptHeight, composerHeight, setComposerHeight, assistantSetupCollapsed, setAssistantSetupCollapsed, questionContextCollapsed, setQuestionContextCollapsed, excerptPanelCollapsed, setExcerptPanelCollapsed, resizePanelByKeyboard, beginPanelResize};
}
