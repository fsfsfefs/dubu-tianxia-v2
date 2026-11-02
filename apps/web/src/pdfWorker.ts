import {installAndroidCompatibility} from './androidCompatibility';
installAndroidCompatibility();
const implementation = await import('pdfjs-dist/build/pdf.worker.mjs');
export const WorkerMessageHandler = implementation.WorkerMessageHandler;
