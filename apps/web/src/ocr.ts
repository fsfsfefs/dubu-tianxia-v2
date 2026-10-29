import {createWorker, OEM} from 'tesseract.js';

export type OcrWord = {
  text: string;
  confidence: number;
  bbox: {x0: number; y0: number; x1: number; y1: number};
};

type ProgressHandler = (progress: number, status: string) => void;

let activeProgressHandler: ProgressHandler | null = null;
let workerPromise: ReturnType<typeof createWorker> | null = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker(['chi_sim', 'eng'], OEM.LSTM_ONLY, {
      workerPath: '/api/ocr/assets/worker.min.js',
      corePath: '/api/ocr/assets/core',
      langPath: '/api/ocr/assets/lang',
      logger: message => activeProgressHandler?.(message.progress, message.status),
    });
  }
  return workerPromise;
}

export async function recognizeCanvas(canvas: HTMLCanvasElement, onProgress: ProgressHandler): Promise<OcrWord[]> {
  const snapshot = document.createElement('canvas');
  snapshot.width = canvas.width;
  snapshot.height = canvas.height;
  snapshot.getContext('2d')?.drawImage(canvas, 0, 0);

  activeProgressHandler = onProgress;
  try {
    const worker = await getWorker();
    const result = await worker.recognize(snapshot, {}, {blocks: true, text: true});
    return (result.data.blocks || []).flatMap(block =>
      block.paragraphs.flatMap(paragraph =>
        paragraph.lines.flatMap(line => line.words)
      )
    ).filter(word => word.text.trim() && word.confidence >= 15)
      .map(word => ({text: word.text, confidence: word.confidence, bbox: word.bbox}));
  } catch (error) {
    workerPromise = null;
    throw new Error(`OCR 识别失败：${error instanceof Error ? error.message : '识别服务初始化失败'}`);
  } finally {
    activeProgressHandler = null;
  }
}
