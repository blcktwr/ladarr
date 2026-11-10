import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const root = 'packages/server/src';
const core = join(root, 'core/db.ts');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });
}

for (const file of walk(root)) {
  if (file === core) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  const text = lines.join('\n');
  const needsGet = /\bget\(\)/.test(text);
  const rel = relative(dirname(file), core).replaceAll('\\', '/');
  const specifier = rel.startsWith('.') ? rel : `./${rel}`;
  let found = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.startsWith('import ')) continue;
    const match = /^(import\s+(?:type\s+)?\{)([^}]*)(\}\s+from\s+'([^']*core\/db\.ts)';?)$/.exec(line);
    if (!match) continue;
    found = true;
    const names = match[2]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    const hasDb = names.includes('db');
    const hasGet = names.includes('get');
    if (hasDb && (!needsGet || hasGet)) continue;
    if (!hasDb) names.unshift('db');
    if (needsGet && !hasGet) names.push('get');
    if (!needsGet && hasGet) names.splice(names.indexOf('get'), 1);
    lines[index] = `${match[1]} ${names.join(', ')} ${match[3]}`;
  }
  if (!found) {
    let insert = 0;
    for (let index = 0; index < lines.length; index++) if (lines[index].startsWith('import ')) insert = index + 1;
    lines.splice(insert, 0, `import { db } from '${specifier}';`);
  }
  writeFileSync(file, lines.join('\n'));
}
