import { readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'plugins/amadeus/runtime');
const check = process.argv.includes('--check');
const files = ['package.json', ...['src', 'config-templates'].flatMap(dir =>
  readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter(e => e.isFile()).map(e => join(e.parentPath, e.name).slice(root.length + 1)))];
const manifest = {};
for (const file of files) {
  const content = readFileSync(join(root, file), 'utf8').replaceAll('\r\n', '\n').trimEnd() + '\n';
  const dest = join(target, file);
  manifest[file.replaceAll('\\', '/')] = createHash('sha256').update(content).digest('hex');
  if (check) {
    if (readFileSync(dest, 'utf8').replaceAll('\r\n', '\n') !== content) throw new Error('Stale packaged runtime: ' + file);
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
}
const manifestText = JSON.stringify(manifest, null, 2) + '\n';
if (check) {
  if (readFileSync(join(target, 'manifest.json'), 'utf8').replaceAll('\r\n', '\n') !== manifestText) throw new Error('Stale runtime manifest');
  const expected = new Set([...files.map(file => file.replaceAll('\\', '/')), 'manifest.json']);
  for (const entry of readdirSync(target, { recursive: true, withFileTypes: true }).filter(e => e.isFile())) {
    const relative = join(entry.parentPath, entry.name).slice(target.length + 1).replaceAll('\\', '/');
    if (!expected.has(relative)) throw new Error('Unexpected packaged runtime file: ' + relative);
  }
} else {
  writeFileSync(join(target, 'manifest.json'), manifestText);
  // Remove packaged copies of files that no longer exist in the source tree.
  const expected = new Set([...files.map(file => file.replaceAll('\\', '/')), 'manifest.json']);
  for (const entry of readdirSync(target, { recursive: true, withFileTypes: true }).filter(e => e.isFile())) {
    const relative = join(entry.parentPath, entry.name).slice(target.length + 1).replaceAll('\\', '/');
    if (!expected.has(relative)) rmSync(join(entry.parentPath, entry.name));
  }
}
console.log((check ? 'Verified ' : 'Packaged ') + files.length + ' runtime files.');
