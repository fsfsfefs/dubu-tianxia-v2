import {useEffect, useRef, useState} from 'react';
import {getDocument, GlobalWorkerOptions, type PDFDocumentProxy} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
GlobalWorkerOptions.workerSrc = workerUrl;
export default function OutlinePreview({documentId, page}: {documentId: string; page: number}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error,setError] = useState('');
  useEffect(()=>{
    let alive=true;setError('');setPdf(null);
    const task=getDocument({url:`/api/documents/${documentId}/file`});
    void task.promise.then(value=>{if(alive)setPdf(value);}).catch(()=>{if(alive)setError('原文预览加载失败');});
    return ()=>{alive=false;void task.destroy();};
  },[documentId]);
  useEffect(()=>{
    if(!pdf || !canvas.current)return;
    const element=canvas.current;
    let alive=true;
    let rendering: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    void pdf.getPage(Math.max(1,Math.min(pdf.numPages,page))).then(async source=>{
      if(!alive)return;
      const viewport=source.getViewport({scale:1});
      const scale=Math.min(1.6,Math.max(240,(element.parentElement?.clientWidth || 600)-24)/viewport.width);
      const fitted=source.getViewport({scale});
      element.width=Math.ceil(fitted.width);element.height=Math.ceil(fitted.height);
      const context=element.getContext('2d');
      if(context){rendering=source.render({canvas:element,canvasContext:context,viewport:fitted});await rendering.promise;}
    }).catch(reason=>{if(alive && reason?.name!=='RenderingCancelledException')setError('该页预览失败');});
    return ()=>{alive=false;rendering?.cancel();};
  },[pdf,page]);
  return <>{error && <p role="alert">{error}</p>}<canvas ref={canvas} aria-label={`原文PDF第${page}页预览`}/></>;
}
