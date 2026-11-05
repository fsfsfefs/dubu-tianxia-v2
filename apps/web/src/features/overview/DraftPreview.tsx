import {useEffect, useRef, useState} from 'react';
import {getDocument, GlobalWorkerOptions, type PDFDocumentProxy} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {draftFile, type ChapterDraft, type DraftLink} from './chapterDrafts';

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

function PdfPage({pdf, number}: {pdf: PDFDocumentProxy; number: number}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    let render: ReturnType<Awaited<ReturnType<typeof pdf.getPage>>['render']> | undefined;
    void pdf.getPage(number).then(page => {
      if (!live || !canvas.current) return;
      const base = page.getViewport({scale: 1});
      const viewport = page.getViewport({scale: Math.min(2, 2200 / Math.max(base.width, base.height))});
      canvas.current.width = Math.ceil(viewport.width);
      canvas.current.height = Math.ceil(viewport.height);
      render = page.render({canvas: canvas.current, viewport});
      return render.promise;
    }).catch(reason => {if (live) setError(reason instanceof Error ? reason.message : '无法预览此页。');});
    return () => {live = false; render?.cancel();};
  }, [pdf, number]);
  return error ? <p role="alert">{error}</p> : <canvas ref={canvas} aria-label={`导入稿第 ${number} 页`}/>;
}

export default function DraftPreview({draft, page, setPage, onJump, onAdd}: {
  draft: ChapterDraft; page: number; setPage: (page: number) => void; onJump: (page: number, label: string) => void; onAdd: (link: DraftLink) => Promise<unknown>;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [html, setHtml] = useState<HtmlPreview>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [linkError, setLinkError] = useState('');
  const file = draftFile(draft);
  const format = draft.format;
  useEffect(() => {
    const controller = new AbortController();
    const fail = (reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '导入稿无法预览。');
    };
    if (format === 'pdf') {
      const task = getDocument({url: file});
      void task.promise.then(document => {if (!controller.signal.aborted) setPdf(document);}).catch(fail);
      return () => {controller.abort(); void task.destroy();};
    }
    void fetch(file, {signal: controller.signal}).then(response => {
      if (!response.ok) throw new Error('无法读取导入稿。');
      return readHtml(format, response);
    }).then(preview => {if (!controller.signal.aborted) setHtml(preview);}).catch(fail);
    return () => controller.abort();
  }, [file, format]);
  if (error) return <p role="alert">无法预览导入稿。{error}</p>;
  if (!pdf && !html) return <p role="status">正在读取导入稿…</p>;
  const total = pdf?.numPages ?? html?.pages.length ?? 1;
  const links = draft.links.filter(link => link.anchor === page);
  return <>
    <div className="chapter-draft-controls">
      {total > 1 && <><button type="button" disabled={page <= 1 || busy} onClick={() => setPage(page - 1)}>上一页</button>
        <label>导入稿页码 <input aria-label="导入稿页码" type="number" min={1} max={total} value={page} disabled={busy}
          onChange={event => {const value = event.currentTarget.valueAsNumber; if (Number.isInteger(value) && value >= 1 && value <= total) setPage(value);}}/> / {total}</label>
        <button type="button" disabled={page >= total || busy} onClick={() => setPage(page + 1)}>下一页</button></>}
      <button type="button" onClick={() => {setEditing(!editing); setLinkError('');}}>添加教材页码跳转</button>
    </div>
    {editing && <form className="chapter-draft-controls" key={page} onSubmit={async event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      setBusy(true); setLinkError('');
      try {
        await onAdd({anchor: page, page: Number(form.get('page')), label: String(form.get('label') || '').trim()});
        setEditing(false);
      } catch (reason) {setLinkError(reason instanceof Error ? reason.message : '保存跳转失败。');}
      finally {setBusy(false);}
    }}><label>教材 PDF 页码 <input name="page" type="number" min="1" step="1" required/></label>
      <label>按钮名称 <input name="label" maxLength={100} placeholder="可选"/></label>
      <button disabled={busy}>保存跳转</button>{linkError && <span role="alert">{linkError}</span>}</form>}
    {links.length > 0 && <div className="chapter-draft-controls" aria-label="本页的教材跳转">{links.map((link, index) => {
      const title = `教材 PDF 第 ${link.page} 页`;
      return <button type="button" key={index} title={title} onClick={() => onJump(link.page, link.label || title)}>{link.label || title}</button>;
    })}</div>}
    {pdf ? <PdfPage key={page} pdf={pdf} number={page}/> : html && <HtmlPage html={html.pages[page - 1]} styles={html.styles} word={format === 'docx'}/>}
  </>;
}
