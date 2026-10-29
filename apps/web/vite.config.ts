import {defineConfig, loadEnv} from 'vite';
import react from '@vitejs/plugin-react';
import process from 'node:process';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', 'VITE_');
  return {
    plugins: [react()],
    server: {
      port: 5174,
      proxy: {'/api': process.env.VITE_API_TARGET || env.VITE_API_TARGET || 'http://127.0.0.1:8790'},
    },
  };
});
