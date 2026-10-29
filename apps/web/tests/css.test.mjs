import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import postcss from 'postcss';
import {cascadeDigest} from './css-cascade.mjs';
test('component scopes preserve the original declaration cascade',()=>{
 const files=[...fs.readFileSync('src/App.tsx','utf8').matchAll(/import '(\.\/[^']+\.css)'/g)].map(m=>m[1].slice(2));
 const expected=JSON.parse(fs.readFileSync('tests/fixtures/css-cascade.json','utf8'));
 const sheets=files.map(file=>fs.readFileSync('src/'+file,'utf8'));
 assert.equal(cascadeDigest(sheets),expected.sha256);
 assert.equal(cascadeDigest(sheets.map(css=>css.replace(/\r?\n/g,'\r\n'))),expected.sha256);
 for(const file of ['features/tasks/TaskCenter.css','features/settings/EmbeddingSettings.css','features/overview/StructureImport.css']){
  const tree=postcss.parse(fs.readFileSync('src/'+file,'utf8'));
  tree.walkRules(rule=>assert.ok(rule.selectors.every(s=>s.startsWith(':where([data-feature="')),`Unscoped selector in ${file}`));
 }
});
