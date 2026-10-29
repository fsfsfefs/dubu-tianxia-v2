import {useDocumentScope} from '../../shared/useDocumentScope';
import {useState} from 'react';
import {Note, DocumentRecord, createNote, deleteNote, updateNote} from '../../api';

export function useNotes(activeDocument: DocumentRecord | null, currentPage: number, excerpt: string, setError: (message: string) => void) {
  const capture = useDocumentScope(activeDocument?.id);
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteTitle, setNoteTitle] = useState('');
  const [noteTags, setNoteTags] = useState('');
  const [noteSearch, setNoteSearch] = useState('');
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [editingTitle, setEditingTitle] = useState('');
  const [editingTags, setEditingTags] = useState('');
  const addNote = async () => {
    const valid = capture();
    if (!activeDocument || !noteDraft.trim()) return;
    setError('');
    try {
      const note = await createNote(activeDocument.id, {page_number: currentPage, excerpt: excerpt.trim(), content: noteDraft.trim(), title: noteTitle.trim(), tags: [...new Set(noteTags.split(/[，,]/).map(tag => tag.trim()).filter(Boolean))], pinned: false});
      if (!valid()) return;
      setNotes(items => [note, ...items]); setNoteDraft(''); setNoteTitle(''); setNoteTags('');
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : '笔记保存失败'); }
  };

  const removeNote = async (noteId: string) => {
    const valid = capture();
    if (!activeDocument) return;
    try { await deleteNote(activeDocument.id, noteId); if (!valid()) return; setNotes(items => items.filter(item => item.id !== noteId)); }
    catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : '删除失败'); }
  };

  const createPageStickyNote = async (page: number, content: string) => {
    const valid = capture();
    if (!activeDocument || !content.trim()) return;
    try {
      const note = await createNote(activeDocument.id, {page_number: page, excerpt: '', content: content.trim(), title: `第 ${page} 页便签`, tags: ['页边便签'], pinned: false});
      if (!valid()) throw new DOMException('教材已切换', 'AbortError');
      setNotes(items => [note, ...items]);
    } catch (reason) {
      if (valid()) setError(reason instanceof Error ? reason.message : '便签保存失败');
      throw reason;
    }
  };

  const updatePageStickyNote = async (note: Note, content: string) => {
    const valid = capture();
    if (!activeDocument || !content.trim()) return;
    try {
      const updated = await updateNote(activeDocument.id, note.id, {content: content.trim(), title: note.title || `第 ${note.page_number || currentPage} 页便签`, tags: [...new Set([...(note.tags || []), '页边便签'])], pinned: note.pinned || false});
      if (!valid()) throw new DOMException('教材已切换', 'AbortError');
      setNotes(items => items.map(item => item.id === note.id ? updated : item));
    } catch (reason) {
      if (valid()) setError(reason instanceof Error ? reason.message : '便签更新失败');
      throw reason;
    }
  };

  const deletePageStickyNote = async (note: Note) => {
    const valid = capture();
    if (!activeDocument) return;
    try {
      await deleteNote(activeDocument.id, note.id);
      if (!valid()) throw new DOMException('教材已切换', 'AbortError');
      setNotes(items => items.filter(item => item.id !== note.id));
    } catch (reason) {
      if (valid()) setError(reason instanceof Error ? reason.message : '便签删除失败');
      throw reason;
    }
  };

  const saveEditedNote = async (noteId: string) => {
    const valid = capture();
    if (!activeDocument || !editingContent.trim()) return;
    try {
      const original = notes.find(item => item.id === noteId);
      const updated = await updateNote(activeDocument.id, noteId, {content: editingContent.trim(), title: editingTitle.trim(), tags: [...new Set(editingTags.split(/[，,]/).map(tag => tag.trim()).filter(Boolean))], pinned: original?.pinned || false});
      if (!valid()) return;
      setNotes(items => items.map(item => item.id === noteId ? updated : item)); setEditingNote(null);
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : '更新失败'); }
  };

  const toggleNotePinned = async (note: Note) => {
    const valid = capture();
    if (!activeDocument) return;
    try {
      const updated = await updateNote(activeDocument.id, note.id, {content: note.content, title: note.title || '', tags: note.tags || [], pinned: !note.pinned});
      if (!valid()) return;
      setNotes(items => items.map(item => item.id === note.id ? updated : item).sort((a, b) => Number(b.pinned) - Number(a.pinned)));
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : '置顶失败'); }
  };

  const exportNotes = () => {
    if (!activeDocument || !notes.length) return;
    const markdown = [`# ${activeDocument.title} · 学习笔记`, '', ...notes.flatMap(note => [
      `## ${note.page_number ? `第 ${note.page_number} 页` : '未标页码'}`,
      note.excerpt ? `> ${note.excerpt.replaceAll('\n', '\n> ')}` : '',
      '', note.content, '',
    ])].join('\n');
    const url = URL.createObjectURL(new Blob([markdown], {type: 'text/markdown;charset=utf-8'}));
    const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = `${activeDocument.title}-学习笔记.md`; anchor.click(); URL.revokeObjectURL(url);
  };

  return {notes, setNotes, noteDraft, setNoteDraft, noteTitle, setNoteTitle, noteTags, setNoteTags, noteSearch, setNoteSearch, editingNote, setEditingNote, editingContent, setEditingContent, editingTitle, setEditingTitle, editingTags, setEditingTags, addNote, removeNote, createPageStickyNote, updatePageStickyNote, deletePageStickyNote, saveEditedNote, toggleNotePinned, exportNotes};
}
