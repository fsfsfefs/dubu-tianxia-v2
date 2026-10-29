import type {DocumentRecord, FolderRecord} from '../../api';
type Props = {
  activeDocument: DocumentRecord | null; currentPage: number; notesCount: number; masteredCount: number;
  documents: DocumentRecord[]; folders: FolderRecord[]; selectedFolderId: string; setSelectedFolderId: (id: string) => void;
  enterReader: () => void; onOverview: () => void; onImport: () => void; openBook: (book: DocumentRecord) => void;
  renameBook: (book: DocumentRecord) => void; removeBook: (book: DocumentRecord) => void;
  moveBookToFolder: (book: DocumentRecord, folderId: string) => void; addFolder: () => void;
  editFolder: (folder: FolderRecord) => void; removeFolder: (folder: FolderRecord) => void;
};
export function LibraryHome({activeDocument, currentPage, notesCount, masteredCount, documents, folders, selectedFolderId,
  setSelectedFolderId, enterReader, onOverview, onImport, openBook, renameBook, removeBook, moveBookToFolder,
  addFolder, editFolder, removeFolder}: Props) {
  const visibleDocuments = documents.filter(book => selectedFolderId === 'all' || selectedFolderId === 'unfiled' && !book.folder_id || book.folder_id === selectedFolderId);
  const unfiledCount = documents.filter(book => !book.folder_id).length;
  return <main className="guided-home original-home">
    {activeDocument && <section className="continue-reading"><p className="continue-eyebrow">CONTINUE　继续学习</p><div className="continue-row"><div className="editorial-cover">408<br/><small>读步天下</small></div><div><p>{activeDocument.title}</p><h1>继续阅读教材</h1><span>PDF {currentPage} · {notesCount} 条学习记忆 · {masteredCount} 项已掌握</span></div><div className="continue-actions"><button className="primary-action" onClick={() => enterReader()}>继续学习 →</button><button onClick={() => onOverview()}>查看全书结构</button></div></div></section>}
    <section className="library-home">
      <div className="section-heading"><div><p>LIBRARY　你的教材</p></div><span>{documents.length} 本教材 · {folders.length} 个文件夹 · 本地保存</span></div>
      <div className="folder-toolbar">
        <nav aria-label="教材文件夹"><button aria-current={selectedFolderId === 'all'} onClick={() => setSelectedFolderId('all')}><span>全部教材</span><small>{documents.length}</small></button>{folders.map(folder => <span className="folder-tab" key={folder.id}><button aria-current={selectedFolderId === folder.id} onClick={() => setSelectedFolderId(folder.id)}><span>▱ {folder.name}</span><small>{folder.document_count}</small></button><details><summary aria-label={`${folder.name} 文件夹设置`}>···</summary><div><button onClick={() => void editFolder(folder)}>重命名</button><button className="danger-text" onClick={() => void removeFolder(folder)}>删除文件夹</button></div></details></span>)}<button aria-current={selectedFolderId === 'unfiled'} onClick={() => setSelectedFolderId('unfiled')}><span>未分类</span><small>{unfiledCount}</small></button></nav>
        <button className="new-folder" onClick={() => void addFolder()}>＋ 新建文件夹</button>
      </div>
      <div className="book-list-original">{visibleDocuments.map(document => <article className="library-book" key={document.id}><span className="editorial-cover compact">PDF</span><span className="book-identity"><strong>{document.title}</strong><small>{(document.byte_size / 1024 / 1024).toFixed(1)} MB · {activeDocument?.id === document.id ? `上次读到 PDF ${currentPage}` : folders.find(folder => folder.id === document.folder_id)?.name || '未分类'}</small></span><button className="book-open" aria-label={`打开教材 ${document.title}`} onClick={() => openBook(document)}>打开 →</button><details className="book-more"><summary aria-label={`${document.title} 更多操作`}>···</summary><div><button onClick={() => openBook(document)}>查看全书结构</button><button onClick={() => void renameBook(document)}>重命名</button><label className="move-book-label">移动到<select value={document.folder_id || ''} onChange={event => void moveBookToFolder(document, event.target.value)}><option value="">未分类</option>{folders.map(folder => <option value={folder.id} key={folder.id}>{folder.name}</option>)}</select></label><button className="danger-text" onClick={() => void removeBook(document)}>删除教材</button></div></details></article>)}</div>
      {!documents.length && <div className="guided-empty"><p>还没有教材。</p><button className="primary-action" onClick={() => onImport()}>选择 PDF</button></div>}
      {documents.length > 0 && !visibleDocuments.length && <div className="guided-empty folder-empty"><p>这个文件夹还没有教材。</p><span>可以从教材的“···”菜单移动，或在当前文件夹中导入 PDF。</span><button className="primary-action" onClick={() => onImport()}>导入到此文件夹</button></div>}
    </section><p className="local-note">文件夹和教材仅保存在这台电脑上</p>
  </main>;
}
