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
  const indexes = [];
  const names = new Set();
  let source;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.startsWith('import ')) continue;
    const match = /^(import\s+(?:type\s+)?\{)([^}]*)(\}\s+from\s+'([^']*db\.ts)';?)$/.exec(line);
    if (!match) continue;
    indexes.push(index);
    source = match[4];
    for (const raw of match[2].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '');
      if (name) names.add(name);
    }
  }
  if (!indexes.length) continue;
  const specifiers = [...names].sort().map((name) => (types.has(name) ? `type ${name}` : name));
  const importLine = `import { ${specifiers.join(', ')} } from '${source}';`;
  const first = indexes[0];
  for (const index of [...indexes].sort((a, b) => b - a)) lines.splice(index, 1);
  lines.splice(first, 0, importLine);
  writeFileSync(file, lines.join('\n'));
}
