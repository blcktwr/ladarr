import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const root = 'packages/server/src';
const core = join(root, 'core/db.ts');
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith('.ts')) files.push(path);
  }
}
walk(root);
const names = new Set();

for (const file of files) {
  if (file === core) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  let changed = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.includes('(db: Db, ') && !line.includes('(db: Db)')) continue;
    const name =
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)/.exec(line)?.[1] ??
      /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/.exec(line)?.[1];
    if (!name) continue;
    names.add(name);
    lines[index] = line.replace('(db: Db, ', '(').replace('(db: Db)', '()');
    changed = true;
  }
  if (!changed) continue;
  const rel = relative(dirname(file), core).replaceAll('\\', '/');
  const specifier = rel.startsWith('.') ? rel : `./${rel}`;
  if (!lines.some((line) => /^import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*'[^']*\/db\.ts';?$/.test(line))) {
    let insert = 0;
    for (let index = 0; index < lines.length; index++) if (lines[index].startsWith('import ')) insert = index + 1;
    lines.splice(insert, 0, `import { db } from '${specifier}';`);
  }
  writeFileSync(file, lines.join('\n'));
}

for (const file of files) {
  let text = readFileSync(file, 'utf8');
  for (const name of names) {
    text = text.replaceAll(`${name}(db, `, `${name}(`);
    text = text.replaceAll(`${name}(db)`, `${name}()`);
  }
  writeFileSync(file, text);
}
console.log([...names].join(', '));
