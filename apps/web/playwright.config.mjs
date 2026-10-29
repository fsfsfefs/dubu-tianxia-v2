import {defineConfig} from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
const root=path.resolve('../..');
const temp=path.join(root,'.tmp','playwright-temp');fs.mkdirSync(temp,{recursive:true});
process.env.TEMP=temp;process.env.TMP=temp;
const localPython=path.join(root,'apps/api/.venv/Scripts/python.exe');
const python=fs.existsSync(localPython)?`"${localPython}"`:'python';
export default defineConfig({
  testDir:'./tests/e2e',outputDir:'./.tmp/e2e-results',workers:1,fullyParallel:false,
  timeout:120000,expect:{timeout:30000},reporter:'list',
  use:{baseURL:'http://127.0.0.1:5175',viewport:{width:1440,height:1000},screenshot:'only-on-failure',trace:'retain-on-failure'},
  projects:[{name:'mouse',use:{browserName:'chromium',channel:process.env.READER_E2E_CHANNEL||'msedge'}},{name:'touch',use:{browserName:'chromium',channel:process.env.READER_E2E_CHANNEL||'msedge',hasTouch:true}}],
  webServer:[
    {command:`${python} tests/e2e/serve.py`,url:'http://127.0.0.1:8791/api/health',reuseExistingServer:false,timeout:45000,
     env:{READER_E2E_DATA:path.join(root,'.tmp',`e2e-${Date.now()}`)}},
    {command:'npm run dev -- --port 5175 --strictPort',url:'http://127.0.0.1:5175',reuseExistingServer:false,timeout:45000,
     env:{VITE_API_TARGET:'http://127.0.0.1:8791'}},
  ],
});
