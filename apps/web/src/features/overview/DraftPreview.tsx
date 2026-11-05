import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {getDocument, GlobalWorkerOptions, type PDFDocumentProxy} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {draftFile, type ChapterDraft, type DraftLink, type DraftLinkInput} from './chapterDrafts';

import {pageAtViewportY} from '../reader/pageViewport';
import {defaultDraftRect, DraftPdfSheet, draftLinkLabel} from './DraftPdfSheet';

GlobalWorkerOptions.workerSrc = workerUrl;

type HtmlPreview = {pages: string[]; styles: string};
async function readHtml(format: ChapterDraft['format'], response: Response): Promise<HtmlPreview> {
  const {default: purify} = await import('dompurify');
  const sanitize = (html: string) => purify.sanitize(html, {
    FORBID_TAGS: ['style', 'link', 'iframe', 'form', 'input', 'button', 'object', 'embed', 'audio', 'video'],
    FORBID_ATTR: ['href', 'srcset', 'action', 'formaction'],
  });
  if (format === 'docx') {
    const {renderAsync} = await import('docx-preview');
    const body = document.createElement('div');
    const styles = document.createElement('div');
    await renderAsync(await response.arrayBuffer(), body, styles, {
      className: 'draft-docx', useBase64URL: true, renderAltChunks: false,
    });
    const wrapper = body.querySelector('.draft-docx-wrapper');
    const pages = Array.from(wrapper?.children ?? []).map(page => sanitize(page.outerHTML));
    if (!pages.length) throw new Error('Word 文件没有可显示的内容。');
    return {pages, styles: Array.from(styles.querySelectorAll('style')).map(style => style.textContent || '').join('\n')};
  }
  const content = await response.text();
  if (format === 'md') {
    const {marked} = await import('marked');
    return {pages: [sanitize(await marked.parse(content, {gfm: true}))], styles: ''};
  }
  const pre = document.createElement('pre');
  pre.textContent = content;
  return {pages: [pre.outerHTML], styles: ''};
}

function HtmlPage({html, styles, word}: {html: string; styles: string; word: boolean}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const innerObserver = useRef<ResizeObserver | null>(null);
  useEffect(() => () => innerObserver.current?.disconnect(), []);
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
  return <iframe ref={frame} title="导入稿正文" sandbox="allow-same-origin" className="chapter-draft-frame"
    srcDoc={`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>
      body{margin:0;color:#25382e;background:#fff;font:16px/1.65 system-ui,sans-serif;overflow-wrap:anywhere}
      .draft-text{padding:16px}pre{white-space:pre-wrap}img{max-width:100%}
      table{border-collapse:collapse} .draft-text th,.draft-text td{border:1px solid #bfcac0;padding:.3em}
      ${styles.replace(/<\/style/gi, '')}
      .draft-docx-wrapper{padding:0!important;background:transparent!important;display:block!important}
      .draft-docx-wrapper>section{margin:0!important;box-shadow:none!important}
      </style></head><body><main class="${word ? 'draft-docx-wrapper' : 'draft-text'}">${html}</main></body></html>`}
    onLoad={() => {
      innerObserver.current?.disconnect();
      const iframe = frame.current;
      const body = iframe?.contentDocument?.body;
      const main = body?.firstElementChild as HTMLElement | null;
      if (!iframe || !body || !main) return;
      function resize() {
        if (!iframe?.clientWidth || !body || !main) return;
        const sheet = word ? main.firstElementChild as HTMLElement | null : null;
        if (sheet?.offsetWidth) sheet.style.zoom = String(Math.min(1, iframe.clientWidth / sheet.offsetWidth));
        iframe.style.height = `${Math.ceil(body.getBoundingClientRect().height) + 2}px`;
      }
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(body);
      observer.observe(iframe, {box: 'border-box'});
      innerObserver.current = observer;
    }}/>;
}

export default function DraftPreview({draft, page, setPage, onJump, onSave, onDelete}: {
  draft: ChapterDraft; page: number; setPage: (page: number) => void; onJump: (page: number, label: string) => void;
  onSave: (link: DraftLinkInput, id?: string) => Promise<unknown>; onDelete: (id: string) => Promise<unknown>;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [html, setHtml] = useState<HtmlPreview>();
  const [editor, setEditor] = useState<DraftLinkInput & {id?: string}>();
  const [placing, setPlacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [linkError, setLinkError] = useState('');
  const [mode, setMode] = useState<'click' | 'scroll'>(() => localStorage.getItem('draft-pdf-page-mode') === 'scroll' ? 'scroll' : 'click');
  const [aspects, setAspects] = useState<Record<number, number>>({});
  const storeAspect = useCallback((number: number, value: number) => {
    setAspects(previous => previous[number] === value ? previous : {...previous, [number]: value});
  }, []);
  const scroller = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const pendingPage = useRef(page);
  const file = draftFile(draft);
  const format = draft.format;
  useEffect(() => {
    const controller = new AbortController();
    const fail = (reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '导入稿无法预览。');
    };
    if (format === 'pdf') {
      const task = getDocument({url: file});
      void task.promise.then(async document => {
        const base = (await document.getPage(1)).getViewport({scale: 1});
        if (!controller.signal.aborted) {
          storeAspect(1, base.width / base.height);
          setPdf(document);
        }
      }).catch(fail);
      return () => {controller.abort(); void task.destroy();};
    }
    void fetch(file, {signal: controller.signal}).then(response => {
      if (!response.ok) throw new Error('无法读取导入稿。');
      return readHtml(format, response);
    }).then(preview => {if (!controller.signal.aborted) setHtml(preview);}).catch(fail);
    return () => controller.abort();
  }, [file, format, storeAspect]);

  const scrollToPage = useCallback((target: number) => {
    const root = scroller.current;
    const sheet = stage.current?.children[target - 1];
    if (root && sheet) root.scrollTop += sheet.getBoundingClientRect().top - root.getBoundingClientRect().top;
  }, []);
  useLayoutEffect(() => {
    if (pdf && mode === 'scroll') scrollToPage(pendingPage.current);
  }, [mode, pdf, scrollToPage]);

  if (error) return <p role="alert">无法预览导入稿。{error}</p>;
  if (!pdf && !html) return <p role="status">正在读取导入稿…</p>;
  const total = pdf?.numPages ?? html?.pages.length ?? 1;
  const current = Math.min(total, page);
  const scrolling = Boolean(pdf && mode === 'scroll' && total > 1);
  const links = draft.links.filter(link => link.anchor === current);
  const changePage = (target: number) => {
    if (target < 1 || target > total || !Number.isInteger(target)) return;
    pendingPage.current = target;
    if (scrolling) scrollToPage(target);
    setPage(target);
  };
  const startEditor = (link?: DraftLink) => {
    setEditor(link ? {...link} : {anchor: current, page: 0, label: '', rect: pdf ? defaultDraftRect : undefined});
    setPlacing(Boolean(pdf));
    setLinkError('');
  };
  const closeEditor = () => {setEditor(undefined); setPlacing(false);};
  const commit = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setLinkError('');
    try {await action(); closeEditor();}
    catch (reason) {setLinkError(reason instanceof Error ? reason.message : '保存跳转失败。');}
    finally {setBusy(false);}
  };
  function renderSheet(number: number) {
    if (!pdf) return null;
    const isEditorPage = editor?.anchor === number;
    return <DraftPdfSheet key={number} pdf={pdf} number={number} aspect={aspects[number] ?? aspects[1] ?? 0.707}
      visible={!scrolling || Math.abs(current - number) <= 2} editing={Boolean(isEditorPage && placing && !busy)}
      rect={isEditorPage ? editor?.rect : undefined} links={draft.links.filter(link => link.anchor === number)}
      onAspect={storeAspect} onPlace={rect => {setEditor(previous => previous && {...previous, rect}); setPlacing(false);}} onJump={onJump}/>;
  }
  return <>
    <div className="chapter-draft-controls">
      {pdf && total > 1 && <label>翻页方式 <select aria-label="导入稿翻页方式" value={mode} disabled={busy || Boolean(editor)}
        onChange={event => {
          const next = event.currentTarget.value === 'scroll' ? 'scroll' : 'click';
          pendingPage.current = current;
          setMode(next); localStorage.setItem('draft-pdf-page-mode', next);
        }}><option value="click">点击翻页</option><option value="scroll">滑动翻页</option></select></label>}
      {total > 1 && <><button type="button" disabled={current <= 1 || busy || Boolean(editor)} onClick={() => changePage(current - 1)}>上一页</button>
        <label>导入稿页码 <input aria-label="导入稿页码" type="number" min={1} max={total} value={current} disabled={busy || Boolean(editor)}
          onChange={event => changePage(event.currentTarget.valueAsNumber)}/> / {total}</label>
        <button type="button" disabled={current >= total || busy || Boolean(editor)} onClick={() => changePage(current + 1)}>下一页</button></>}
      <button type="button" disabled={busy || Boolean(editor)} onClick={() => startEditor()}>添加教材页码跳转</button>
    </div>
    {editor && <form aria-label="教材页码跳转编辑" className="chapter-draft-controls chapter-draft-editor" onSubmit={event => {
      event.preventDefault();
      const {id, ...link} = editor;
      void commit(() => onSave(link, id));
    }}>
      <strong>导入稿第 {editor.anchor} 页</strong>
      <label>教材 PDF 页码 <input name="page" type="number" min="1" step="1" required value={editor.page || ''}
        onChange={event => setEditor({...editor, page: event.currentTarget.valueAsNumber || 0})}/></label>
      <label>按钮名称 <input name="label" maxLength={100} placeholder="可选" value={editor.label}
        onChange={event => setEditor({...editor, label: event.currentTarget.value})}/></label>
      {pdf && <button type="button" aria-pressed={placing} disabled={busy} onClick={() => {
        if (scrolling) scrollToPage(editor.anchor);
        setPlacing(!placing);
      }}>{placing ? '正在定位' : '在 PDF 上定位或调整大小'}</button>}
      <button type="submit" disabled={busy}>保存跳转</button>
      <button type="button" disabled={busy} onClick={closeEditor}>取消</button>
      {placing && <span role="status">在本页点击放置，或拖出矩形自定大小。</span>}
    </form>}
    {linkError && <p role="alert">{linkError}</p>}
    {links.length > 0 && <details className="chapter-draft-link-list" open={!pdf || links.some(link => !link.rect) ? true : undefined}>
      <summary>管理本页跳转（{links.length}）</summary>
      {links.map(link => <div className="chapter-draft-controls" key={link.id}>
        {pdf && link.rect ? <span>{draftLinkLabel(link)}</span> :
          <button type="button" onClick={() => onJump(link.page, draftLinkLabel(link))}>{draftLinkLabel(link)}</button>}
        <button type="button" disabled={busy || Boolean(editor)} onClick={() => startEditor(link.rect || !pdf ? link : {...link, rect: defaultDraftRect})}>编辑跳转</button>
        <button type="button" disabled={busy || Boolean(editor)} onClick={() => void commit(() => onDelete(link.id))}>删除跳转</button>
      </div>)}
    </details>}
    {scrolling ? <div className="chapter-draft-scroll" aria-label="滑动翻阅导入稿" ref={scroller} tabIndex={0}
      onScroll={event => {
        const root = event.currentTarget;
        if (!stage.current || !root.clientHeight) return;
        const point = root.getBoundingClientRect().top + root.clientHeight * .22;
        const next = Number(pageAtViewportY(stage.current, point, true)?.page.dataset.pageNumber);
        if (next && next !== current) setPage(next);
      }}><div className="chapter-draft-stage" ref={stage}>{Array.from({length: total}, (_, index) => renderSheet(index + 1))}</div></div>
      : pdf ? renderSheet(current) : html && <HtmlPage html={html.pages[current - 1]} styles={html.styles} word={format === 'docx'}/>}
  </>;
}
