import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { extname, join } from 'node:path';

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (extname(entry.name) === '.js') files.push(path);
  }
  return files;
}

function check(path) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', path], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Syntax check failed: ${path}`)));
  });
}

const files = [...await collect('src'), ...await collect('scripts')]
  .filter((path) => path !== 'scripts/check-syntax.js')
  .sort();
for (const file of files) await check(file);
console.log(`Syntax checked ${files.length + 1} JavaScript files.`);
