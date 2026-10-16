import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';

const root = process.cwd();
const source = join(root, 'agent-package');
const target = join(root, 'plugins/amadeus');
const check = process.argv.includes('--check');
const definition = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (definition.schema !== 1 || definition.version !== version || definition.host !== 'codex') throw new Error('Canonical package identity or version mismatch');
const paths = definition.assets;
if (!Array.isArray(paths) || !paths.length || new Set(paths).size !== paths.length || paths.some(p => !/^(skills|scripts|hooks|\.codex-plugin)\/[\w./-]+$|^\.(mcp\.json)$|^(privacy-flows\.json|config\.example\.json)$/.test(p) || p.includes('..'))) throw new Error('Invalid canonical asset list');
const manifest = {};
for (const path of paths) {
  const input = join(source, path), output = join(target, path);
  if (!existsSync(input)) throw new Error('Missing canonical asset: ' + path);
  const bytes = readFileSync(input);
  // Git may check text assets out with CRLF on Windows. Hash their canonical
  // LF form so a fresh checkout does not invalidate the committed manifest.
  manifest[path] = createHash('sha256').update(bytes.toString('utf8').replaceAll('\r\n', '\n')).digest('hex');
  if (check) {
    if (!existsSync(output) || !bytes.equals(readFileSync(output))) throw new Error('Stale Codex wrapper: ' + path);
  } else {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, bytes);
  }
}
const plugin = JSON.parse(readFileSync(join(source, '.codex-plugin/plugin.json'), 'utf8'));
if (plugin.version !== version || plugin.mcpServers !== './.mcp.json' || plugin.skills !== './skills/') throw new Error('Codex wrapper contract mismatch');
const mcp = JSON.parse(readFileSync(join(source, '.mcp.json'), 'utf8'));
if (mcp.mcpServers?.amadeus?.command !== 'node' || mcp.mcpServers.amadeus.args?.[0] !== './scripts/server.mjs') throw new Error('Unsupported MCP entrypoint');
const hooks = JSON.parse(readFileSync(join(source, 'hooks/hooks.json'), 'utf8'));
if (hooks.hooks?.SessionStart?.[0]?.hooks?.[0]?.command !== 'node "${PLUGIN_ROOT}/hooks/session-start.mjs"') throw new Error('Unsupported startup hook');
const expected = new Set(paths);
for (const entry of readdirSync(source, { recursive: true, withFileTypes: true }).filter(e => e.isFile())) {
  const path = relative(source, join(entry.parentPath, entry.name)).replaceAll('\\', '/');
  if (path !== 'package.json' && !expected.has(path)) throw new Error('Undeclared canonical asset: ' + path);
}
for (const entry of readdirSync(target, { recursive: true, withFileTypes: true }).filter(e => e.isFile())) {
  const path = relative(target, join(entry.parentPath, entry.name)).replaceAll('\\', '/');
  if (!path.startsWith('runtime/') && !path.startsWith('scripts/') && path !== 'agent-package-manifest.json' && !expected.has(path)) throw new Error('Undeclared Codex wrapper asset: ' + path);
}
const manifestText = JSON.stringify({ version, assets: manifest }, null, 2) + '\n';
const manifestPath = join(target, 'agent-package-manifest.json');
if (check) {
  if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8').replaceAll('\r\n', '\n') !== manifestText) throw new Error('Stale agent package manifest');
} else writeFileSync(manifestPath, manifestText);
console.log(`${check ? 'Verified' : 'Generated'} ${paths.length} canonical assets for Codex ${version}.`);
