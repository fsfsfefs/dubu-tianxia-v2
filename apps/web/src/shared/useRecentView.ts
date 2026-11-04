import {useEffect, useState} from 'react';

export function useRecentView(scope: 'note' | 'book') {
  const openedKey = `reader-next-${scope}-opened`;
  const viewKey = `reader-next-${scope}-view`;
  const [opened, setOpened] = useState<Record<string, number>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(openedKey) || '{}');
      return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1])));
    } catch {return {};}
  });
  const [view, setView] = useState<'list' | 'grid'>(() => {
    try {return localStorage.getItem(viewKey) === 'grid' ? 'grid' : 'list';}
    catch {return 'list';}
  });
  useEffect(() => {
    try {localStorage.setItem(openedKey, JSON.stringify(opened));} catch { /* Storage is optional. */ }
  }, [opened, openedKey]);
  useEffect(() => {
    try {localStorage.setItem(viewKey, view);} catch { /* Storage is optional. */ }
  }, [view, viewKey]);
  const recordOpened = (id: string) => {
    const now = Date.now();
    setOpened(previous => ({...previous, [id]: Object.values(previous).reduce((latest, time) => Math.max(latest, time), now) + 1}));
  };
  return {opened, view, setView, recordOpened};
}
