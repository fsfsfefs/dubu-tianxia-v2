import {defineConfig, loadEnv, searchForWorkspaceRoot} from 'vite';
import react from '@vitejs/plugin-react';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', 'VITE_');
  return {
    plugins: [react()],
    resolve: {alias: mode === 'android' ? [
      {find: /^pdfjs-dist$/, replacement: 'pdfjs-dist/legacy/build/pdf.mjs'},
      {find: /^pdfjs-dist\/build\/pdf.worker.min.mjs\?url$/, replacement: fileURLToPath(new URL('./src/androidPdfWorker.ts', import.meta.url)) + '?worker&url'},
    ] : []},
    build: {manifest: true},
    worker: {format: 'es'},
    server: {
      port: 5174,
      fs: {allow: [searchForWorkspaceRoot(process.cwd()), fileURLToPath(new URL('../../docs', import.meta.url))]},
      proxy: {'/api': process.env.VITE_API_TARGET || env.VITE_API_TARGET || 'http://127.0.0.1:8790'},
    },
  };
});
