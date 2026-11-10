import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const root = 'packages/server/src/proxy';
const core = 'packages/server/src/core/db.ts';
const files = readdirSync(root).filter((name) => name.endsWith('.ts')).map((name) => join(root, name));
const names = [];

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let changed = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.startsWith('function ') && !line.startsWith('export function ') && !line.startsWith('async function ')) continue;
    if (!line.includes('db: Db')) continue;
    const match = /^(export )?(async )?function (\w+)\((db: Db, |db: Db\))/.exec(line);
    if (!match) continue;
    names.push(match[3]);
    lines[index] = line.replace('(db: Db, ', '(').replace('(db: Db)', '()');
    lines.splice(index + 1, 0, '  const db = get();');
    changed = true;
    index++;
  }
  if (!changed) continue;
  const rel = relative(dirname(file), core).replaceAll('\\', '/');
  const specifier = rel.startsWith('.') ? rel : `./${rel}`;
  if (!lines.some((line) => /^import\s*\{[^}]*\bget\b[^}]*\}\s*from\s*'[^']*\/db\.ts';?$/.test(line))) {
    let insert = 0;
    for (let index = 0; index < lines.length; index++) if (lines[index].startsWith('import ')) insert = index + 1;
    lines.splice(insert, 0, `import { get } from '${specifier}';`);
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
