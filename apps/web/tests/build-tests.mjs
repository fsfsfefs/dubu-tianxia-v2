// Compile the actual production modules, then resolve their relative imports for Node.
import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync, readdirSync, existsSync} from 'node:fs';
import path from 'node:path';
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.tests.json'], {stdio:'inherit'});
if (result.status !== 0) process.exit(result.status || 1);
function visit(folder) {
  for (const entry of readdirSync(folder,{withFileTypes:true})) {
    const file=path.join(folder,entry.name);
    if (entry.isDirectory()) {visit(file);continue;}
    if (!file.endsWith('.js')) continue;
    const code=readFileSync(file,'utf8').replace(/from ['"]([.][^'"]+)['"]/g,(all,relative)=>existsSync(path.resolve(path.dirname(file),relative+'.js'))?`from '${relative}.js'`:all);
    writeFileSync(file,code);
  }
}
visit('.tmp/tests');
