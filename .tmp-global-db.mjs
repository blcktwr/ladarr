import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const root = 'packages/server/src';
const core = join(root, 'core/db.ts');
const types = new Set(['Settings', 'LedgerEntry', 'MediaFile', 'Root', 'Data', 'Db']);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });
}

for (const file of walk(root)) {
  if (file === core) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  let text = lines.join('\n');
  if (!text.includes('const db = get();') && !lines.some((line) => /from '[^']*(?:^|\/)db\.ts';?$/.test(line))) continue;
  text = text.replace(/^\s*const db = get\(\);\n/gm, '');
  const needsGet = /\bget\(\)/.test(text);
  const rel = relative(dirname(file), core).replaceAll('\\', '/');
  const specifier = rel.startsWith('.') ? rel : `./${rel}`;
  const indexes = [];
  const names = new Set();
  let source;
  const nextLines = text.split('\n');
  for (let index = 0; index < nextLines.length; index++) {
    const line = nextLines[index];
    if (!line.startsWith('import ')) continue;
    const match = /^(import\s+(?:type\s+)?\{)([^}]*)(\}\s+from\s+'([^']*)';?)$/.exec(line);
    if (!match) continue;
    if (!/(?:^|\/)db\.ts$/.test(match[4])) continue;
    indexes.push(index);
    source = match[4];
    for (const raw of match[2].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '');
      if (name) names.add(name);
    }
  }
  names.add('db');
  if (needsGet) names.add('get');
  if (!needsGet) names.delete('get');
  const specifiers = [...names].sort().map((name) => (types.has(name) ? `type ${name}` : name));
  const importLine = `import { ${specifiers.join(', ')} } from '${source ?? specifier}';`;
  if (indexes.length) {
    for (const index of [...indexes].sort((a, b) => b - a)) nextLines.splice(index, 1);
    nextLines.splice(indexes[0], 0, importLine);
  } else {
    let insert = 0;
    for (let index = 0; index < nextLines.length; index++) if (nextLines[index].startsWith('import ')) insert = index + 1;
    nextLines.splice(insert, 0, importLine);
  }
  writeFileSync(file, nextLines.join('\n'));
}
