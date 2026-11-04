import {useEffect, useRef, useState, type ReactNode} from 'react';
import type {Note} from '../../api';
import {NoteImages} from './StickyNoteEditor';

import type {useRecentView} from '../../shared/useRecentView';

export function sortNotesByOpened(notes: Note[], opened: Record<string, number>) {
  return [...notes].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
    || (opened[b.id] || 0) - (opened[a.id] || 0)
    || b.created_at.localeCompare(a.created_at));
}

function noteTitle(note: Note) {
  return note.title?.trim() || note.content.trim().split('\n')[0].slice(0, 32) || '图片笔记';
}

function NoteDetail({note, onClose, onSource, onEdit}: {
  note: Note; onClose: () => void; onSource?: () => void; onEdit?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {dialog.current?.showModal();}, []);
  return <dialog ref={dialog} className="note-detail" aria-label="笔记详情" onClose={onClose}>
    <header><div><small>{note.page_number ? `PDF 第 ${note.page_number} 页` : '未标页码'}</small><h2>{noteTitle(note)}</h2></div><button type="button" aria-label="关闭笔记详情" onClick={() => dialog.current?.close()}>×</button></header>
    {note.excerpt && <blockquote>{note.excerpt}</blockquote>}
    {note.content && <p>{note.content}</p>}
    <NoteImages images={note.images}/>
    {!!note.tags?.length && <small>{note.tags.map(tag => '#' + tag).join(' ')}</small>}
    {(onSource || onEdit) && <footer>
      {onSource && <button type="button" onClick={() => {onClose(); onSource();}}>返回来源</button>}
      {onEdit && <button type="button" onClick={() => {onClose(); onEdit();}}>编辑笔记</button>}
    </footer>}
  </dialog>;
}

type Props = {
  notes: Note[];
  browsing: ReturnType<typeof useRecentView>;
  className?: string;
  empty: ReactNode;
  renderListItem: (note: Note, open: () => void) => ReactNode;
  onSource?: (note: Note) => void;
  onEdit?: (note: Note) => void;
};

export function NoteCollection({notes, browsing, className = '', empty, renderListItem, onSource, onEdit}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = notes.find(note => note.id === selectedId);
  const {opened, view, setView, recordOpened} = browsing;
  const sorted = sortNotesByOpened(notes, opened);
  const open = (note: Note) => {recordOpened(note.id); setSelectedId(note.id);};
  return <>
    <div className="note-view-switch" role="group" aria-label="笔记显示方式">
      <span>最近打开优先</span>
      <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>列表</button>
      <button type="button" aria-pressed={view === 'grid'} onClick={() => setView('grid')}>网格</button>
    </div>
    <div className={`${className} ${view === 'grid' && sorted.length ? 'note-icon-grid' : ''}`}>
      {!sorted.length ? empty : sorted.map(note => view === 'grid'
        ? <button key={note.id} type="button" className="note-icon-tile" title={noteTitle(note)} onClick={() => open(note)}>
          <span className="note-icon" aria-hidden="true">{note.pinned ? '★' : '▤'}</span><strong>{noteTitle(note)}</strong>
          <small>{note.page_number ? `第 ${note.page_number} 页` : '笔记'}</small>
        </button>
        : renderListItem(note, () => open(note)))}
    </div>
    {selected && <NoteDetail key={selected.id} note={selected} onClose={() => setSelectedId(null)}
      onSource={onSource && (() => onSource(selected))} onEdit={onEdit && (() => onEdit(selected))}/>}
  </>;
}
