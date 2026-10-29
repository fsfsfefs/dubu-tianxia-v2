import {useEffect, useMemo, useRef, useState} from 'react';
import {filterGuide, parseGuide, type GuideBlock} from './guideContent';

type Props = {markdown: string; onClose: () => void};
function Block({block}: {block: GuideBlock}) {
  if (block.kind === 'list') {
    const List = block.ordered ? 'ol' : 'ul';
    return <List>{block.items.map((item, index) => <li key={index}>{item}</li>)}</List>;
  }
  if (block.kind === 'heading') return <h3>{block.text}</h3>;
  if (block.kind === 'code') return <pre><code>{block.text}</code></pre>;
  return <p>{block.text}</p>;
}

export function GuideDialog({markdown, onClose}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const guide = useMemo(() => parseGuide(markdown), [markdown]);
  const sections = useMemo(() => filterGuide(guide.sections, query), [guide, query]);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => {element.close();};
  }, []);
  useEffect(() => {if (content.current) content.current.scrollTop = 0;}, [query]);
  const closeGuide = () => {dialog.current?.close(); onClose();};
  const download = () => {
    const url = URL.createObjectURL(new Blob([markdown], {type: 'text/markdown;charset=utf-8'}));
    const link = window.document.createElement('a');
    link.href = url; link.download = '读步天下使用指南.md'; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <dialog className="user-guide" ref={dialog} onKeyDown={event => {event.stopPropagation(); if (event.key === 'Escape' && !event.nativeEvent.isComposing) {event.preventDefault(); closeGuide();}}} aria-labelledby="user-guide-title" onCancel={event => {event.preventDefault(); closeGuide();}}>
    <header className="user-guide-header">
      <div><small>GETTING STARTED</small><h1 id="user-guide-title">{guide.title}</h1><p>功能用途 · 操作方法 · 使用条件</p></div>
      <div className="user-guide-actions"><button onClick={download}>下载 Markdown</button><button className="user-guide-close" aria-label="关闭使用指南" onClick={closeGuide}>关闭 ×</button></div>
    </header>
    <div className="user-guide-search"><label htmlFor="user-guide-query">查找功能</label><input id="user-guide-query" type="search" placeholder="搜索功能或用法，例如：导读、RAG、备份" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button aria-label="清空指南搜索" onClick={() => setQuery('')}>清空</button>}<span role="status">{sections.length} / {guide.sections.length} 章</span></div>
    <div className="user-guide-layout">
      <nav className="user-guide-toc" aria-label="使用指南目录"><p>从入门到日常学习</p>{sections.map(section => <a key={section.id} href={`#${section.id}`} onClick={event => {event.preventDefault(); const heading = window.document.getElementById(section.id); heading?.scrollIntoView({block: 'start'}); heading?.focus({preventScroll: true});}}>{section.title}</a>)}</nav>
      <div ref={content} className="user-guide-content" tabIndex={0} aria-label="使用指南正文">
        {!query && <p className="user-guide-introduction">{guide.introduction}</p>}
        {sections.map(section => <section key={section.id}><h2 id={section.id} tabIndex={-1}>{section.title}</h2>{section.blocks.map((block, index) => <Block key={index} block={block}/>)}</section>)}
        {!sections.length && <div className="user-guide-empty"><h2>没有找到相关功能</h2><p>试试“原文”“总结”“模型”或清空搜索后浏览完整目录。</p><button onClick={() => setQuery('')}>查看全部功能</button></div>}
      </div>
    </div>
  </dialog>;
}
