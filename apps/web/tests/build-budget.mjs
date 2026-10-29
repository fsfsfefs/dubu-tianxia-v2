import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import path from 'node:path';

const manifest = JSON.parse(readFileSync('dist/.vite/manifest.json', 'utf8'));
const initial = new Set();
function visit(key) {
  if (initial.has(key)) return;
  assert.ok(manifest[key], `Missing manifest entry ${key}`);
  initial.add(key);
  for (const imported of manifest[key].imports || []) visit(imported);
}
visit('index.html');
for (const feature of ['src/features/guide/GuideEntry.tsx', 'src/PdfReader.tsx', 'src/pdfOutline.ts', 'src/ragIndex.ts', 'src/chapterSummary.ts']) {
  assert.ok(manifest[feature]?.isDynamicEntry, `${feature} must remain independently loadable`);
  assert.ok(!initial.has(feature), `${feature} must not be loaded by the home page`);
}
assert.ok(![...initial].some(key => /pdf|ocr/i.test(manifest[key].name || key)), 'PDF/OCR must stay outside the initial JS graph');
const bytes = [...initial].reduce((total, key) => total + statSync(path.join('dist', manifest[key].file)).size, 0);
assert.ok(bytes <= 400_000, `Initial JavaScript is ${bytes} bytes, above the 400 kB budget`);
console.log(`Initial JavaScript: ${(bytes / 1000).toFixed(2)} kB; PDF/OCR lazy-loading and size budget passed.`);
