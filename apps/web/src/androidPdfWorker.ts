import {installAndroidCompatibility} from './androidCompatibility';
installAndroidCompatibility();
// Keep PDF.js's worker module contract, including its main-thread fallback.
// Top-level await also forwards import failures as worker errors rather than
// leaving the parent waiting forever on a discarded import promise.
const implementation = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
export const WorkerMessageHandler = implementation.WorkerMessageHandler;
